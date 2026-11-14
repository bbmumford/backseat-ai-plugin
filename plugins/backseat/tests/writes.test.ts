import { expect, mock, test } from 'claude-code/testing'

import {
  appearedIn,
  changedPaths,
  isEphemeral,
  pythonWriteTargets,
  shellTokens,
  unifiedDiff,
  withoutHeredocs,
  writeTargetsOf,
} from '../hooks/writes'

import { FAILURES_BEFORE_WAIT } from '../hooks/providers'

const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

const CLEAN = JSON.stringify({ verdict: 'clean', findings: [] })

test('a redirect, a pipe into a file and an appending write are all writes', () => {
  expect(writeTargetsOf('echo hi > notes/out.txt')).toEqual(['notes/out.txt'])
  expect(writeTargetsOf('printf x >> log.txt')).toEqual(['log.txt'])
  expect(writeTargetsOf('cat a | tee -a b.txt')).toEqual(['b.txt'])
  expect(writeTargetsOf('gcc -o build/app main.c')).toEqual(['build/app'])
  expect(writeTargetsOf('curl -s u --output=d/f.json')).toEqual(['d/f.json'])
})

test('a silenced command and a duplicated descriptor name no file', () => {
  expect(writeTargetsOf('make 2>&1 >/dev/null')).toEqual([])
  expect(writeTargetsOf('run >&2')).toEqual([])
  expect(writeTargetsOf('ls -la')).toEqual([])
})

test('an in-place edit and a copy name the file they rewrite', () => {
  expect(writeTargetsOf("sed -i '' -e s/a/b/ src/thing.py")).toEqual([
    'src/thing.py',
  ])
  expect(writeTargetsOf('cp a.txt b.txt')).toEqual(['b.txt'])
  expect(writeTargetsOf('mv old/x.py new/x.py')).toEqual(['new/x.py'])
  // One argument is a copy of nothing, so it is not read as a write to it.
  expect(writeTargetsOf('cp a.txt')).toEqual([])
})

test('a quoted path with a space in it stays one path', () => {
  expect(shellTokens('echo a "two words" b')).toEqual([
    'echo',
    'a',
    'two words',
    'b',
  ])
  expect(writeTargetsOf('echo x > "my notes.txt"')).toEqual(['my notes.txt'])
})

test('a here-document body is read for what it opens, not for its operators', () => {
  const command = [
    "python3 - <<'PY'",
    'if 3 > 2:',
    "    open('out/result.json', 'w').write(data)",
    "    open('read/only.txt', 'r').read()",
    'PY',
  ].join('\n')

  const lifted = withoutHeredocs(command)

  expect(lifted.bodies.length).toBe(1)
  // `3 > 2` is a comparison in the body, never a redirect into a file named 2.
  expect(writeTargetsOf(command)).toEqual(['out/result.json'])
  expect(pythonWriteTargets("open('a.txt','a')")).toEqual(['a.txt'])
  expect(pythonWriteTargets("open('a.txt','r')")).toEqual([])
})

test('a path whose length or modified time moved is a path that was written', () => {
  const before = new Map([
    [
      '/w/same.txt',
      { exists: true, size: 10, mtimeMs: 1, text: 'x', isWhole: true },
    ],
    [
      '/w/grew.txt',
      { exists: true, size: 10, mtimeMs: 1, text: 'x', isWhole: true },
    ],
    [
      '/w/touched.txt',
      { exists: true, size: 10, mtimeMs: 1, text: 'x', isWhole: true },
    ],
    [
      '/w/made.txt',
      { exists: false, size: 0, mtimeMs: 0, text: '', isWhole: true },
    ],
  ])
  const after = new Map([
    ['/w/same.txt', { exists: true, size: 10, mtimeMs: 1 }],
    ['/w/grew.txt', { exists: true, size: 99, mtimeMs: 1 }],
    ['/w/touched.txt', { exists: true, size: 10, mtimeMs: 2 }],
    ['/w/made.txt', { exists: true, size: 5, mtimeMs: 3 }],
  ])

  expect(changedPaths(before, after)).toEqual([
    '/w/grew.txt',
    '/w/touched.txt',
    '/w/made.txt',
  ])
})

test('a file a command never named is found by what the directory gained', () => {
  const before = new Map([['/w/out', ['kept.txt']]])
  const after = new Map([['/w/out', ['kept.txt', 'run-7.json']]])

  expect(appearedIn(before, after)).toEqual(['/w/out/run-7.json'])
  expect(appearedIn(before, before)).toEqual([])
})

test('a file no repository holds is still diffed against its before-image', () => {
  const diff = unifiedDiff('notes/out.txt', 'one\ntwo\nthree\n', 'one\n2\nthree\n')

  expect(diff).toContain('--- a/notes/out.txt')
  expect(diff).toContain('+++ b/notes/out.txt')
  expect(diff).toContain('-two')
  expect(diff).toContain('+2')
  // The unchanged first and last lines are outside the hunk.
  expect(diff).not.toContain('-one')
  expect(diff).not.toContain('-three')
})

test('a file that did not exist reads as new, and an unchanged one as nothing', () => {
  expect(unifiedDiff('a.txt', '', 'hello\n')).toContain('new file mode')
  expect(unifiedDiff('a.txt', 'same\n', 'same\n')).toBe('')
})

test('a turn that wrote through the shell outside any repository is reviewed', async ($, on) => {
  let settled: () => void = () => undefined
  const stored = new Promise<void>(resolve => {
    settled = resolve
  })
  const prompts: string[] = []
  const stats = new Map<string, number>()

  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-writes' }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('fs.list', () => ({ value: [] }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('store.get', () => ({ value: [] }))
  on('store.set', () => {
    settled()

    return { value: undefined }
  })
  on('fs.exists', () => ({ value: false }))

  // The second look at a path is the one after the command ran, so its
  // modified time has moved: this is what the watch compares.
  on('fs.stat', ($$, e) => {
    const seen = (stats.get(e.path) ?? 0) + 1

    stats.set(e.path, seen)

    return {
      value: { kind: 'file', size: 10 * seen, mtimeMs: seen, isLink: false },
    }
  })
  on('fs.read', ($$, e) => ({
    value: (stats.get(e.path) ?? 0) > 1 ? 'one\n2\nthree\n' : 'one\ntwo\nthree\n',
  }))

  // No repository holds the tree, which is the case a repository diff cannot
  // answer: `rev-parse` fails, so the review has only the before-image.
  on('process.run', () => ({
    value: {
      exitCode: 1,
      stdout: '',
      stderr: 'not a git repository',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  // The checked-in engine types describe only the `as: "api"` form of a
  // message, so the shape `activityOf` reads is cast rather than declared.
  const said = [
    { role: 'user', text: 'write the notes' },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        {
          tool: 'Bash',
          tool_use_id: 'u1',
          input: { command: 'echo 2 > notes/out.txt' },
        },
      ],
    },
  ] as unknown as never

  on('session.messages', () => ({ value: said }))
  on('model.complete', ($$, e) => {
    prompts.push(e.prompt)

    return { value: { isAnswered: true, text: CLEAN, usage: USAGE } }
  })
  on('ui.render', () => ({
    type: 'Text',
    props: {},
    children: ['drawn by Claude Code'],
  }))

  await $.session.start({
    surface: 'terminal',
    isInteractive: true,
    cwd: '/work',
  })
  await $.tool.call({
    tool: 'Bash',
    tool_use_id: 'u1',
    command: 'echo 2 > notes/out.txt',
  })
  await $.turn.complete({
    turnId: 't1',
    answer: 'Wrote the notes',
    durationMs: 10,
    isAborted: false,
    usage: undefined,
    reason: 'answer',
  })

  await stored

  // A lane was asked at all, which is the whole of the gap: an edit-tool-only
  // watch records nothing here, and the review is abandoned before this.
  expect(prompts.length).toBeGreaterThan(0)
  expect(prompts[0]).toContain('notes/out.txt')
  expect(prompts[0]).toContain('+2')
  // The commands the turn ran reach the lane as well as the diff.
  expect(prompts[0]).toContain('<what_the_turn_ran>')
  expect(prompts[0]).toContain('echo 2 > notes/out.txt')
  // And the lane is told nothing can commit the file, so it does not report
  // on committing one that no repository holds.
  expect(prompts[0]).toContain('<files_no_repository_holds>')
  expect(prompts[0]).toContain('Nothing can commit them')
})

test(
  'a turn still reaches the lanes when refinement is on',
  { options: { refine: 'on', refineAtPercent: 75 } },
  async ($, on) => {
    let settled: () => void = () => undefined
    const asked = new Promise<void>(resolve => {
      settled = resolve
    })
    const prompts: string[] = []

    on('command.register', () => ({ value: { command: 'backseat' } }))
    on('session.id', () => ({ value: 'session-refine-dispatch' }))
    on('ui.log', () => ({ value: undefined }))
    on('session.start', () => ({ cwd: '/work' }))
    on('fs.list', () => ({ value: [] }))
    on('turn.complete', () => ({ text: '' }))
    on('tool.call', () => ({ result: 'ok' }))
    on('store.get', () => ({ value: [] }))
    on('store.set', () => ({ value: undefined }))
    on('fs.exists', () => ({ value: false }))
    // The engine answers a scheduled call with a timer, which is not a
    // promise. A turn that treated it as one threw here, and the review below
    // was never reached: the watcher went on reporting and no lane was asked.
    on('clock.after', () => ({ value: undefined }))
    on('process.run', ($$, e) => ({
      value: {
        exitCode: 0,
        stdout: (e.argv ?? []).includes('rev-parse')
          ? '/work'
          : 'diff --git a/src/thing.ts b/src/thing.ts\n+ added',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }))
    on('model.complete', ($$, e) => {
      prompts.push(e.prompt)
      settled()

      return { value: { isAnswered: true, text: CLEAN, usage: USAGE } }
    })
    on('ui.render', () => ({
      type: 'Text',
      props: {},
      children: ['drawn by Claude Code'],
    }))

    await $.session.start({
      surface: 'terminal',
      isInteractive: true,
      cwd: '/work',
    })
    await $.tool.call({
      tool: 'Edit',
      file_path: 'src/thing.ts',
      old_string: 'was',
      new_string: 'is',
    })
    await $.turn.complete({
      turnId: 't1',
      answer: 'Edited src/thing.ts',
      durationMs: 10,
      isAborted: false,
      usage: undefined,
      reason: 'answer',
    })

    await asked

    expect(prompts.length).toBeGreaterThan(0)
  },
)

test('a tool result does not end the turn the activity is read from', async ($, on) => {
  let settled: () => void = () => undefined
  const asked = new Promise<void>(resolve => {
    settled = resolve
  })
  const prompts: string[] = []
  const stats = new Map<string, number>()

  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-activity-boundary' }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('fs.list', () => ({ value: [] }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('store.get', () => ({ value: [] }))
  on('store.set', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', ($$, e) => {
    const seen = (stats.get(e.path) ?? 0) + 1

    stats.set(e.path, seen)

    return {
      value: { kind: 'file', size: 10 * seen, mtimeMs: seen, isLink: false },
    }
  })
  on('fs.read', ($$, e) => ({
    value: (stats.get(e.path) ?? 0) > 1 ? 'one\n2\nthree\n' : 'one\ntwo\nthree\n',
  }))
  on('process.run', () => ({
    value: {
      exitCode: 1,
      stdout: '',
      stderr: 'not a git repository',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  // The engine carries a tool's result in the person's own role. A boundary
  // taken at the newest message in that role falls after every command of the
  // turn, which left the activity empty and the section unsent.
  const said = [
    { role: 'user', text: 'write the notes' },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        {
          tool: 'Bash',
          tool_use_id: 'u1',
          input: { command: 'echo 2 > notes/out.txt' },
        },
      ],
    },
    {
      role: 'user',
      text: '',
      toolResults: [{ tool_use_id: 'u1', text: 'ok' }],
    },
  ] as unknown as never

  on('session.messages', () => ({ value: said }))
  on('model.complete', ($$, e) => {
    prompts.push(e.prompt)
    settled()

    return { value: { isAnswered: true, text: CLEAN, usage: USAGE } }
  })
  on('ui.render', () => ({
    type: 'Text',
    props: {},
    children: ['drawn by Claude Code'],
  }))

  await $.session.start({
    surface: 'terminal',
    isInteractive: true,
    cwd: '/work',
  })
  await $.tool.call({
    tool: 'Bash',
    tool_use_id: 'u1',
    command: 'echo 2 > notes/out.txt',
  })
  await $.turn.complete({
    turnId: 't1',
    answer: 'Wrote the notes',
    durationMs: 10,
    isAborted: false,
    usage: undefined,
    reason: 'answer',
  })

  await asked

  expect(prompts[0]).toContain('<what_the_turn_ran>')
  expect(prompts[0]).toContain('echo 2 > notes/out.txt')
})

test('a scratch or state file is not part of the change', () => {
  const home = '/home/me'
  const cwd = '/work'

  // A subagent's scratchpad and the engine's own session state: neither can
  // be committed, so neither is the change a lane is asked to judge.
  expect(
    isEphemeral('/private/tmp/claude-501/-proj/sess/scratchpad/build.py', home, cwd),
  ).toBe(true)
  expect(isEphemeral('/tmp/notes.txt', home, cwd)).toBe(true)
  expect(isEphemeral('/var/folders/ab/T/thing.json', home, cwd)).toBe(true)
  expect(
    isEphemeral('/home/me/.claude/projects/-proj/sess/tool-results/x.txt', home, cwd),
  ).toBe(true)

  // Work in a tree that no repository holds is still the work.
  expect(isEphemeral('/home/me/.acme-artifacts/runs/_ops/x.py', home, cwd)).toBe(
    false,
  )
  expect(isEphemeral('/work/src/thing.ts', home, cwd)).toBe(false)

  // A project that happens to live under a temp directory is the session's
  // own tree, so it is kept.
  expect(isEphemeral('/private/tmp/fixture/notes/out.txt', home, '/private/tmp/fixture')).toBe(
    false,
  )
})


const BAND = {
  plugin: 'backseat',
  component: 'AbovePrompt',
  requestId: 'backseat',
  surface: 'terminal',
  viewport: { columns: 100, rows: 30 },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

test(
  'forget compacts as soon as it can, and survives a refusal',
  { options: { refine: 'on', refineAtPercent: 75, debug: true } },
  async ($, on) => {
    // `$.session.compact` refuses inside a `command.run` hook: it would compact
    // under the turn the hook is holding. Run where it was typed, the command
    // reported that it could not and left the ask for whenever a compaction
    // next happened of its own accord, which may be a long way off.
    const clock = mock.clock(on)
    const asked: string[] = []

    on('command.register', () => ({ value: { command: 'backseat' } }))
    on('session.id', () => ({ value: 'session-forget-arms' }))
    on('ui.log', () => ({ value: undefined }))
    on('ui.toast', () => ({ value: undefined }))
    on('ui.invalidate', () => ({ value: undefined }))
    on('session.start', () => ({ cwd: '/work' }))
    on('fs.list', () => ({ value: [] }))
    on('fs.exists', () => ({ value: false }))
    on('fs.read', () => ({ value: '' }))
    on('turn.complete', () => ({ text: '' }))
    on('store.get', () => ({ value: [] }))
    on('store.set', () => ({ value: undefined }))
    on('store.delete', () => ({ value: undefined }))
    on('process.run', () => ({
      value: {
        exitCode: 0,
        stdout: '/work',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }))
    // Well under the mark, so only the ask can carry it.
    on('session.usage', () => ({
      value: {
        startedAt: 0,
        context: { percent: 12, window: 200_000, tokens: 24_000 },
        rateLimits: [],
      },
    }))
    on('session.compact', () => {
      asked.push('compact')

      return { skip: 'the test refused it' }
    })
    on('ui.render', () => ({
      type: 'Text',
      props: {},
      children: ['drawn by Claude Code'],
    }))

    await $.session.start({
      surface: 'terminal',
      isInteractive: true,
      cwd: '/work',
    })

    // A turn ending under the mark asks for nothing.
    await $.turn.complete({
      turnId: 't1',
      answer: 'done',
      durationMs: 10,
      isAborted: false,
      usage: undefined,
      reason: 'answer',
    })
    await clock.advance(5_000)

    expect(asked).toEqual([])

    const said = await $.command.run({
      command: 'backseat',
      args: 'forget the 500s from the API',
      origin: { kind: 'composer' } as const,
      presentation: { isFullscreen: false, columns: 80 } as const,
    })

    // The command does not compact inside its own hook, which the host refuses.
    expect(asked).toEqual([])
    expect(String((said as { text?: unknown }).text ?? '')).toContain(
      'Running now',
    )

    // Its own timer carries it, without another turn having to happen.
    await clock.advance(5_000)

    expect(asked).toEqual(['compact'])

    // And a refusal does not consume the ask: the next turn's end retries it.
    await $.turn.complete({
      turnId: 't2',
      answer: 'done',
      durationMs: 10,
      isAborted: false,
      usage: undefined,
      reason: 'answer',
    })
    await clock.advance(5_000)

    expect(asked).toEqual(['compact', 'compact'])

    // It is not asked for ever, though: a refusal every time would otherwise
    // spend a request once a turn for the rest of the session.
    for (const id of ['t3', 't4', 't5', 't6', 't7', 't8']) {
      await $.turn.complete({
        turnId: id,
        answer: 'done',
        durationMs: 10,
        isAborted: false,
        usage: undefined,
        reason: 'answer',
      })
      await clock.advance(5_000)
    }

    // `ASK_TRIES` is 5, and the first attempt is the command's own timer.
    expect(asked.length).toBeLessThanOrEqual(6)
  },
)

test(
  'a provider that keeps failing outright stops being spawned',
  { options: { provider: 'kimi', lanes: 'spec', debug: true } },
  async ($, on) => {
    // `Prompt hook blocked the request` and a timed-out process are not
    // limits, so nothing recorded them: the lane was spawned again on every
    // turn and paid its whole timeout each time. A count is what separates
    // that from a single stumble, which is still retried at once.
    const runs: string[] = []

    on('command.register', () => ({ value: { command: 'backseat' } }))
    on('session.id', () => ({ value: 'session-failing-provider' }))
    on('ui.log', () => ({ value: undefined }))
    on('ui.toast', () => ({ value: undefined }))
    on('ui.invalidate', () => ({ value: undefined }))
    on('session.start', () => ({ cwd: '/work' }))
    on('fs.list', () => ({ value: [] }))
    on('fs.exists', () => ({ value: false }))
    on('fs.read', () => ({ value: '' }))
    on('turn.complete', () => ({ text: '' }))
    on('tool.call', () => ({ result: 'ok' }))
    on('store.get', () => ({ value: [] }))
    on('store.set', () => ({ value: undefined }))
    on('store.delete', () => ({ value: undefined }))
    on('classic.Stop', () => ({}))
    on('ui.render', () => ({
      type: 'Text',
      props: {},
      children: ['drawn by Claude Code'],
    }))
    on('process.run', ($$, e) => {
      const argv = e.argv ?? []
      const isGit = argv[0] === 'git'
      const isProbe = argv.includes('--version')

      if (!isGit && !isProbe) {
        runs.push(argv.join(' '))
      }

      return {
        value: {
          exitCode: isGit || isProbe ? 0 : 1,
          stdout: isGit
            ? (argv.includes('rev-parse')
                ? '/work'
                : 'diff --git a/src/thing.ts b/src/thing.ts\n+ added')
            : isProbe
              ? 'kimi 1.0.0'
              : '',
          stderr:
            isGit || isProbe
              ? ''
              : 'error: failed to run prompt: Prompt hook blocked the request.',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    })

    await $.session.start({
      surface: 'terminal',
      isInteractive: true,
      cwd: '/work',
    })

    // Reviews are debounced, so several turns are needed per spawn: enough of
    // them to carry the count past the threshold and some way beyond it.
    const turns = Array.from({ length: 24 }, (_unused, at) => `t${at + 1}`)

    for (const id of turns) {
      await $.tool.call({
        tool: 'Edit',
        file_path: `src/${id}.ts`,
        old_string: 'was',
        new_string: 'is',
      })
      await $.turn.complete({
        turnId: id,
        answer: `Edited src/${id}.ts`,
        durationMs: 10,
        isAborted: false,
        usage: undefined,
        reason: 'answer',
      })
    }

    // The count earns the wait, so the spawns stop at it rather than running
    // once per turn for as long as the provider stays broken.
    expect(runs.length).toBeGreaterThan(0)
    expect(runs.length).toBeLessThanOrEqual(FAILURES_BEFORE_WAIT)
    expect(FAILURES_BEFORE_WAIT).toBeLessThan(turns.length)
  },
)

test(
  'autofix hands a finding over without a press, and only once',
  { options: { autofix: 'on' } },
  async ($, on) => {
    // The fix button and the option share one action, so a finding handed over
    // by the option is dropped from the panel and recorded against its subject
    // exactly as a press would: pressing fix afterwards must not spend a second
    // turn on work already sent.
    let settled: () => void = () => undefined
    const stored = new Promise<void>(resolve => {
      settled = resolve
    })
    const submitted: string[] = []

    on('command.register', () => ({ value: { command: 'backseat' } }))
    on('session.id', () => ({ value: 'session-autofix' }))
    on('ui.log', () => ({ value: undefined }))
    // The option announces its count, which is the one signal that the handover
    // has happened: the subjects are recorded just before it, so waiting on
    // that write would race the submission.
    on('ui.toast', ($$, e) => {
      if (String((e as { text?: unknown }).text ?? '').includes('to be fixed')) {
        settled()
      }

      return { value: undefined }
    })
    on('session.start', () => ({ cwd: '/work' }))
    on('fs.list', () => ({ value: [] }))
    on('turn.complete', () => ({ text: '' }))
    on('tool.call', () => ({ result: 'ok' }))
    on('store.get', () => ({ value: [] }))
    on('store.set', () => ({ value: undefined }))
    on('fs.exists', () => ({ value: false }))
    on('classic.Stop', () => ({}))
    on('prompt.submit', ((($$: never, e: { text: string }) => {
      submitted.push(String(e.text))

      return { text: String(e.text) }
    }) as never))
    on('ui.render', () => ({
      type: 'Text',
      props: {},
      children: ['drawn by Claude Code'],
    }))
    on('process.run', ($$, e) => ({
      value: {
        exitCode: 0,
        stdout: (e.argv ?? []).includes('rev-parse')
          ? '/work'
          : 'diff --git a/src/thing.ts b/src/thing.ts\n+ added',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }))
    on('model.complete', () => ({
      value: {
        isAnswered: true,
        text: JSON.stringify({
          verdict: 'findings',
          findings: [
            {
              severity: 'high',
              title: 'Only finding',
              body: 'the body',
              file: 'src/thing.ts',
              line_start: 12,
              line_end: 14,
              confidence: 0.9,
              reference: 'src/thing.ts',
              recommendation: 'do the thing',
            },
          ],
        }),
        usage: USAGE,
      },
    }))

    await $.session.start({
      surface: 'terminal',
      isInteractive: true,
      cwd: '/work',
    })
    await $.tool.call({
      tool: 'Edit',
      file_path: 'src/thing.ts',
      old_string: 'was',
      new_string: 'is',
    })
    await $.turn.complete({
      turnId: 't1',
      answer: 'Edited src/thing.ts',
      durationMs: 10,
      isAborted: false,
      usage: undefined,
      reason: 'answer',
    })

    await stored

    // Handed over by the option alone: nothing has been pressed.
    expect(submitted.length).toBe(1)
    expect(submitted[0]).toContain('src/thing.ts')

    // And the card is gone with it, so there is nothing left to press twice.
    const ui = await $.ui.mount(BAND as never)

    expect(await ui.find({ type: 'Text', text: 'Only finding' })).toBeUndefined()
    expect(submitted.length).toBe(1)

    await ui.unmount()
  },
)

test('pressing fix twice submits the work once', async ($, on) => {
  let settled: () => void = () => undefined
  const stored = new Promise<void>(resolve => {
    settled = resolve
  })
  const submitted: string[] = []

  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-fix-once' }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('fs.list', () => ({ value: [] }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('store.get', () => ({ value: [] }))
  on('store.set', ($$, e) => {
    if (String(e.key).startsWith('seen:')) {
      settled()
    }

    return { value: undefined }
  })
  on('fs.exists', () => ({ value: false }))
  on('classic.Stop', () => ({}))
  // The action under test: each activation would otherwise enqueue the same
  // instruction again.
  on('prompt.submit', ((($$: never, e: { text: string }) => {
    submitted.push(String(e.text))

    return { text: String(e.text) }
  }) as never))
  on('ui.render', () => ({
    type: 'Text',
    props: {},
    children: ['drawn by Claude Code'],
  }))
  on('process.run', ($$, e) => ({
    value: {
      exitCode: 0,
      stdout: (e.argv ?? []).includes('rev-parse')
        ? '/work'
        : 'diff --git a/src/thing.ts b/src/thing.ts\n+ added',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: JSON.stringify({
        verdict: 'findings',
        findings: [
          {
            severity: 'high',
            title: 'Only finding',
            body: 'the body',
            file: 'src/thing.ts',
            line_start: 12,
            line_end: 14,
            confidence: 0.9,
            reference: 'src/thing.ts',
            recommendation: 'do the thing',
          },
        ],
      }),
      usage: USAGE,
    },
  }))

  await $.session.start({
    surface: 'terminal',
    isInteractive: true,
    cwd: '/work',
  })
  await $.tool.call({
    tool: 'Edit',
    file_path: 'src/thing.ts',
    old_string: 'was',
    new_string: 'is',
  })
  await $.turn.complete({
    turnId: 't1',
    answer: 'Edited src/thing.ts',
    durationMs: 10,
    isAborted: false,
    usage: undefined,
    reason: 'answer',
  })

  await stored

  const ui = await $.ui.mount(BAND as never)

  expect(await ui.find({ type: 'Text', text: 'Only finding' })).toBeDefined()

  // No card action may claim a bare digit: a digit typed into an empty
  // composer presses a band Button, and a digit is how the engine's own
  // question prompt is answered, so a numbered action fires on an answer.
  for (const key of ['fix', 'why', 'no']) {
    const button = (await ui.find({ type: 'Button', key })) as
      | { props?: { hotkey?: unknown }; hotkey?: unknown }
      | undefined

    expect(button).toBeDefined()

    const hotkey = String(button?.props?.hotkey ?? button?.hotkey ?? '')

    expect(hotkey).not.toBe('')
    expect(/^[0-9]$/.test(hotkey)).toBe(false)
  }

  await ui.press({ key: 'fix' })
  await ui.press({ key: 'fix' })

  expect(submitted.length).toBe(1)

  await ui.unmount()
})

test(
  'a refinement is never requested when no provider can be reached',
  { options: { provider: 'kimi', refine: 'on', refineAtPercent: 75 } },
  async ($, on) => {
    // The panel learned a provider was spent only by collecting a refusal from
    // one, so a provider that is not installed never taught it anything: it
    // asked for a compaction at every mark with no reviewer behind it. A
    // version probe is what tells it, before anything is requested.
    const clock = mock.clock(on)
    const asked: string[] = []
    const probed: string[] = []

    on('command.register', () => ({ value: { command: 'backseat' } }))
    on('session.id', () => ({ value: 'session-refine-standdown' }))
    on('ui.log', () => ({ value: undefined }))
    on('ui.toast', () => ({ value: undefined }))
    on('ui.invalidate', () => ({ value: undefined }))
    on('session.start', () => ({ cwd: '/work' }))
    on('fs.list', () => ({ value: [] }))
    on('fs.exists', () => ({ value: false }))
    on('fs.read', () => ({ value: '' }))
    on('turn.complete', () => ({ text: '' }))
    on('tool.call', () => ({ result: 'ok' }))
    on('store.get', () => ({ value: [] }))
    on('store.set', () => ({ value: undefined }))
    on('store.delete', () => ({ value: undefined }))
    on('session.usage', () => ({
      value: {
        startedAt: 0,
        context: { percent: 77, window: 200_000, tokens: 154_000 },
        rateLimits: [],
      },
    }))
    on('session.compact', () => {
      asked.push('compact')

      return { skip: 'the test refused it' }
    })
    on('process.run', ($$, e) => {
      const argv = e.argv ?? []

      probed.push(argv.join(' '))

      const isGit = argv[0] === 'git'

      return {
        value: {
          exitCode: isGit ? 0 : 127,
          stdout: isGit ? '/work' : '',
          stderr: isGit ? '' : 'kimi: command not found',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    })
    on('ui.render', () => ({
      type: 'Text',
      props: {},
      children: ['drawn by Claude Code'],
    }))

    await $.session.start({
      surface: 'terminal',
      isInteractive: true,
      cwd: '/work',
    })
    await $.turn.complete({
      turnId: 't1',
      answer: 'said something',
      durationMs: 10,
      isAborted: false,
      usage: undefined,
      reason: 'answer',
    })

    // The request is deferred past the turn boundary, so the clock is moved
    // onto it rather than the test waiting.
    await clock.advance(5_000)

    expect(probed.some(one => one.startsWith('kimi'))).toBe(true)
    expect(asked).toEqual([])
  },
)

test(
  'a refinement is never requested when only the cleaner is spent',
  {
    options: {
      provider: 'codex',
      refine: 'on',
      refineAtPercent: 75,
      // The notes this reads are kept out of the conversation unless asked for.
      debug: true,
    },
  },
  async ($, on) => {
    // A reviewer being reachable says nothing about whether a refinement can
    // release anything: `survivorsOf` frees a residue row only when a cleaner
    // released its handle, so with the cleaner spent the compaction that
    // follows can only be the engine's summary. Gating on the whole roster let
    // that through, because the reviewer answered for the cleaner.
    const clock = mock.clock(on)
    const asked: string[] = []
    const notes: string[] = []

    on('command.register', () => ({ value: { command: 'backseat' } }))
    on('session.id', () => ({ value: 'session-cleaner-spent' }))
    on('ui.log', ($$, e) => {
      notes.push(String((e as { text?: unknown }).text ?? ''))

      return { value: undefined }
    })
    on('ui.toast', () => ({ value: undefined }))
    on('ui.invalidate', () => ({ value: undefined }))
    on('session.start', () => ({ cwd: '/work' }))
    on('fs.list', ($$, e) => ({
      value: String(e.path ?? '').includes('lanes')
        ? [
            { name: 'tidy.md', kind: 'file' as const, size: 10, mtimeMs: 1, isLink: false },
            { name: 'bugs.md', kind: 'file' as const, size: 10, mtimeMs: 1, isLink: false },
          ]
        : [],
    }))
    on('fs.exists', () => ({ value: true }))
    on('fs.read', ($$, e) => ({
      value: String(e.path ?? '').includes('tidy')
        ? [
            '---',
            'provider: kimi',
            'fallback: off',
            'sees: transcript',
            'on: ask',
            'question: What no longer needs to stay?',
            '---',
            '',
          ].join('\n')
        : [
            '---',
            'provider: codex',
            'fallback: off',
            'sees: diff',
            'on: turn',
            'question: Is it right?',
            '---',
            '',
          ].join('\n'),
    }))
    on('turn.complete', () => ({ text: '' }))
    on('tool.call', () => ({ result: 'ok' }))
    on('store.get', () => ({ value: [] }))
    on('store.set', () => ({ value: undefined }))
    on('store.delete', () => ({ value: undefined }))
    on('session.usage', () => ({
      value: {
        startedAt: 0,
        context: { percent: 95, window: 200_000, tokens: 190_000 },
        rateLimits: [],
      },
    }))
    on('session.compact', () => {
      asked.push('compact')

      return { skip: 'the test refused it' }
    })
    // The reviewer answers its version probe and the cleaner does not, so the
    // roster is not wholly unaskable and only the cleaner-specific gate can
    // hold the request.
    on('process.run', ($$, e) => {
      const argv = e.argv ?? []
      const isGit = argv[0] === 'git'
      const isCleaner = argv[0] === 'kimi'

      return {
        value: {
          exitCode: isGit || !isCleaner ? 0 : 127,
          stdout: isGit ? '/work' : isCleaner ? '' : 'codex 1.0.0',
          stderr: isCleaner ? 'kimi: command not found' : '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    })
    on('ui.render', () => ({
      type: 'Text',
      props: {},
      children: ['drawn by Claude Code'],
    }))

    await $.session.start({
      surface: 'terminal',
      isInteractive: true,
      cwd: '/work',
    })
    await $.turn.complete({
      turnId: 't1',
      answer: 'said something',
      durationMs: 10,
      isAborted: false,
      usage: undefined,
      reason: 'answer',
    })
    await clock.advance(5_000)

    expect(asked).toEqual([])
    expect(
      notes.some(one => one.includes('no lane that reads the transcript')),
    ).toBe(true)
  },
)

test(
  'only the delegating turn asks for a refinement, not the subagent inside it',
  { options: { refine: 'on', refineAtPercent: 75 } },
  async ($, on) => {
    // A subagent's turn ends while the turn that delegated it is still
    // running, so a request armed there fires inside that turn and the engine
    // refuses it for one in flight: measured across a session's log, twenty
    // refusals to one acceptance.
    const clock = mock.clock(on)
    const asked: string[] = []

    on('command.register', () => ({ value: { command: 'backseat' } }))
    on('session.id', () => ({ value: 'session-refine-subagent' }))
    on('ui.log', () => ({ value: undefined }))
    on('ui.toast', () => ({ value: undefined }))
    on('ui.invalidate', () => ({ value: undefined }))
    on('session.start', () => ({ cwd: '/work' }))
    // A cleaner has to exist for a refinement to be reachable at all: with no
    // lane reading the transcript the watcher stands down before it gets as
    // far as asking who the turn belongs to, which is what this is about.
    on('fs.list', ($$, e) => ({
      value: String(e.path ?? '').includes('lanes')
        ? [
            {
              name: 'tidy.md',
              kind: 'file' as const,
              size: 10,
              mtimeMs: 1,
              isLink: false,
            },
          ]
        : [],
    }))
    on('fs.exists', () => ({ value: true }))
    on('fs.read', () => ({
      value: [
        '---',
        'provider: kimi',
        'fallback: off',
        'sees: transcript',
        'on: ask',
        'question: What no longer needs to stay?',
        '---',
        '',
      ].join('\n'),
    }))
    on('turn.complete', () => ({ text: '' }))
    on('store.get', () => ({ value: [] }))
    on('store.set', () => ({ value: undefined }))
    on('store.delete', () => ({ value: undefined }))
    on('process.run', () => ({
      value: {
        exitCode: 0,
        stdout: '/work',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }))
    on('session.usage', () => ({
      value: {
        startedAt: 0,
        context: { percent: 93, window: 200_000, tokens: 186_000 },
        rateLimits: [],
      },
    }))
    on('session.compact', () => {
      asked.push('compact')

      return { skip: 'the test refused it' }
    })
    on('ui.render', () => ({
      type: 'Text',
      props: {},
      children: ['drawn by Claude Code'],
    }))

    await $.session.start({
      surface: 'terminal',
      isInteractive: true,
      cwd: '/work',
    })

    // The watcher's own ask never reaches this plugin's hook, so with nothing
    // precomputed it could only summarise, and it holds.
    await $.turn.complete({
      turnId: 'before-precompute',
      answer: 'a turn before any precompute',
      durationMs: 10,
      isAborted: false,
      usage: undefined,
      reason: 'answer',
    })
    await clock.advance(5_000)

    expect(asked).toEqual([])

    // Twenty identical large outputs behind forty recent messages: a precompute
    // releases the repeats, which clears the floor and leaves a refinement.
    const repeated = Array.from({ length: 20 }, (_, at) => ({
      role: 'assistant' as const,
      text: '',
      toolUses: [
        {
          tool_use_id: `u${at}`,
          tool: 'Bash',
          input: { command: 'cargo build --release' },
          text: 'warning: unused\n'.repeat(3000),
        },
      ],
      handle: `h${at}`,
    }))
    const recent = Array.from({ length: 40 }, (_, at) => ({
      role: 'assistant' as const,
      text: `step ${at}`,
      toolUses: [],
      handle: `r${at}`,
    }))
    const precomputed = await $.session.compact({
      trigger: 'precompute',
      messages: [...repeated, ...recent],
    })

    expect(precomputed.skip).toBe(undefined)

    await $.turn.complete({
      turnId: 'sub-turn',
      agentId: 'agent-1',
      answer: 'the subagent finished',
      durationMs: 10,
      isAborted: false,
      usage: undefined,
      reason: 'answer',
    })
    await clock.advance(5_000)

    expect(asked).toEqual([])

    await $.turn.complete({
      turnId: 'main-turn',
      answer: 'the delegating turn finished',
      durationMs: 10,
      isAborted: false,
      usage: undefined,
      reason: 'answer',
    })
    await clock.advance(5_000)

    expect(asked).toEqual(['compact'])
  },
)

test(
  'the dispatch nobody waits behind reaches the cleaner it would ask',
  { options: { refine: 'on', refineAtPercent: 75 } },
  async ($, on) => {
    const clock = mock.clock(on)
    const notes: string[] = []

    on('command.register', () => ({ value: { command: 'backseat' } }))
    on('session.id', () => ({ value: 'session-cleaner-gate' }))
    on('ui.log', () => ({ value: undefined }))
    on('ui.toast', () => ({ value: undefined }))
    on('ui.invalidate', () => ({ value: undefined }))
    on('session.start', () => ({ cwd: '/work' }))
    on('fs.list', () => ({ value: [] }))
    on('fs.exists', () => ({ value: false }))
    on('fs.read', () => ({ value: '' }))
    on('turn.complete', () => ({ text: '' }))
    on('store.get', () => ({ value: [] }))
    on('store.delete', () => ({ value: undefined }))
    on('store.set', ($$, e) => {
      if (Array.isArray(e.value)) {
        notes.push(String(e.value.at(-1) ?? ''))
      }

      return { value: undefined }
    })
    on('process.run', () => ({
      value: {
        exitCode: 0,
        stdout: '/work',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }))
    on('session.usage', () => ({
      value: {
        startedAt: 0,
        context: { percent: 93, window: 200_000, tokens: 186_000 },
        rateLimits: [],
      },
    }))
    on('session.compact', () => ({ skip: 'the engine summarised' }))
    on('ui.render', () => ({
      type: 'Text',
      props: {},
      children: ['drawn by Claude Code'],
    }))

    await $.session.start({
      surface: 'terminal',
      isInteractive: true,
      cwd: '/work',
    })

    const messages = Array.from({ length: 60 }, (_, at) => ({
      role: 'assistant' as const,
      text: `line ${at} ${'z'.repeat(400)}`,
      toolUses: [],
      handle: `h${at}`,
    }))

    await $.session.compact({ trigger: 'precompute', messages })
    await $.turn.complete({
      turnId: 't1',
      answer: 'done',
      durationMs: 10,
      isAborted: false,
      usage: undefined,
      reason: 'answer',
    })
    await clock.advance(5_000)

    // The question is asked from inside the compaction, so the note naming a
    // missing cleaner is the only thing that proves it was reached at all.
    // `precompute` is the dispatch that asks: it installs nothing, nobody
    // waits behind it, and the live log shows it arriving.
    expect(
      notes.some(one => one.includes('no lane reads the transcript')),
    ).toBe(true)
  },
)


test(
  'a refinement someone waits behind does not ask, and reuses what did',
  {
    options: {
      provider: 'codex',
      refine: 'on',
      refineAtPercent: 75,
      debug: true,
    },
  },
  async ($, on) => {
    // Measured against the cleaner's own provider, a 70k prompt answered in
    // 33s and a 190k one in 295s, and a window carries the anchor beside it.
    // There is no window size a waiting session can be held for that is still
    // worth asking about, so a waited dispatch asks nothing and uses what a
    // `precompute` dispatch — which nobody waits behind — already released.
    // The live log showed the old behaviour: two windows aborted at the bound
    // with nothing released, twice.
    const clock = mock.clock(on)
    const notes: string[] = []
    const prompted: number[] = []

    on('command.register', () => ({ value: { command: 'backseat' } }))
    on('session.id', () => ({ value: 'session-waited-no-ask' }))
    on('ui.log', ($$, e) => {
      notes.push(String((e as { text?: unknown }).text ?? ''))

      return { value: undefined }
    })
    on('ui.toast', () => ({ value: undefined }))
    on('ui.invalidate', () => ({ value: undefined }))
    on('session.start', () => ({ cwd: '/work' }))
    on('fs.list', ($$, e) => ({
      value: String(e.path ?? '').includes('lanes')
        ? [
            {
              name: 'tidy.md',
              kind: 'file' as const,
              size: 10,
              mtimeMs: 1,
              isLink: false,
            },
          ]
        : [],
    }))
    on('fs.exists', () => ({ value: true }))
    on('fs.read', () => ({
      value: [
        '---',
        'provider: kimi',
        'fallback: off',
        'sees: transcript',
        'on: ask',
        'question: What no longer needs to stay?',
        '---',
        '',
      ].join('\n'),
    }))
    on('turn.complete', () => ({ text: '' }))
    on('tool.call', () => ({ result: 'ok' }))
    on('store.get', () => ({ value: [] }))
    on('store.set', () => ({ value: undefined }))
    on('store.delete', () => ({ value: undefined }))
    on('process.run', ($$, e) => {
      const argv = (e.argv ?? []) as readonly string[]
      const at = argv.indexOf('-p')

      // Only a call carrying a prompt counts. A version probe is also a run of
      // the same binary, and counting it passed this test with nothing asked.
      if (argv[0] === 'kimi' && at >= 0) {
        prompted.push(String(argv[at + 1] ?? '').length)

        return {
          value: {
            exitCode: 0,
            stdout: '[]',
            stderr: '',
            isStdoutTruncated: false,
            isStderrTruncated: false,
          },
        }
      }

      return {
        value: {
          exitCode: 0,
          stdout: '/work',
          stderr: '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    })
    on('session.usage', () => ({
      value: {
        startedAt: 0,
        context: { percent: 95, window: 200_000, tokens: 190_000 },
        rateLimits: [],
      },
    }))
    on('session.compact', () => ({ skip: 'the engine summarised' }))
    on('ui.render', () => ({
      type: 'Text',
      props: {},
      children: ['drawn by Claude Code'],
    }))

    await $.session.start({
      surface: 'terminal',
      isInteractive: true,
      cwd: '/work',
    })

    const messages = Array.from({ length: 300 }, (_, at) => ({
      role: 'assistant' as const,
      text: `line ${at} ${'z'.repeat(3_000)}`,
      toolUses: [],
      handle: `h${at}`,
    }))

    await $.session.compact({ trigger: 'auto', messages })
    await clock.advance(5_000)

    expect(prompted).toEqual([])
    expect(
      notes.some(one => one.includes('uses what an earlier dispatch released')),
    ).toBe(true)

    // The dispatch nobody waits behind is the one that asks, so the answer the
    // compaction above reuses has somewhere to come from.
    await $.session.compact({ trigger: 'precompute', messages })
    await clock.advance(5_000)

    expect(prompted.length).toBeGreaterThan(0)
  },
)

test(
  'no cleaner at all stands the watcher down instead of forcing a summary',
  { options: { refine: 'on', refineAtPercent: 75, debug: true } },
  async ($, on) => {
    // The gate asks whether a lane that reads the transcript can be asked, and
    // answered "one can" when none existed, because it required a cleaner to
    // be present before it would consider the question. A session with no lane
    // directory then had a compaction forced on it at the mark, which could
    // only summarise: the live log shows the roster empty and the compaction
    // requested anyway.
    const clock = mock.clock(on)
    const asked: string[] = []
    const notes: string[] = []

    on('command.register', () => ({ value: { command: 'backseat' } }))
    on('session.id', () => ({ value: 'session-empty-roster' }))
    on('ui.log', ($$, e) => {
      notes.push(String((e as { text?: unknown }).text ?? ''))

      return { value: undefined }
    })
    on('ui.toast', () => ({ value: undefined }))
    on('ui.invalidate', () => ({ value: undefined }))
    on('session.start', () => ({ cwd: '/work' }))
    on('fs.list', () => ({ value: [] }))
    on('fs.exists', () => ({ value: false }))
    on('fs.read', () => ({ value: '' }))
    on('turn.complete', () => ({ text: '' }))
    on('tool.call', () => ({ result: 'ok' }))
    on('store.get', () => ({ value: [] }))
    on('store.set', () => ({ value: undefined }))
    on('store.delete', () => ({ value: undefined }))
    on('process.run', () => ({
      value: {
        exitCode: 0,
        stdout: '/work',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }))
    on('session.usage', () => ({
      value: {
        startedAt: 0,
        context: { percent: 80, window: 200_000, tokens: 160_000 },
        rateLimits: [],
      },
    }))
    on('session.compact', () => {
      asked.push('compact')

      return { skip: 'the engine summarised' }
    })
    on('ui.render', () => ({
      type: 'Text',
      props: {},
      children: ['drawn by Claude Code'],
    }))

    await $.session.start({
      surface: 'terminal',
      isInteractive: true,
      cwd: '/work',
    })

    await $.turn.complete({
      turnId: 't1',
      answer: 'done',
      durationMs: 10,
      isAborted: false,
      usage: undefined,
      reason: 'answer',
    })
    await clock.advance(5_000)

    expect(asked).toEqual([])
    expect(
      notes.some(one =>
        one.includes('no lane that reads the transcript can be asked'),
      ),
    ).toBe(true)
  },
)
