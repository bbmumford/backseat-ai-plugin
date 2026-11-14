import { expect, test } from 'claude-code/testing'

/**
 * What the engine passes a `ui.render` hook for the band above the prompt.
 * The panel reads `props.bodyColumns` to wrap its cards, so the width here is
 * the width the cards are drawn to.
 */
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

/**
 * The origin and the width the engine gives a command a person typed, which
 * `$.command.run` requires of every fired command.
 */
const ORIGIN = { kind: 'composer' } as const
const PRESENTATION = { isFullscreen: false, columns: 80 } as const

/**
 * A reviewer's answer carrying one finding, as the answer schema asks for it.
 *
 * @param lane the reviewer's name, which the panel stamps on the card
 * @param title the finding's one-line title
 * @param severity how bad the finding says it is
 * @param reference what the finding is about, which is what dedupe keys on
 * @returns the JSON text a provider would answer with
 */
function answer(
  lane: string,
  title: string,
  severity: string,
  reference: string,
): string {
  return JSON.stringify({
    verdict: 'findings',
    findings: [
      {
        severity,
        title,
        body: `${lane} says: ${title}`,
        file: 'src/thing.ts',
        line_start: 12,
        line_end: 14,
        confidence: 0.9,
        recommendation: 'change it',
        reference,
      },
    ],
  })
}

/**
 * The token counts a fork reports, which the panel reads only under its
 * debug option but which every fork result carries.
 */
const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

/**
 * The git verb in an argv, which may be preceded by `-C <root>` because the
 * diff is taken in the repository that holds the changed file rather than in
 * the session's own directory.
 *
 * @param argv the argv a process.run stub received
 * @returns the verb
 */
function verbOf(argv: readonly string[]): string {
  return (argv[1] === '-C' ? argv[3] : argv[1]) ?? ''
}

test('a turn that changed no code is never reviewed', async ($, on) => {
  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('store.get', () => ({ value: [] }))
  on('session.id', () => ({ value: 'session-a' }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('fs.list', () => ({ value: [] }))
  on('turn.complete', () => ({ text: '' }))

  // No model.fork and no process.run stub: a review that ran at all would
  // fail with no implementation, so the assertion below is the proof.
  await $.session.start({
    surface: 'terminal',
    isInteractive: true,
    cwd: '/work',
  })
  await $.turn.complete({
    turnId: 't1',
    answer: 'I looked at the code and explained it.',
    durationMs: 10,
    isAborted: false,
    usage: undefined,
    reason: 'answer',
  })

  const listed = await $.command.run({
    command: 'backseat',
    args: '',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  expect(listed.text).toContain('No turn has been reviewed yet')
})

test('a turn that edited a file is reviewed and its findings are drawn', async ($, on) => {
  let settled: () => void = () => undefined
  const stored = new Promise<void>(resolve => {
    settled = resolve
  })

  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-b' }))
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
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout:
        verbOf(e.argv) === 'rev-parse'
          ? '/work'
          : verbOf(e.argv) === 'diff'
          ? 'diff --git a/src/thing.ts b/src/thing.ts\n+ added'
          : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('model.complete', ($, e) => {
    const lane = /named "([a-z]+)"/.exec(e.prompt)?.[1] ?? 'spec'
    const text =
      lane === 'spec'
        ? answer(
            'spec',
            'The change contradicts the specification',
            'high',
            'docs/spec.md',
          )
        : lane === 'reuse'
          ? answer(
              'reuse',
              'This duplicates parseThing',
              'critical',
              'src/parse.ts',
            )
          : 'CLEAN'

    return { value: { isAnswered: true, text, usage: USAGE } }
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

  // The review is started without holding the turn, so wait for the write
  // that ends it rather than for a timer.
  await stored

  const ui = await $.ui.mount(BAND)

  // The critical finding is ranked above the high one, so the reuse lane's
  // card is the one drawn first.
  expect(
    await ui.find({ type: 'Text', text: /backseat · reuse/ }),
  ).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /backseat · spec/ })).toBeDefined()
  expect(
    await ui.find({ type: 'Text', text: 'This duplicates parseThing' }),
  ).toBeDefined()
  expect(
    await ui.find({ type: 'Text', text: 'src/thing.ts:12-14' }),
  ).toBeDefined()

  await ui.unmount()

  const listed = await $.command.run({
    command: 'backseat',
    args: '',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  expect(listed.text).toContain('reuse: findings')
  expect(listed.text).toContain('docs: clean')
})

test('a provider that broke reads as failed, never as a clean review', async ($, on) => {
  let settled: () => void = () => undefined
  const stored = new Promise<void>(resolve => {
    settled = resolve
  })

  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-c' }))
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
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: 'diff',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('model.complete', () => ({
    value: { isAnswered: false, reason: 'empty-reply', usage: USAGE },
  }))

  await $.session.start({
    surface: 'terminal',
    isInteractive: true,
    cwd: '/work',
  })
  await $.tool.call({ tool: 'Write', file_path: 'src/thing.ts', content: 'is' })
  await $.turn.complete({
    turnId: 't1',
    answer: 'Wrote src/thing.ts',
    durationMs: 10,
    isAborted: false,
    usage: undefined,
    reason: 'answer',
  })

  await stored

  const listed = await $.command.run({
    command: 'backseat',
    args: '',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  expect(listed.text).toContain('spec: failed')
  expect(listed.text).not.toContain('spec: clean')
  expect(listed.text).toContain('Nothing open.')
})

test('a finding is handed to the model once and holds no turn', async ($, on) => {
  let settled: () => void = () => undefined
  const stored = new Promise<void>(resolve => {
    settled = resolve
  })

  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-d' }))
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
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: 'diff',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: answer(
        'spec',
        'The change contradicts the specification',
        'critical',
        'docs/spec.md',
      ),
      usage: USAGE,
    },
  }))
  on('classic.Stop', () => ({}))

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

  const stop = await $.classic.Stop({ stop_hook_active: false })

  // The default enforcement delivers: a critical finding reaches the model as
  // context, and nothing holds the turn.
  expect(stop.block).toBeUndefined()
  expect(stop.additionalContext).toBeDefined()
  expect(JSON.stringify(stop.additionalContext)).toContain(
    'contradicts the specification',
  )
  expect(JSON.stringify(stop.additionalContext)).toContain('advisory')

  // Context returned here is itself a reason the host carries the turn on, and
  // the card stays on the panel until it is dismissed, so a second Stop with
  // the same finding must hand over nothing: sending it again is what holds a
  // session until the engine's consecutive-block cap overrides it.
  const again = await $.classic.Stop({ stop_hook_active: false })

  expect(again.block).toBeUndefined()
  expect(again.additionalContext).toBeUndefined()

  // A turn the host is already carrying on at a Stop hook's request is left
  // alone whatever the panel holds.
  const during = await $.classic.Stop({ stop_hook_active: true })

  expect(during.block).toBeUndefined()
  expect(during.additionalContext).toBeUndefined()
})

test('dismissing a finding takes it off the panel', async ($, on) => {
  let settled: () => void = () => undefined
  const stored = new Promise<void>(resolve => {
    settled = resolve
  })

  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-e' }))
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
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: 'diff',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('model.complete', ($, e) => ({
    value: {
      isAnswered: true,
      text: /named "spec"/.test(e.prompt)
        ? answer('spec', 'Only finding', 'high', 'docs/spec.md')
        : 'CLEAN',
      usage: USAGE,
    },
  }))
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

  await stored

  const ui = await $.ui.mount(BAND)

  expect(await ui.find({ type: 'Text', text: 'Only finding' })).toBeDefined()

  await ui.press({ key: 'no' })

  expect(await ui.find({ type: 'Text', text: 'Only finding' })).toBeUndefined()

  await ui.unmount()
})

test('collecting the diff never writes to the index', async ($, on) => {
  let settled: () => void = () => undefined
  const stored = new Promise<void>(resolve => {
    settled = resolve
  })
  const ran: string[][] = []

  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-f' }))
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
  on('fs.read', () => ({ value: 'export const a = 1\n' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('process.run', ($, e) => {
    ran.push([...e.argv])

    const verb = verbOf(e.argv)

    return {
      value: {
        exitCode: 0,
        stdout:
          verb === 'rev-parse' ? '/work' : verb === 'ls-files' ? 'src/new.ts' : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('model.complete', () => ({
    value: { isAnswered: true, text: 'CLEAN', usage: USAGE },
  }))

  await $.session.start({
    surface: 'terminal',
    isInteractive: true,
    cwd: '/work',
  })
  await $.tool.call({
    tool: 'Write',
    file_path: 'src/new.ts',
    content: 'export const a = 1',
  })
  await $.turn.complete({
    turnId: 't1',
    answer: 'Wrote src/new.ts',
    durationMs: 10,
    isAborted: false,
    usage: undefined,
    reason: 'answer',
  })

  await stored

  // The index is the person's staging area. A reviewer that stages a path has
  // edited the work it was asked to judge, so no git call here may write.
  const writes = ran.filter(argv =>
    argv.some(word =>
      ['add', 'stage', 'commit', 'reset', 'stash', 'clean', 'checkout'].includes(
        word,
      ),
    ),
  )

  expect(writes).toEqual([])
  expect(ran.some(argv => verbOf(argv) === 'diff')).toBe(true)
  expect(ran.some(argv => verbOf(argv) === 'ls-files')).toBe(true)
})

test('a Stop that arrives before the lanes answer delivers nothing, and never holds', async ($, on) => {
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => {
    release = resolve
  })

  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-g' }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('fs.list', () => ({ value: [] }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('store.get', () => ({ value: [] }))
  on('store.set', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: 'diff',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  // A lane that has not answered yet: the review is still in flight when the
  // Stop hook runs, which is the ordering a real session has.
  on('model.complete', async () => {
    await held

    return {
      value: {
        isAnswered: true,
        text: answer('spec', 'Late finding', 'critical', 'docs/spec.md'),
        usage: USAGE,
      },
    }
  })
  on('classic.Stop', () => ({}))

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

  // Stop arrives while the lane is still thinking.
  const stop = await $.classic.Stop({ stop_hook_active: false })

  // The turn is never held, and there is nothing to hand over yet: the
  // findings of an unfinished review reach the model at the next Stop, and
  // the person sooner than that, when the cards redraw.
  expect(stop.block).toBeUndefined()
  expect(stop.additionalContext).toBeUndefined()

  release()
})

/**
 * A lane file defining a reviewer with its own provider, floor and standing
 * instructions, as a repository would carry it.
 */
const PERF_LANE = [
  '---',
  'provider: kimi',
  'model: kimi-k2-thinking',
  'question: Did this change add work to a hot path?',
  'needs: reuse',
  'severity: high',
  '---',
  'Treat anything under `src/render/` as a hot path.',
].join('\n')

/**
 * Answers the git calls a review makes, so no repository is touched.
 *
 * @param argv the call's argv, as the stub receives it
 * @returns what the child would have written
 */
function gitStdout(argv: readonly string[]): string {
  const verb = verbOf(argv)

  // One call answers both the root and the commit the turn started from, so a
  // change the turn committed itself is still part of the diff.
  if (verb === 'rev-parse') {
    return argv.includes('HEAD')
      ? '/work\nbaa5eed0000000000000000000000000000000d'
      : '/work'
  }

  if (verb === 'diff' && argv.includes('--name-only')) {
    return 'src/render/draw.ts'
  }

  if (verb === 'diff') {
    return 'diff --git a/src/render/draw.ts b/src/render/draw.ts\n+ work'
  }

  return ''
}

test('/backseat help and a bad flag both explain the command', async ($, on) => {
  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-h' }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('fs.list', () => ({ value: [] }))
  on('store.get', () => ({ value: [] }))

  await $.session.start({
    surface: 'terminal',
    isInteractive: true,
    cwd: '/work',
  })

  const help = await $.command.run({
    command: 'backseat',
    args: 'help',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  expect(help.text).toContain('/backseat review')
  expect(help.text).toContain('laneDir')

  // A flag a subcommand does not take is a complaint, never a silent no-op.
  const bad = await $.command.run({
    command: 'backseat',
    args: 'setup --base main',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  expect(bad.text).toContain('setup does not take --base')
  expect(bad.text).toContain('/backseat setup')
})

test('/backseat cancel says so when nothing is in flight', async ($, on) => {
  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-i' }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('fs.list', () => ({ value: [] }))
  on('store.get', () => ({ value: [] }))

  await $.session.start({
    surface: 'terminal',
    isInteractive: true,
    cwd: '/work',
  })

  const out = await $.command.run({
    command: 'backseat',
    args: 'cancel',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  expect(out.text).toBe('No review is in flight.')
})

test('/backseat setup probes each provider and prints the resolved roster', async ($, on) => {
  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-j' }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('store.get', () => ({ value: [] }))
  on('fs.list', () => ({
    value: [
      { name: 'perf.md', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
    ],
  }))
  on('fs.read', ($, e) => ({
    value: e.path.endsWith('perf.md') ? PERF_LANE : '',
  }))
  on('fs.exists', () => ({ value: false }))
  // kimi answers its version probe; the lane file names it, so it is probed.
  on('process.run', ($, e) => ({
    value: {
      exitCode: e.argv[0] === 'kimi' ? 0 : 1,
      stdout: e.argv[0] === 'kimi' ? 'kimi 0.31.0' : '',
      stderr: e.argv[0] === 'kimi' ? '' : 'not found',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))

  await $.session.start({
    surface: 'terminal',
    isInteractive: true,
    cwd: '/work',
  })

  const out = await $.command.run({
    command: 'backseat',
    args: 'setup',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  expect(out.text).toContain('kimi: installed — kimi 0.31.0')
  expect(out.text).toContain('claude: installed')
  // The lane file's own settings are what the roster reports.
  expect(out.text).toContain('perf: kimi/kimi-k2-thinking')
  expect(out.text).toContain('reads reuse')
  expect(out.text).toContain('has instructions')
  expect(out.text).toContain('severity ≥ high')
  // And it runs after the lane it reads.
  const printed = out.text ?? ''

  expect(printed.indexOf('wave 1')).toBeLessThan(printed.indexOf('perf:'))
})

test('/backseat review runs the lanes now, and a lane file steers its provider', async ($, on) => {
  const prompts: string[] = []

  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-k' }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('store.get', () => ({ value: [] }))
  on('store.set', () => ({ value: undefined }))
  on('fs.list', () => ({
    value: [
      { name: 'perf.md', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
    ],
  }))
  on('fs.read', ($, e) => ({
    value: e.path.endsWith('perf.md') ? PERF_LANE : 'export const a = 1\n',
  }))
  on('fs.exists', () => ({ value: false }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: 'CLEAN', usage: USAGE },
  }))
  on('process.run', ($, e) => {
    if (e.argv[0] === 'kimi') {
      // The prompt reaches the provider on stdin or in argv; capture both.
      prompts.push(`${e.argv.join(' ')}\n${e.init?.stdin ?? ''}`)
    }

    return {
      value: {
        exitCode: 0,
        stdout: e.argv[0] === 'kimi' ? 'CLEAN' : gitStdout(e.argv),
        stderr: '',
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

  const out = await $.command.run({
    command: 'backseat',
    args: 'review',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  // Every lane ran, including the one only the lane file defines.
  expect(out.text).toContain('perf: clean')
  expect(out.text).toContain('spec: clean')

  // The lane file chose kimi and its model, and its standing instructions
  // travelled with the prompt.
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('-m kimi-k2-thinking')
  expect(prompts[0]).toContain(
    'Treat anything under `src/render/` as a hot path.',
  )
  expect(prompts[0]).toContain('Did this change add work to a hot path?')
})

test('/backseat review with nothing changed reviews nothing', async ($, on) => {
  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-l' }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('fs.list', () => ({ value: [] }))
  on('store.get', () => ({ value: [] }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))

  await $.session.start({
    surface: 'terminal',
    isInteractive: true,
    cwd: '/work',
  })

  const out = await $.command.run({
    command: 'backseat',
    args: 'review --base main',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  expect(out.text).toContain('Nothing differs from main')
})

test('a purpose and a model set by command reach the provider call', async ($, on) => {
  const asked: { model: string; prompt: string }[] = []
  const saved = new Map<string, unknown>()

  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-m' }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: 'export const a = 1\n' }))
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)

    return { value: undefined }
  })
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout: gitStdout(e.argv),
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('model.complete', ($, e) => {
    asked.push({ model: e.model, prompt: e.prompt })

    return { value: { isAnswered: true, text: 'CLEAN', usage: USAGE } }
  })

  await $.session.start({
    surface: 'terminal',
    isInteractive: true,
    cwd: '/work',
  })

  const set = await $.command.run({
    command: 'backseat',
    args: 'purpose Add caching to /ask without changing its response shape',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  expect(set.text).toContain('Purpose set')

  const picked = await $.command.run({
    command: 'backseat',
    args: 'model haiku',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  expect(picked.text).toContain('Every lane now asks haiku')

  await $.command.run({
    command: 'backseat',
    args: 'review',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  // Every lane was asked, with the model the command chose and the purpose
  // the command set: neither is merely reported back, both reach the call.
  expect(asked.length).toBe(3)
  expect(asked.every(call => call.model === 'haiku')).toBe(true)
  expect(asked[0]?.prompt).toContain('<purpose_of_this_work>')
  expect(asked[0]?.prompt).toContain('Add caching to /ask')

  // And both outlive a reload, because they are in the store under this
  // session's own key.
  expect(saved.get('state:session-m')).toMatchObject({
    purpose: 'Add caching to /ask without changing its response shape',
    models: { '*': 'haiku' },
  })
})

test('a purpose can be read back and cleared, and a model named for an unknown lane is refused', async ($, on) => {
  const saved = new Map<string, unknown>()

  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-n' }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('fs.list', () => ({ value: [] }))
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)

    return { value: undefined }
  })

  await $.session.start({
    surface: 'terminal',
    isInteractive: true,
    cwd: '/work',
  })

  const none = await $.command.run({
    command: 'backseat',
    args: 'purpose',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  expect(none.text).toContain('No purpose set')

  await $.command.run({
    command: 'backseat',
    args: 'purpose Ship the parser rewrite',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  const shown = await $.command.run({
    command: 'backseat',
    args: 'purpose',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  expect(shown.text).toBe('Purpose: Ship the parser rewrite')

  const cleared = await $.command.run({
    command: 'backseat',
    args: 'purpose --clear',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  expect(cleared.text).toContain('Purpose cleared')

  // A typo in a lane name must not silently set nothing.
  const wrong = await $.command.run({
    command: 'backseat',
    args: 'model perfff haiku',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  expect(wrong.text).toContain('No lane named "perfff"')
})

test('/backseat lanes prints the roster and the purpose without probing', async ($, on) => {
  const ran: string[][] = []

  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-o' }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('fs.list', () => ({
    value: [
      { name: 'perf.md', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
    ],
  }))
  on('fs.read', ($, e) => ({
    value: e.path.endsWith('perf.md') ? PERF_LANE : '',
  }))
  on('process.run', ($, e) => {
    ran.push([...e.argv])

    return {
      value: {
        exitCode: 0,
        stdout: '',
        stderr: '',
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

  const out = await $.command.run({
    command: 'backseat',
    args: 'lanes',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  expect(out.text).toContain('perf: kimi/kimi-k2-thinking')
  expect(out.text).toContain('none set')
  // Listing the roster must not start a process; that is what setup is for.
  expect(ran).toEqual([])
})

test("a subagent's turn never carries off what the main loop wrote", async ($, on) => {
  let settled: () => void = () => undefined
  const stored = new Promise<void>(resolve => {
    settled = resolve
  })
  const asked: string[][] = []
  let reviews = 0

  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-agents' }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('store.get', () => ({ value: [] }))
  on('store.set', () => {
    settled()

    return { value: undefined }
  })
  on('session.cwd', () => ({ value: '/work' }))
  on('process.run', ($, e) => {
    asked.push([...e.argv])

    const verb = verbOf(e.argv)

    return {
      value: {
        exitCode: 0,
        stdout:
          verb === 'rev-parse'
            ? '/work'
            : verb === 'diff'
              ? 'diff --git a/src/thing.ts b/src/thing.ts\n+ added'
              : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('model.complete', () => {
    reviews += 1

    return {
      value: {
        isAnswered: true,
        text: answer('spec', 'Drifted from the specification', 'high', 'docs/spec.md'),
        usage: USAGE,
      },
    }
  })

  await $.session.start({
    surface: 'terminal',
    isInteractive: true,
    cwd: '/work',
  })

  // The main loop edits a file, then a subagent's turn ends first — the
  // ordinary shape of delegating work, since a subagent finishes inside the
  // turn that spawned it.
  await $.tool.call({
    tool: 'Edit',
    file_path: 'src/thing.ts',
    old_string: 'was',
    new_string: 'is',
  })
  await $.turn.complete({
    turnId: 't1',
    answer: 'done',
    durationMs: 10,
    isAborted: false,
    usage: undefined,
    reason: 'answer',
    agentId: 'agent-1',
  })

  // No lane asked for subagents, so nothing was reviewed at the subagent's
  // turn.
  expect(reviews).toBe(0)

  await $.turn.complete({
    turnId: 't2',
    answer: 'Edited src/thing.ts',
    durationMs: 10,
    isAborted: false,
    usage: undefined,
    reason: 'answer',
  })

  await stored

  const diff = asked.find(argv => verbOf(argv) === 'diff') ?? []

  // The main loop's own edit is still there to review. On one shared list the
  // subagent's turn would have taken it, and the turn that made the edit
  // would have been reviewed on nothing. The path is absolute because the
  // diff is taken in the repository that holds the file, where a path
  // relative to the session's own directory would mean another file.
  expect(diff).toContain('/work/src/thing.ts')
  expect(diff.slice(0, 4)).toEqual(['git', '-C', '/work', 'diff'])
  expect(reviews).toBeGreaterThan(0)
})

test('a machine-wide lane file is read from outside the repository', async ($, on) => {
  let settled: () => void = () => undefined
  const stored = new Promise<void>(resolve => {
    settled = resolve
  })
  const prompts: string[] = []

  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-wide' }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.list', ($, e) => ({
    value:
      e.path === '/home/me/.claude/backseat/lanes'
        ? [
            {
              name: 'patterns.md',
              kind: 'file' as const,
              size: 10,
              mtimeMs: 1,
              isLink: false,
            },
          ]
        : [],
  }))
  on('fs.read', () => ({
    value: [
      '---',
      'question: Does this follow the patterns this code is written in?',
      'agents: true',
      '---',
      'Name the file and line that establishes the pattern.',
    ].join('\n'),
  }))
  on('fs.exists', () => ({ value: false }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('store.get', () => ({ value: [] }))
  on('store.set', () => {
    settled()

    return { value: undefined }
  })
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout:
        verbOf(e.argv) === 'rev-parse'
          ? '/work'
          : verbOf(e.argv) === 'diff'
          ? 'diff --git a/src/other.ts b/src/other.ts\n+ added'
          : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('model.complete', ($, e) => {
    prompts.push(e.prompt)

    return {
      value: {
        isAnswered: true,
        text: answer('patterns', 'Hand-rolled what the codebase has a helper for', 'high', 'src/helpers.ts'),
        usage: USAGE,
      },
    }
  })

  await $.session.start({
    surface: 'terminal',
    isInteractive: true,
    cwd: '/work',
  })

  const roster = await $.command.run({
    command: 'backseat',
    args: 'lanes',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  // The lane came from outside the repository, and the roster says so.
  expect(roster.text).toContain('patterns')
  expect(roster.text).toContain('machine-wide')
  expect(roster.text).toContain("also on agents' turns")

  await $.tool.call({
    tool: 'Write',
    file_path: 'src/other.ts',
    content: 'export const x = 1',
  })
  await $.turn.complete({
    turnId: 't1',
    answer: 'done',
    durationMs: 10,
    isAborted: false,
    usage: undefined,
    reason: 'answer',
  })

  await stored

  // It ran alongside the three configured lanes, carrying the standing
  // instructions from the file outside the repository.
  expect(prompts.length).toBe(4)
  expect(
    prompts.some(prompt => prompt.includes('establishes the pattern')),
  ).toBe(true)

  const listed = await $.command.run({
    command: 'backseat',
    args: '',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  expect(listed.text).toContain('Hand-rolled what the codebase has a helper for')
})

test('/backseat lane adds a reviewer for this session, and --clear takes it away', async ($, on) => {
  const prompts: string[] = []
  const saved: unknown[] = []

  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-lane' }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('tool.call', () => ({ result: 'ok' }))
  on('store.get', () => ({ value: [] }))
  on('store.set', ($, e) => {
    saved.push(e.value)

    return { value: undefined }
  })
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout:
        verbOf(e.argv) === 'rev-parse'
          ? '/work'
          : verbOf(e.argv) === 'diff'
          ? 'diff --git a/src/db.ts b/src/db.ts\n+ added'
          : verbOf(e.argv) === 'ls-files'
            ? ''
            : 'src/db.ts\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('model.complete', ($, e) => {
    prompts.push(e.prompt)

    return {
      value: {
        isAnswered: true,
        text: 'CLEAN',
        usage: USAGE,
      },
    }
  })

  await $.session.start({
    surface: 'terminal',
    isInteractive: true,
    cwd: '/work',
  })

  const added = await $.command.run({
    command: 'backseat',
    args: 'lane sql Did this change add a query inside a loop?',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  expect(added.text).toContain('sql')
  expect(added.text).toContain('query inside a loop')

  const roster = await $.command.run({
    command: 'backseat',
    args: 'lanes',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  expect(roster.text).toContain('this session only')

  // The lane runs on the next review, asking its own question.
  await $.command.run({
    command: 'backseat',
    args: 'review --lanes sql',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('query inside a loop')

  // It is stored under this session's key, so a reload keeps it.
  expect(JSON.stringify(saved)).toContain('query inside a loop')

  const gone = await $.command.run({
    command: 'backseat',
    args: 'lane sql --clear',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  expect(gone.text).toContain('removed')

  const after = await $.command.run({
    command: 'backseat',
    args: 'lanes',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  expect(after.text).not.toContain('this session only')

  const missing = await $.command.run({
    command: 'backseat',
    args: 'lane sql --clear',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  expect(missing.text).toContain('No session lane')
})

test("a lane whose provider fails is answered by its fallback, and says so", async ($, on) => {
  const asked: string[] = []

  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-fallback' }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', ($, e) => ({
    value:
      e.path === '/work/.backseat/lanes'
        ? [
            {
              name: 'boundary.md',
              kind: 'file' as const,
              size: 10,
              mtimeMs: 1,
              isLink: false,
            },
          ]
        : [],
  }))
  on('fs.read', () => ({
    value: [
      '---',
      'provider: codex',
      'fallback: kimi',
      'question: Does this weaken the boundary?',
      '---',
      'Name the file and the line.',
    ].join('\n'),
  }))
  on('store.get', () => ({ value: [] }))
  on('store.set', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    const verb = verbOf(e.argv)

    if (verb === 'rev-parse') {
      return {
        value: {
          exitCode: 0,
          stdout: '/work',
          stderr: '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    }

    if (e.argv[0] === 'git') {
      return {
        value: {
          exitCode: 0,
          stdout:
            verb === 'diff'
              ? 'diff --git a/src/a.ts b/src/a.ts\n+ added'
              : verb === 'ls-files'
                ? ''
                : 'src/a.ts\n',
          stderr: '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    }

    asked.push(e.argv[0] ?? '')

    // The first provider is spent; the second answers. This is the shape of a
    // usage limit, which silences a reviewer without saying so.
    if (e.argv[0] === 'codex') {
      return {
        value: {
          exitCode: 1,
          stdout: '',
          stderr: "You've hit your usage limit.",
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    }

    return {
      value: {
        exitCode: 0,
        stdout: answer('boundary', 'The default is permissive', 'high', 'src/a.ts'),
        stderr: '',
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

  const roster = await $.command.run({
    command: 'backseat',
    args: 'lanes',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  expect(roster.text).toContain('falls back to kimi')

  await $.command.run({
    command: 'backseat',
    args: 'review --lanes boundary',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  const listed = await $.command.run({
    command: 'backseat',
    args: '',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  // Both providers were asked, in order, and the finding is attributed to the
  // one that actually answered rather than to the one the roster names.
  expect(asked).toEqual(['codex', 'kimi'])
  expect(listed.text).toContain('answered by kimi, its fallback')
  expect(listed.text).toContain('The default is permissive')
})

test('a lane that answers clean is never charged to a second provider', async ($, on) => {
  const asked: string[] = []

  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-noretry' }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', ($, e) => ({
    value:
      e.path === '/work/.backseat/lanes'
        ? [
            {
              name: 'boundary.md',
              kind: 'file' as const,
              size: 10,
              mtimeMs: 1,
              isLink: false,
            },
          ]
        : [],
  }))
  on('fs.read', () => ({
    value: [
      '---',
      'provider: codex',
      'fallback: kimi',
      'question: Does this weaken the boundary?',
      '---',
      'Name the file and the line.',
    ].join('\n'),
  }))
  on('store.get', () => ({ value: [] }))
  on('store.set', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    const verb = verbOf(e.argv)

    if (e.argv[0] === 'git') {
      return {
        value: {
          exitCode: 0,
          stdout:
            verb === 'rev-parse'
              ? '/work'
              : verb === 'diff'
                ? 'diff --git a/src/a.ts b/src/a.ts\n+ added'
                : verb === 'ls-files'
                  ? ''
                  : 'src/a.ts\n',
          stderr: '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    }

    asked.push(e.argv[0] ?? '')

    return {
      value: {
        exitCode: 0,
        stdout: 'CLEAN',
        stderr: '',
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
  await $.command.run({
    command: 'backseat',
    args: 'review --lanes boundary',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  // Clean is a complete review, not a reason to spend a second provider.
  expect(asked).toEqual(['codex'])
})

test('a turn that commits its own work is still reviewed', async ($, on) => {
  let settled: () => void = () => undefined
  const stored = new Promise<void>(resolve => {
    settled = resolve
  })
  const ran: string[][] = []
  const BASE = 'baa5eed0000000000000000000000000000000d'

  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-committed' }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('store.get', () => ({ value: [] }))
  on('store.set', () => {
    settled()

    return { value: undefined }
  })
  on('process.run', ($, e) => {
    ran.push([...e.argv])

    const verb = verbOf(e.argv)

    return {
      value: {
        exitCode: 0,
        stdout:
          verb === 'rev-parse'
            ? `/work\n${BASE}`
            : verb === 'diff'
              ? 'diff --git a/src/a.ts b/src/a.ts\n+ committed in this very turn'
              : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('model.complete', () => ({
    value: { isAnswered: true, text: 'CLEAN', usage: USAGE },
  }))

  await $.session.start({
    surface: 'terminal',
    isInteractive: true,
    cwd: '/work',
  })
  await $.tool.call({
    tool: 'Edit',
    file_path: 'src/a.ts',
    old_string: 'was',
    new_string: 'is',
  })
  await $.turn.complete({
    turnId: 't1',
    answer: 'Edited and committed src/a.ts',
    durationMs: 10,
    isAborted: false,
    usage: undefined,
    reason: 'answer',
  })

  await stored

  // The commit the repository was on when the turn first wrote is what the
  // diff is taken against. A session that commits its own work leaves nothing
  // for a diff against the current HEAD, so reviewing against HEAD would
  // report every such turn as clean while reviewing nothing at all.
  const diff = ran.find(argv => verbOf(argv) === 'diff') ?? []

  expect(diff).toContain(BASE)
  expect(diff).not.toContain('HEAD')

  // The baseline is read once, with one call answering both the root and the
  // commit, before anything can commit over it.
  const asked = ran.filter(argv => verbOf(argv) === 'rev-parse')

  expect(asked.length).toBeGreaterThan(0)
  expect(asked[0]).toContain('--show-toplevel')
  expect(asked[0]).toContain('HEAD')
})

test('a turn with no diff to take spends no provider and does not read as clean', async ($, on) => {
  let asked = 0

  on('command.register', () => ({ value: { command: 'backseat' } }))
  on('session.id', () => ({ value: 'session-nodiff' }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('tool.call', () => ({ result: 'ok' }))
  on('store.get', () => ({ value: [] }))
  on('store.set', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    const verb = verbOf(e.argv)

    // The files are named as changed, and yet no diff can be taken for them —
    // which is what a path outside every repository looks like.
    return {
      value: {
        exitCode: 0,
        stdout:
          verb === 'rev-parse'
            ? '/work\ndeadbee'
            : verb === 'diff' && e.argv.includes('--name-only')
              ? 'src/a.ts'
              : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('model.complete', () => {
    asked += 1

    return { value: { isAnswered: true, text: 'CLEAN', usage: USAGE } }
  })

  await $.session.start({
    surface: 'terminal',
    isInteractive: true,
    cwd: '/work',
  })
  await $.command.run({
    command: 'backseat',
    args: 'review --base deadbee',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  const listed = await $.command.run({
    command: 'backseat',
    args: '',
    origin: ORIGIN,
    presentation: PRESENTATION,
  })

  // No evidence means no review. Asking anyway spends a provider per lane to
  // be told nothing is wrong, and records a clean review of nothing — which
  // reads exactly like a working panel that found your code faultless.
  expect(asked).toBe(0)
  expect(listed.text).toContain('skipped')
  expect(listed.text).toContain('nothing to review')
})

test(
  'a compaction hands back the conversation minus what was released',
  { options: { refine: 'on' } },
  async ($, on) => {
    on('command.register', () => ({ value: { command: 'backseat' } }))
    on('session.id', () => ({ value: 'session-refine' }))
    on('ui.log', () => ({ value: undefined }))
    on('session.start', () => ({ cwd: '/work' }))
    on('fs.list', () => ({ value: [] }))
    on('fs.exists', () => ({ value: false }))
    on('store.get', () => ({ value: [] }))
    on('store.set', () => ({ value: undefined }))

    // Twenty identical calls carrying a large body, then forty small messages
    // so the newest-forty anchor does not cover the repeats.
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
    const messages = [...repeated, ...recent]

    const done = await $.session.compact({ trigger: 'manual', messages })

    // The nineteen repeats behind the anchor are released; the first call that
    // established the output stays, and so does everything recent.
    expect(done.skip).toBe(undefined)
    // Exactly the forty recent messages and the first call, which established
    // the output the other nineteen repeated.
    expect((done.messages ?? []).length).toBe(41)
    // Every surviving recent message is the engine's own, by handle.
    expect(
      (done.messages ?? []).filter(one => one.handle?.startsWith('r')).length,
    ).toBe(40)
  },
)

test(
  'a refinement that would leave the conversation over the window lets the engine summarise',
  { options: { refine: 'on' } },
  async ($, on) => {
    // Measured on a live session: a /compact refined 1,347,635 tokens to
    // 1,233,175 in a 1,000,000-token window, and every prompt after it was
    // refused "Prompt is too long" without being sent.
    on('command.register', () => ({ value: { command: 'backseat' } }))
    on('session.id', () => ({ value: 'session-over-window' }))
    on('session.compact', () => ({ skip: 'the engine summarised' }))
    on('session.usage', () => ({
      value: {
        startedAt: 0,
        context: { percent: 134, window: 1_000_000, tokens: 1_347_635 },
        rateLimits: [],
      },
    }))
    on('ui.log', () => ({ value: undefined }))
    on('session.start', () => ({ cwd: '/work' }))
    on('fs.list', () => ({ value: [] }))
    on('fs.exists', () => ({ value: false }))
    on('store.get', () => ({ value: [] }))
    on('store.set', () => ({ value: undefined }))

    // The same rows the floor test below installs on the engine's trigger.
    const repeated = Array.from({ length: 20 }, (_, at) => ({
      role: 'assistant' as const,
      text: '',
      toolUses: [
        {
          tool_use_id: `u${at}`,
          tool: 'Bash',
          input: { command: `cargo build ${'x'.repeat(100)}` },
        },
      ],
      handle: `h${at}`,
    }))
    const recent = Array.from({ length: 40 }, (_, at) => ({
      role: 'assistant' as const,
      text: 'y'.repeat(1080),
      toolUses: [],
      handle: `r${at}`,
    }))

    const done = await $.session.compact({
      trigger: 'manual',
      messages: [...repeated, ...recent],
    })

    expect(done.skip).toBe('the engine summarised')
  },
)

test(
  'the engine\'s own compaction installs a reduction a requested one would not',
  { options: { refine: 'on' } },
  async ($, on) => {
    // Against leaving the conversation alone, a small reduction is not worth a
    // compaction. Against the engine's summary it is: the summary is a
    // paraphrase of everything, and every survivor here is kept verbatim.
    // Measured on real sessions at one bar for both: 8.5%, 4.5%, 1.0% and 0.9%
    // were all refused and summarised instead.
    on('command.register', () => ({ value: { command: 'backseat' } }))
    on('session.id', () => ({ value: 'session-floor' }))
    // Beneath the plugins: what the engine does when the panel stands aside.
    on('session.compact', () => ({ skip: 'the engine summarised' }))
    on('ui.log', () => ({ value: undefined }))
    on('session.start', () => ({ cwd: '/work' }))
    on('fs.list', () => ({ value: [] }))
    on('fs.exists', () => ({ value: false }))
    on('store.get', () => ({ value: [] }))
    on('store.set', () => ({ value: undefined }))

    // Twenty identical calls, then forty recent messages nine times their size,
    // which puts the reduction between the two floors.
    const repeated = Array.from({ length: 20 }, (_, at) => ({
      role: 'assistant' as const,
      text: '',
      toolUses: [
        {
          tool_use_id: `u${at}`,
          tool: 'Bash',
          input: { command: `cargo build ${'x'.repeat(100)}` },
        },
      ],
      handle: `h${at}`,
    }))
    const recent = Array.from({ length: 40 }, (_, at) => ({
      role: 'assistant' as const,
      text: 'y'.repeat(1080),
      toolUses: [],
      handle: `r${at}`,
    }))
    const messages = [...repeated, ...recent]

    const engine = await $.session.compact({ trigger: 'auto', messages })

    expect(engine.skip).toBe(undefined)
    expect((engine.messages ?? []).length).toBe(41)

    const requested = await $.session.compact({ trigger: 'precompute', messages })

    expect(requested.skip).not.toBe(undefined)
  },
)
