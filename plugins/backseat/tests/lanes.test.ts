import { expect, test } from 'claude-code/testing'

import type { Lane } from '../hooks/config'
import { read as readConfig } from '../hooks/config'
import { SUBCOMMANDS, parseArgs } from '../hooks/args'
import { inputsFor, promptFor, wavesOf } from '../hooks/lanes'
import {
  claimedChars,
  cleanerTask,
  redact,
  redactWindow,
  summaryLine,
  windowsOf,
} from '../hooks/cleaner'
import {
  combine,
  measure,
  namesIn,
  printOf,
  reachedBy,
  rehydrationFor,
  releases,
  repeatedCalls,
  residueOf,
  KEPT_HEAD,
  KEPT_TAIL,
  shortened,
  matchedBy,
  survivorsOf,
  tiersOf,
  worthInstalling,
} from '../hooks/refine'
import { listing } from '../hooks/report'
import { rank } from '../hooks/verdict'
import {
  isLaneFile,
  laneFrom,
  allowsProject,
  lanesForTurn,
  mergeLanes,
  nameOf,
  sessionLaneOf,
} from '../hooks/lanefile'
import {
  absolute,
  byRepo,
  dirOf,
  laneDirsFor,
  laneRootOf,
} from '../hooks/evidence'
import {
  FLAT_WAIT_MS,
  firstLine,
  invocationFor,
  invocationFromTemplate,
  isAtLimit,
  reasonOf,
  templatesFrom,
  isSpentWait,
  COMPACT_SPENT_WAIT_MS,
  waitFrom,
} from '../hooks/providers'
import type { Finding } from '../hooks/verdict'

/**
 * One lane, with the fields a test is not asserting on filled in.
 *
 * @param over the fields this lane is about
 * @returns a complete lane
 */
function lane(over: Partial<Lane>): Lane {
  const name = over.name ?? 'spec'

  return {
    group: name,
    reviewers: [],
    name,
    question: 'a question?',
    instructions: '',
    provider: 'fork',
    command: '',
    model: '',
    docs: [],
    needs: [],
    minConfidence: 0.6,
    severityFloor: '',
    scope: 'project',
    onAgents: false,
    fallback: '',
    fallbackCommand: '',
    sees: ['diff'],
    on: 'turn',
    ...over,
    // After the spread: an override carrying the key with no value would
    // otherwise leave a lane with no projects, which every caller reads.
    projects: over.projects ?? [],
  }
}

/**
 * One finding attributed to a lane, for the evidence selector.
 *
 * @param from the lane that reported it
 * @param title the finding's title
 * @returns a complete finding
 */
function finding(from: string, title: string): Finding {
  return {
    lane: from,
    alsoFrom: [],
    severity: 'high',
    title,
    body: 'b',
    file: 'src/a.ts',
    lineStart: 1,
    lineEnd: 1,
    confidence: 0.9,
    recommendation: '',
    reference: 'r',
  }
}

test('a lane file sets every field, and its body becomes the instructions', () => {
  const read = laneFrom(
    'perf',
    [
      '---',
      'provider: kimi',
      'model: kimi-k2-thinking',
      'question: Did this change add work to a hot path?',
      'docs: docs/perf-budget.md, docs/hot-paths.md',
      'needs: reuse, spec',
      'severity: high',
      'confidence: 0.75',
      '---',
      'Treat anything under `src/render/` as a hot path.',
      '',
      'A finding needs a named caller.',
    ].join('\n'),
    { provider: 'fork', confidence: 0.6, scope: 'project', fallback: '' },
  )

  expect(read.problems).toEqual([])
  expect(read.lane?.name).toBe('perf')
  expect(read.lane?.provider).toBe('kimi')
  expect(read.lane?.model).toBe('kimi-k2-thinking')
  expect(read.lane?.question).toBe('Did this change add work to a hot path?')
  expect(read.lane?.docs).toEqual(['docs/perf-budget.md', 'docs/hot-paths.md'])
  expect(read.lane?.needs).toEqual(['reuse', 'spec'])
  expect(read.lane?.severityFloor).toBe('high')
  expect(read.lane?.minConfidence).toBe(0.75)
  expect(read.lane?.instructions).toContain('src/render/')
  expect(read.lane?.instructions).toContain('a named caller')
})

test('a lane file inherits the provider and confidence it does not set', () => {
  const read = laneFrom(
    'naming',
    ['---', 'question: Are the names right?', '---', ''].join('\n'),
    { provider: 'codex', confidence: 0.42, scope: 'user', fallback: '' },
  )

  expect(read.lane?.provider).toBe('codex')
  expect(read.lane?.minConfidence).toBe(0.42)
  expect(read.lane?.severityFloor).toBe('')
  expect(read.lane?.needs).toEqual([])
})

test('a lane file with no question, or parked, defines no lane', () => {
  const silent = laneFrom(
    'x',
    ['---', 'provider: fork', '---', 'body'].join('\n'),
    {
      provider: 'fork',
      confidence: 0.6,
      scope: 'project',
      fallback: '',
    },
  )

  expect(silent.lane).toBeUndefined()
  expect(silent.problems.join(' ')).toContain('no question')

  const parked = laneFrom(
    'x',
    ['---', 'question: anything?', 'enabled: false', '---', 'body'].join('\n'),
    { provider: 'fork', confidence: 0.6, scope: 'project', fallback: '' },
  )

  expect(parked.lane).toBeUndefined()
  expect(parked.problems).toEqual([])

  // It names what it parked, because the only thing that can take a lane off
  // the roster is the merge, and the merge has to be told the name.
  expect(parked.parked).toBe('x')
})

test('a misspelled field is reported, not ignored', () => {
  // A silently ignored "sevrity" would read as a lane with no floor, which is
  // a lane that reports more than it was asked to.
  const read = laneFrom(
    'x',
    ['---', 'question: anything?', 'sevrity: high', '---', ''].join('\n'),
    { provider: 'fork', confidence: 0.6, scope: 'project', fallback: '' },
  )

  expect(read.lane).toBeDefined()
  expect(read.problems.join(' ')).toContain('unknown field "sevrity"')

  const bad = laneFrom(
    'x',
    ['---', 'question: anything?', 'severity: urgent', '---', ''].join('\n'),
    { provider: 'fork', confidence: 0.6, scope: 'project', fallback: '' },
  )

  expect(bad.problems.join(' ')).toContain('is not a severity')
  expect(bad.lane?.severityFloor).toBe('')
})

test('a file with no frontmatter is reported', () => {
  const read = laneFrom('x', 'just prose, no fence\n', {
    provider: 'fork',
    confidence: 0.6,
    scope: 'project',
    fallback: '',
  })

  expect(read.lane).toBeUndefined()
  expect(read.problems.join(' ')).toContain('no --- frontmatter')
})

test('lane files are recognised by name', () => {
  expect(isLaneFile('perf.md')).toBe(true)
  expect(isLaneFile('.perf.md.swp')).toBe(false)
  expect(isLaneFile('notes.txt')).toBe(false)
  expect(nameOf('perf.md')).toBe('perf')
})

test('waves come from needs, and a lane never runs before what it reads', () => {
  const waves = wavesOf(
    [
      lane({ name: 'docs', needs: ['spec', 'reuse'] }),
      lane({ name: 'spec' }),
      lane({ name: 'reuse' }),
    ],
    true,
  )

  expect(waves.length).toBe(2)
  expect(waves[0]?.map(entry => entry.name).sort()).toEqual(['reuse', 'spec'])
  expect(waves[1]?.map(entry => entry.name)).toEqual(['docs'])
})

test('a lane needing a lane that is off is not stranded', () => {
  // Turning `reuse` off must not silently stop `docs` from reviewing.
  const waves = wavesOf(
    [lane({ name: 'docs', needs: ['spec', 'reuse'] }), lane({ name: 'spec' })],
    true,
  )

  expect(waves.map(wave => wave.map(entry => entry.name))).toEqual([
    ['spec'],
    ['docs'],
  ])
})

test('a needs cycle still runs, in one final wave', () => {
  const waves = wavesOf(
    [lane({ name: 'a', needs: ['b'] }), lane({ name: 'b', needs: ['a'] })],
    true,
  )

  expect(waves.length).toBe(1)
  expect(waves[0]?.map(entry => entry.name).sort()).toEqual(['a', 'b'])
})

test('crossLink off puts every lane in one wave', () => {
  const waves = wavesOf(
    [lane({ name: 'docs', needs: ['spec'] }), lane({ name: 'spec' })],
    false,
  )

  expect(waves.length).toBe(1)
  expect(waves[0]?.length).toBe(2)
})

test('a lane is given only the findings of the lanes it names', () => {
  const results = [
    { lane: 'spec', findings: [finding('spec', 'from spec')] },
    { lane: 'reuse', findings: [finding('reuse', 'from reuse')] },
    { lane: 'perf', findings: [finding('perf', 'from perf')] },
  ]

  const forDocs = inputsFor(lane({ name: 'docs', needs: ['reuse'] }), results)

  expect(forDocs.map(entry => entry.title)).toEqual(['from reuse'])

  // A lane that reads nobody gets nothing, so the cross-link is a named edge
  // rather than a broadcast of every earlier finding.
  expect(inputsFor(lane({ name: 'spec' }), results)).toEqual([])
})

test("a lane's instructions reach its prompt, above the output contract", () => {
  const prompt = promptFor(
    lane({
      name: 'perf',
      question: 'Did this change add work to a hot path?',
      instructions: 'Treat anything under `src/render/` as a hot path.',
    }),
    {
      purpose: '',
      diff: 'diff --git a/x b/x',
      paths: ['x'],
      docs: [],
      earlier: [],
      isDiffTruncated: false,
    },
  )

  expect(prompt).toContain('<your_standing_instructions>')
  expect(prompt).toContain('Treat anything under `src/render/` as a hot path.')
  expect(prompt).toContain('Did this change add work to a hot path?')
  expect(prompt.indexOf('<your_standing_instructions>')).toBeLessThan(
    prompt.indexOf('<output_contract>'),
  )
})

test('a lane with no instructions gets no instruction block', () => {
  const prompt = promptFor(lane({}), {
    purpose: '',
    diff: 'd',
    paths: ['x'],
    docs: [],
    earlier: [],
    isDiffTruncated: false,
  })

  expect(prompt).not.toContain('<your_standing_instructions>')
})

test('a provider template becomes an argv, with the prompt as one argument', () => {
  const run = invocationFromTemplate(
    'gemini -m {model} -p {prompt}',
    'review this change',
    '/plugin/schema.json',
    'gemini-3-pro',
  )

  expect(run?.argv).toEqual([
    'gemini',
    '-m',
    'gemini-3-pro',
    '-p',
    'review this change',
  ])
  // The prompt rode in argv, so standard input stays empty.
  expect(run?.stdin).toBe('')
})

test('a template with no {prompt} sends the prompt on standard input', () => {
  const run = invocationFromTemplate(
    'ollama run {model}',
    'review this change',
    '/plugin/schema.json',
    'qwen3',
  )

  expect(run?.argv).toEqual(['ollama', 'run', 'qwen3'])
  expect(run?.stdin).toBe('review this change')
})

test('a model flag is dropped when the lane names no model', () => {
  // Sending `-m ""` makes every CLI complain about a bad flag, so the pair
  // goes rather than the value being empty.
  const run = invocationFromTemplate(
    'gemini -m {model} -p {prompt}',
    'p',
    '/s.json',
    '',
  )

  expect(run?.argv).toEqual(['gemini', '-p', 'p'])
})

test('a template can carry the answer schema', () => {
  const run = invocationFromTemplate(
    'codex exec --output-schema {schema} -',
    'p',
    '/plugin/schema.json',
    '',
  )

  expect(run?.argv).toEqual([
    'codex',
    'exec',
    '--output-schema',
    '/plugin/schema.json',
    '-',
  ])
  expect(run?.stdin).toBe('p')
})

test('named provider templates are read, and a malformed one is reported', () => {
  const read = templatesFrom([
    'gemini = gemini -m {model} -p {prompt}',
    'ollama run {model}',
  ])

  expect(read.templates.get('gemini')).toBe('gemini -m {model} -p {prompt}')
  expect(read.problems.length).toBe(1)
  expect(read.problems[0]).toContain('is not name = command')
})

test('the purpose reaches every lane prompt, above the instructions', () => {
  const prompt = promptFor(
    lane({ instructions: 'Treat src/render/ as hot.' }),
    {
      purpose: 'Add caching to /ask without changing its response shape.',
      diff: 'd',
      paths: ['x'],
      docs: [],
      earlier: [],
      isDiffTruncated: false,
    },
  )

  expect(prompt).toContain('<purpose_of_this_work>')
  expect(prompt).toContain(
    'Add caching to /ask without changing its response shape.',
  )
  // A change that serves the stated purpose is not drift, and the prompt says so.
  expect(prompt).toContain('is not drift because it is not what')
  expect(prompt.indexOf('<purpose_of_this_work>')).toBeLessThan(
    prompt.indexOf('<your_standing_instructions>'),
  )
})

test('a provider named only by a template is not rejected before the template is read', () => {
  // Only the lane loader has the templates, so config must not pre-judge a
  // provider name: rejecting it here would silently drop a lane that a
  // `providers` entry defines perfectly well.
  const read = readConfig({
    lanes: 'spec',
    provider: 'gemini',
    providers: 'gemini = gemini -p {prompt}',
  })

  expect(read.lanes.length).toBe(1)
  expect(read.lanes[0]?.provider).toBe('gemini')
  expect(read.providers).toEqual(['gemini = gemini -p {prompt}'])
})

test('a lane whose provider is off is still dropped', () => {
  const read = readConfig({ lanes: 'spec, reuse', specProvider: 'off' })

  expect(read.lanes.map(entry => entry.name)).toEqual(['reuse'])
})

test("a lane file can put a reviewer on subagents' turns", () => {
  const read = laneFrom(
    'patterns',
    [
      '---',
      'question: Does this follow the patterns this code is written in?',
      'agents: true',
      '---',
      'Name the file and line that establishes the pattern.',
    ].join('\n'),
    { provider: 'claude', confidence: 0.6, scope: 'user', fallback: '' },
  )

  expect(read.problems).toEqual([])
  expect(read.lane?.onAgents).toBe(true)
  expect(read.lane?.scope).toBe('user')

  // A lane that only reviews the main loop is the default, because most
  // reviewers are about the work the person asked for.
  const quiet = laneFrom(
    'perf',
    ['---', 'question: Is this hot?', '---', ''].join('\n'),
    { provider: 'claude', confidence: 0.6, scope: 'project', fallback: '' },
  )

  expect(quiet.lane?.onAgents).toBe(false)

  const bad = laneFrom(
    'perf',
    ['---', 'question: Is this hot?', 'agents: sometimes', '---', ''].join('\n'),
    { provider: 'claude', confidence: 0.6, scope: 'project', fallback: '' },
  )

  expect(bad.problems.join(' ')).toContain('is not true or false')
  expect(bad.lane?.onAgents).toBe(false)
})

test('a more specific tier replaces a lane of the same name, whole', () => {
  const merged = mergeLanes([
    {
      scope: 'user',
      lanes: [
        lane({
          name: 'patterns',
          scope: 'user',
          question: 'the machine-wide question',
          instructions: 'the machine-wide instructions',
          onAgents: true,
        }),
        lane({ name: 'naming', scope: 'user' }),
      ],
    },
    {
      scope: 'config',
      lanes: [lane({ name: 'patterns', scope: 'config' })],
    },
    {
      scope: 'project',
      lanes: [
        lane({
          name: 'patterns',
          scope: 'project',
          question: 'this repository asks it differently',
          instructions: '',
          onAgents: false,
        }),
      ],
    },
  ])

  const byName = new Map(merged.lanes.map(entry => [entry.name, entry]))

  expect(merged.lanes.length).toBe(2)

  // The repository's lane wins whole: it does not inherit the machine-wide
  // instructions or reach, because a half-overridden reviewer is one nobody
  // wrote.
  expect(byName.get('patterns')?.question).toBe(
    'this repository asks it differently',
  )
  expect(byName.get('patterns')?.instructions).toBe('')
  expect(byName.get('patterns')?.onAgents).toBe(false)

  // A machine-wide lane the repository says nothing about still runs.
  expect(byName.get('naming')?.scope).toBe('user')

  // The replacement is reported, so the roster can say why.
  expect(merged.notes.join(' ')).toContain('patterns')
  expect(merged.notes.join(' ')).toContain('project')
})

test("a subagent's turn is reviewed only by the lanes that asked for it", () => {
  const roster = [
    lane({ name: 'spec', onAgents: false }),
    lane({ name: 'patterns', onAgents: true }),
  ]

  expect(lanesForTurn(roster, '').map(entry => entry.name)).toEqual([
    'spec',
    'patterns',
  ])
  expect(lanesForTurn(roster, 'agent-1').map(entry => entry.name)).toEqual([
    'patterns',
  ])

  // Nothing asked for subagents, so a subagent's turn is reviewed by nobody
  // rather than by everybody.
  expect(lanesForTurn([lane({ onAgents: false })], 'agent-1')).toEqual([])
})

test("a session lane takes the panel's own provider and floor", () => {
  const made = sessionLaneOf('sql', 'Did this add an N+1 query?', true, {
    provider: 'codex',
    confidence: 0.75,
    fallback: 'kimi',
  })

  expect(made.scope).toBe('session')
  expect(made.provider).toBe('codex')
  expect(made.minConfidence).toBe(0.75)
  expect(made.onAgents).toBe(true)
  expect(made.fallback).toBe('kimi')
  expect(made.question).toBe('Did this add an N+1 query?')
  expect(made.needs).toEqual([])
})

test('a project file parks a machine-wide lane of the same name', () => {
  const merged = mergeLanes([
    {
      scope: 'user',
      lanes: [
        lane({ name: 'patterns', scope: 'user' }),
        lane({ name: 'naming', scope: 'user' }),
      ],
    },
    { scope: 'project', lanes: [], parked: ['patterns'] },
  ])

  // `enabled: false` in this repository takes the machine-wide lane off this
  // repository's roster without editing the file every other one reads.
  expect(merged.lanes.map(entry => entry.name)).toEqual(['naming'])
  expect(merged.notes.join(' ')).toContain('parks the user lane')

  // A tier above the parking defines it again, so it is back on.
  const again = mergeLanes([
    { scope: 'user', lanes: [lane({ name: 'patterns', scope: 'user' })] },
    { scope: 'project', lanes: [], parked: ['patterns'] },
    {
      scope: 'session',
      lanes: [lane({ name: 'patterns', scope: 'session' })],
    },
  ])

  expect(again.lanes.map(entry => entry.scope)).toEqual(['session'])
})

test('changed files are grouped by the repository that holds them', () => {
  // A tree of repositories side by side, with no repository at its root: a
  // diff taken at the root would see nothing at all.
  const roots = new Map([
    ['/fleet/alpha/src', '/fleet/alpha'],
    ['/fleet/beta/lib', '/fleet/beta'],
  ])
  const grouped = byRepo(roots, [
    '/fleet/alpha/src/a.ts',
    '/fleet/beta/lib/b.ts',
    '/fleet/alpha/src/c.ts',
    '/fleet/loose/d.ts',
  ])

  expect([...grouped.keys()].sort()).toEqual(['/fleet/alpha', '/fleet/beta'])
  expect(grouped.get('/fleet/alpha')).toEqual([
    '/fleet/alpha/src/a.ts',
    '/fleet/alpha/src/c.ts',
  ])

  // A file git reports no repository for contributes no evidence, rather than
  // a diff of whichever tree happened to be nearby.
  expect([...grouped.values()].flat()).not.toContain('/fleet/loose/d.ts')
})

test('a path is resolved before it is grouped', () => {
  expect(absolute('/work', 'src/a.ts')).toBe('/work/src/a.ts')
  expect(absolute('/work', './src/a.ts')).toBe('/work/src/a.ts')
  expect(absolute('/work/', 'src/a.ts')).toBe('/work/src/a.ts')
  expect(absolute('/work', '/elsewhere/a.ts')).toBe('/elsewhere/a.ts')
  expect(dirOf('/work/src/a.ts')).toBe('/work/src')
  expect(dirOf('a.ts')).toBe('.')
})

test('lane directories are inherited from the tree above the work', () => {
  const dirs = laneDirsFor(
    '/home/me/fleet/alpha/sub',
    '/home/me',
    '.backseat/lanes',
  )

  // Outermost first, so the nearest directory is merged last and wins; and
  // the walk stops at the person's own directory rather than climbing out of
  // it.
  expect(dirs).toEqual([
    '/home/me/.backseat/lanes',
    '/home/me/fleet/.backseat/lanes',
    '/home/me/fleet/alpha/.backseat/lanes',
    '/home/me/fleet/alpha/sub/.backseat/lanes',
  ])

  // An absolute lane directory names only itself, and an unknown working
  // directory still reads the relative one.
  expect(laneDirsFor('/home/me/x', '/home/me', '/etc/lanes')).toEqual([
    '/etc/lanes',
  ])
  expect(laneDirsFor('', '/home/me', '.backseat/lanes')).toEqual([
    '.backseat/lanes',
  ])
  expect(laneDirsFor('/home/me/x', '/home/me', '')).toEqual([])
})

test("an inherited lane's documents belong to the tree it was written for", () => {
  // A lane beside a tree of repositories names that tree's documents. Resolved
  // against the session instead, every repository but one would silently find
  // nothing where its governing design should be.
  expect(laneRootOf('/home/me/fleet/.backseat/lanes', '.backseat/lanes')).toBe(
    '/home/me/fleet',
  )
  expect(
    laneRootOf('/home/me/fleet/alpha/.backseat/lanes', '.backseat/lanes'),
  ).toBe('/home/me/fleet/alpha')

  // A lane directory that is not the configured one resolves against itself,
  // which is the only answer available for a machine-wide lane.
  expect(laneRootOf('/home/me/.claude/backseat/lanes', '.backseat/lanes')).toBe(
    '/home/me/.claude/backseat/lanes',
  )
  expect(laneRootOf('.backseat/lanes', '.backseat/lanes')).toBe(
    '.backseat/lanes',
  )
})

test("a provider's flags are placed after its subcommand, never before it", () => {
  const run = invocationFor('codex', 'review this', '/plugin/schema.json', 'gpt-5')

  // `--output-schema` and `-m` belong to the `exec` subcommand. Placed ahead
  // of it they are read by the top-level parser, which rejects them as
  // unknown — indistinguishable from a CLI that does not support them.
  expect(run?.argv).toEqual([
    'codex',
    'exec',
    '--sandbox',
    'read-only',
    '--ephemeral',
    '--skip-git-repo-check',
    '--color',
    'never',
    '-m',
    'gpt-5',
    '--output-schema',
    '/plugin/schema.json',
    '-',
  ])

  // The word that means "read the prompt from standard input" stays last, and
  // the prompt itself never rides in argv.
  expect(run?.argv[run.argv.length - 1]).toBe('-')
  expect(run?.stdin).toBe('review this')

  // A provider with no subcommand is unaffected, and takes its prompt as an
  // argument after its own words.
  const kimi = invocationFor('kimi', 'review this', '/plugin/schema.json', '')

  expect(kimi?.argv).toEqual([
    'kimi',
    '--output-format',
    'text',
    '-p',
    'review this',
  ])
  expect(kimi?.stdin).toBe('')
})

test("a lane's instructions settle its scope, not only its question", () => {
  const prompt = promptFor(
    lane({
      question: 'Does this change reorder the confinement steps?',
      instructions: 'Also report a breach that is returned as a success.',
    }),
    {
      purpose: '',
      diff: 'd',
      paths: ['x'],
      docs: [],
      earlier: [],
      isDiffTruncated: false,
    },
  )

  // Told to judge "only against that question", a reviewer reasons its way out
  // of a defect its instructions describe but the wording misses, and says so
  // while reporting nothing. Every sentence of a lane's instructions is then
  // dead text unless the question enumerates it.
  expect(prompt).not.toContain('Judge only that change, against that question.')
  expect(prompt).toContain('as your standing instructions define')
  expect(prompt).toContain('never out of scope')
  expect(prompt).toContain('anything they tell you to look for is yours to report')
})

test('the answer shape is the last thing the prompt asks for', () => {
  const prompt = promptFor(lane({}), {
    purpose: '',
    diff: 'diff --git a/x b/x',
    paths: ['x'],
    docs: [{ path: 'docs/spec.md', text: 'a long specification' }],
    earlier: [],
    isDiffTruncated: false,
  })

  // A provider answers against what it read most recently. With the contract
  // in the middle, the diff and the documents come after it and compete with
  // it, and a reviewer that found the right defect but described it in prose
  // is reported as a provider that could not answer.
  expect(prompt.trimEnd().endsWith('</answer_now>')).toBe(true)
  expect(prompt.indexOf('<output_contract>')).toBeLessThan(
    prompt.indexOf('<diff>'),
  )
  expect(prompt.indexOf('<diff>')).toBeLessThan(prompt.indexOf('<answer_now>'))
})

test('a lane naming several reviewers asks each of them the same question', () => {
  const read = laneFrom(
    'sequence',
    [
      '---',
      'question: Does this weaken the confinement contract?',
      'reviewers: codex, kimi',
      'needs: standing',
      '---',
      'Name the step and the line.',
    ].join('\n'),
    { provider: 'claude', confidence: 0.6, scope: 'project', fallback: '' },
  )

  expect(read.problems).toEqual([])
  expect(read.lane?.reviewers).toEqual(['codex', 'kimi'])
})

test('a needs edge reaches every reviewer a lane was expanded into', () => {
  // Expanded, the reviewers are separate lanes sharing one name. An edge
  // naming that name must reach all of them, and must not let a reader run
  // before the slowest of them has answered.
  const waves = wavesOf(
    [
      lane({ name: 'seq:codex', group: 'seq' }),
      lane({ name: 'seq:kimi', group: 'seq' }),
      lane({ name: 'parity', group: 'parity', needs: ['seq'] }),
    ],
    true,
  )

  expect(waves.length).toBe(2)
  expect(waves[0]?.map(entry => entry.name).sort()).toEqual([
    'seq:codex',
    'seq:kimi',
  ])
  expect(waves[1]?.map(entry => entry.name)).toEqual(['parity'])

  // And it is given what each of them found.
  const forParity = inputsFor(lane({ name: 'parity', needs: ['seq'] }), [
    { lane: 'seq:codex', findings: [finding('seq:codex', 'from codex')] },
    { lane: 'seq:kimi', findings: [finding('seq:kimi', 'from kimi')] },
    { lane: 'other', findings: [finding('other', 'unrelated')] },
  ])

  expect(forParity.map(entry => entry.title).sort()).toEqual([
    'from codex',
    'from kimi',
  ])
})

test('two reviewers of one question that agree become one finding naming both', () => {
  const ranked = rank(
    [
      {
        lane: 'seq:codex',
        outcome: 'findings' as const,
        summary: '',
        detail: '',
        latencyMs: 1,
        via: '',
        notes: '',
        findings: [
          {
            ...finding('seq:codex', 'Breach reported as success'),
            severity: 'high' as const,
            reference: 'src/run.rs',
            confidence: 0.8,
            recommendation: '',
          },
        ],
      },
      {
        lane: 'seq:kimi',
        outcome: 'findings' as const,
        summary: '',
        detail: '',
        latencyMs: 1,
        via: '',
        notes: '',
        findings: [
          {
            ...finding('seq:kimi', 'Ceiling breach returns Completed'),
            severity: 'critical' as const,
            reference: 'src/run.rs',
            confidence: 0.95,
            recommendation: 'Return the breach.',
          },
        ],
      },
    ],
    new Set<string>(),
  )

  // Agreement between two reviewers of the same question is evidence, so it
  // is one card carrying both names, the worse severity and the better fix —
  // not the same problem drawn twice.
  expect(ranked.length).toBe(1)
  expect(ranked[0]?.severity).toBe('critical')
  expect(ranked[0]?.confidence).toBe(0.95)
  expect(ranked[0]?.recommendation).toBe('Return the breach.')
  expect([ranked[0]?.lane, ...(ranked[0]?.alsoFrom ?? [])].sort()).toEqual([
    'seq:codex',
    'seq:kimi',
  ])
})

test("a provider's quota refusal is reported as the refusal, not as its banner", () => {
  // Measured output of `kimi --output-format text -p …` with the five-hour
  // window spent. The banner is the first line, so a detail built from the
  // first line names the version and nothing a person can act on, and a
  // reviewer that was turned away reads as a reviewer that broke.
  const kimi = [
    'kimi version 2.1.1',
    'error: failed to run prompt: provider.auth_error: 403 You',
    'See log: /Users/x/.kimi-code/logs/kimi-code.log',
  ].join('\n')

  expect(firstLine(kimi)).toBe('kimi version 2.1.1')
  expect(reasonOf('', kimi)).toBe(
    'error: failed to run prompt: provider.auth_error: 403 You',
  )
})

test('a cause stated after a narrating CLI is the line that is quoted', () => {
  // Measured output of `codex exec …` out of credit: the hook progress this
  // machine's codex prints comes first and carries no cause, and the refusal
  // is last. Taking the last line that states a cause finds it either way.
  const codex = [
    'hook: UserPromptSubmit Completed',
    'hook: UserPromptSubmit Completed',
    "ERROR: You've hit your usage limit. Try again at 4:42 PM.",
  ].join('\n')

  expect(reasonOf('', codex)).toBe(
    "ERROR: You've hit your usage limit. Try again at 4:42 PM.",
  )
})

test('a failure that states no cause is quoted by its last line', () => {
  // Nothing here carries a cause, so the choice is between the first line and
  // the last. The last is the one that describes where the run got to.
  expect(reasonOf('', 'codex-cli 0.0.0\nstarting\nstopped at step 2')).toBe(
    'stopped at step 2',
  )
  expect(reasonOf('', '')).toBe('no output')
})

test('standard error is read ahead of standard output for the cause', () => {
  // A CLI that separates the streams puts the cause on standard error, and a
  // banner it printed to standard output must not outrank it.
  expect(reasonOf('error: not signed in', 'codex-cli 0.0.0')).toBe(
    'error: not signed in',
  )
})

test("a spent usage limit is recognised in each provider's own wording", () => {
  // Both measured on this machine. The panel has to tell these apart from an
  // ordinary failure, because a limit refuses the next lane in the same
  // second and an ordinary failure may not.
  expect(
    isAtLimit(
      "ERROR: You've hit your usage limit. Upgrade to Pro, visit " +
        'https://chatgpt.com/codex/settings/usage to purchase more credits',
    ),
  ).toBe(true)
  expect(
    isAtLimit(
      'error: failed to run prompt: provider.auth_error: 403 You have ' +
        'reached your 5-hour usage limit.',
    ),
  ).toBe(true)
  expect(isAtLimit('429 Too Many Requests')).toBe(true)
  expect(isAtLimit('quota exhausted for this project')).toBe(true)
})

test('an ordinary failure is not read as a spent limit', () => {
  // A sign-in that expired, a missing binary and a timeout are all worth a
  // retry and a fallback. Reading them as a limit would park the provider for
  // the cooldown and skip every lane that uses it.
  expect(isAtLimit('error: not signed in; run `codex login`')).toBe(false)
  expect(isAtLimit('kimi: command not found')).toBe(false)
  expect(isAtLimit('timed out after 300000ms')).toBe(false)
  expect(isAtLimit('error: failed to parse the output schema')).toBe(false)
})

test("a lane's notes carry what the reviewer said under its row", () => {
  // A reviewer that answered in prose has still answered. The row says the
  // lane failed to parse; the note is the only place its words survive.
  const text = listing(
    [
      {
        lane: 'far-sequence',
        outcome: 'failed' as const,
        findings: [],
        summary: '',
        detail: 'the answer was not in a shape with findings in it',
        latencyMs: 2100,
        via: '',
        notes: 'The ordering looks wrong around run_guest, but I am not sure.',
      },
    ],
    [],
    0,
  )

  expect(text).toContain('far-sequence: failed')
  expect(text).toContain(
    'The ordering looks wrong around run_guest, but I am not sure.',
  )
})

test('a lane nobody could ask reports as skipped, with the account named', () => {
  // Skipped, not failed, and not clean: no reviewer looked at this change.
  // A clean here would be the panel approving work it never read.
  const text = listing(
    [
      {
        lane: 'far-sequence',
        outcome: 'skipped' as const,
        findings: [],
        summary: '',
        detail: 'codex and kimi are both at their usage limit',
        latencyMs: 0,
        via: '',
        notes: "ERROR: You've hit your usage limit. Try again at 4:42 PM.",
      },
    ],
    [],
    0,
  )

  expect(text).toContain('skipped')
  expect(text).toContain('both at their usage limit')
  expect(text).toContain('Try again at 4:42 PM.')
})

/**
 * One transcript message, as the cleaner's windowing reads them.
 *
 * @param index the message's position
 * @param chars how much text it holds
 * @param opensTurn whether it begins a user turn
 * @returns the entry
 */
function flat(lines: readonly string[]): string {
  return lines.join(' ').replace(/\s+/gu, ' ')
}

function entry(index: number, chars: number, opensTurn = false) {
  return { index, role: opensTurn ? 'user' : 'assistant', text: 'x'.repeat(chars), chars, opensTurn }
}

test('a window closes at a turn boundary rather than at the budget', () => {
  // The boundary at 3 is inside the budget and 4 would overflow it, so the
  // window closes at 3. Closing at 4 would put a tool call in one window and
  // its result in the next, and ask a reviewer to judge an action whose
  // outcome it cannot see.
  const windows = windowsOf(
    [entry(0, 30), entry(1, 30), entry(2, 30), entry(3, 30, true), entry(4, 30)],
    100,
  )

  expect(windows.length).toBe(2)
  expect(windows[0]?.fromIndex).toBe(0)
  expect(windows[0]?.toIndex).toBe(2)
  expect(windows[1]?.fromIndex).toBe(3)
  expect(windows[1]?.toIndex).toBe(4)
})

test('a turn larger than the budget is still asked about', () => {
  // No boundary exists inside the run, so the window closes at the budget. The
  // alternative is a window that never closes and a transcript never reviewed.
  const windows = windowsOf([entry(0, 500), entry(1, 500), entry(2, 500)], 600)

  expect(windows.length).toBeGreaterThan(1)
  expect(windows[0]?.fromIndex).toBe(0)
  expect(windows.at(-1)?.toIndex).toBe(2)
})

test('every message lands in at least one window', () => {
  // A dropped message is a stretch nobody reviewed, and that is silent, so the
  // cover is asserted. Windows may repeat a message: that is the overlap.
  const entries = Array.from({ length: 40 }, (_, at) => entry(at, 25, at % 7 === 0))
  const seen = new Set(
    windowsOf(entries, 100).flatMap(window => window.entries.map(one => one.index)),
  )

  expect([...seen].sort((a, b) => a - b)).toEqual(entries.map(one => one.index))
})

test('a window reaches back over the one before it', () => {
  // Without the reach, a result superseded by a read on the other side of a
  // boundary is reported by neither window: neither holds both halves.
  const entries = Array.from({ length: 60 }, (_, at) => entry(at, 25, at % 9 === 0))
  const windows = windowsOf(entries, 300, 150)

  expect(windows.length).toBeGreaterThan(1)

  for (let at = 1; at < windows.length; at += 1) {
    const previous = new Set(windows[at - 1]!.entries.map(one => one.index))
    const shared = windows[at]!.entries.filter(one => previous.has(one.index))

    expect(shared.length).toBeGreaterThan(0)
  }
})

test('an overlap never stops a window advancing', () => {
  // An overlap at or above the budget would advance a window by nothing and
  // ask it forever, so the reach is bounded by the window's own opening.
  const entries = Array.from({ length: 30 }, (_, at) => entry(at, 50, false))
  const windows = windowsOf(entries, 100, 10_000)

  expect(windows.length).toBeLessThan(40)
  expect(windows.at(-1)?.toIndex).toBe(29)

  for (let at = 1; at < windows.length; at += 1) {
    expect(windows[at]!.fromIndex).toBeGreaterThan(windows[at - 1]!.fromIndex)
  }
})

test('a window knows how many there are, for the prompt', () => {
  // The reviewer is told which window of how many it has, so it does not spend
  // its answer reporting that the rest of the session is not in front of it.
  const windows = windowsOf([entry(0, 50), entry(1, 50, true), entry(2, 50)], 60)

  expect(windows.every(window => window.count === windows.length)).toBe(true)
  // The task block is a list of lines and the sentence wraps across them, so
  // it is read the way a provider reads it: joined, with its spacing flattened.
  expect(flat(cleanerTask('tidy', 'What is superseded?', windows[1]!))).toContain(
    `window 2 of ${windows.length}`,
  )
})

test('the transcript is evidence and its requests are not instructions', () => {
  // A transcript is the one evidence full of instructions: every user turn in
  // it is one. A reviewer that acted on them would take its orders from the
  // thing it is reviewing.
  const task = flat(cleanerTask('tidy', 'What is superseded?', windowsOf([entry(0, 10)], 100)[0]!))

  expect(task).toContain('not reviewing the code')
  expect(task).toContain('never reclaimable')
})

test('a reclaim is counted from the messages named, not from a stated figure', () => {
  // The saving is the thing being proposed, so a reviewer's own arithmetic
  // about it is not evidence for it.
  const entries = [entry(0, 100), entry(1, 250), entry(2, 400)]

  expect(claimedChars(entries, [1, 2])).toBe(650)
  expect(claimedChars(entries, [])).toBe(0)
  expect(claimedChars(entries, [99])).toBe(0)
  // A message named by two overlapping windows is still one message.
  expect(claimedChars(entries, [1, 1, 1])).toBe(250)
})

test('the summary says what was read when a run did not finish', () => {
  expect(summaryLine(1000, 250, 4, 4)).toContain('across 4 window(s)')
  expect(summaryLine(1000, 250, 4, 2)).toContain('across 2 of 4 window(s)')
  expect(summaryLine(1000, 250, 4, 4)).toContain('(25%)')
})

test('a lane sees the diff and runs on a turn unless it says otherwise', () => {
  // The default is the behaviour every existing lane file already relies on,
  // so adding the field changed nothing for any of them.
  const read = laneFrom(
    'naming',
    ['---', 'question: Are the names right?', '---', ''].join('\n'),
    { provider: 'codex', confidence: 0.5, scope: 'user', fallback: '' },
  )

  expect(read.lane?.sees).toEqual(['diff'])
  expect(read.lane?.on).toBe('turn')
})

test('a lane that reads the transcript waits to be asked', () => {
  // Its evidence is the session rather than the turn, so running it on every
  // turn would cost more than the work being reviewed. The default is the
  // cheap one; the file can still say `on: turn`.
  const read = laneFrom(
    'tidy',
    [
      '---',
      'provider: kimi',
      'fallback: off',
      'sees: transcript',
      'question: What no longer needs to stay in this session?',
      '---',
      '',
    ].join('\n'),
    { provider: 'codex', confidence: 0.5, scope: 'user', fallback: 'codex' },
  )

  expect(read.lane?.sees).toEqual(['transcript'])
  expect(read.lane?.on).toBe('ask')
  expect(read.lane?.provider).toBe('kimi')
  expect(read.lane?.fallback).toBe('off')
})

test('a lane may read both, which is a mixed role rather than a third kind', () => {
  const read = laneFrom(
    'standing',
    [
      '---',
      'sees: diff, transcript',
      'on: turn',
      'question: Was a standing rule broken?',
      '---',
      '',
    ].join('\n'),
    { provider: 'codex', confidence: 0.5, scope: 'user', fallback: '' },
  )

  expect(read.lane?.sees).toEqual(['diff', 'transcript'])
  expect(read.lane?.on).toBe('turn')
})

test('an unreadable sight is the default, not a problem', () => {
  // A lane whose evidence could not be read would otherwise be a lane that
  // silently reviews nothing, which is the failure this panel exists to avoid.
  const read = laneFrom(
    'odd',
    ['---', 'sees: sideways', 'question: Is it right?', '---', ''].join('\n'),
    { provider: 'codex', confidence: 0.5, scope: 'user', fallback: '' },
  )

  expect(read.lane?.sees).toEqual(['diff'])
  expect(read.lane?.on).toBe('turn')
})

test('only a lane that waits to be asked is held back from a turn', () => {
  const roster = [
    lane({ name: 'a', on: 'turn' }),
    lane({ name: 'b', on: 'ask' }),
  ]

  expect(lanesForTurn(roster, '').map(one => one.name)).toEqual(['a'])
})

test('secret-shaped values are replaced before a window is sent', () => {
  // A transcript is uncurated: it holds whatever a tool printed, including the
  // contents of a .env a command happened to read.
  const cases: readonly [string, string][] = [
    ['export API_KEY=sk-abcdefghijklmnopqrstuvwxyz123', '[redacted key]'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz', 'Bearer [redacted]'],
    ['aws_key AKIAIOSFODNN7EXAMPLE here', '[redacted key]'],
    ['token=ghp_abcdefghijklmnopqrstuvwxyz0123', '[redacted token]'],
    ['postgres://user:hunter2@db.internal/app', 'user:[redacted]@'],
    ['password: "correct-horse-battery"', '[redacted]'],
  ]

  for (const [input, expected] of cases) {
    const out = redact(input)

    expect(out.count).toBeGreaterThan(0)
    expect(out.text).toContain(expected)
  }
})

test('a redaction keeps the name beside the value it replaced', () => {
  // `api_key: [redacted]` still tells a reviewer what the line was. A line
  // replaced whole would read as a message that said nothing.
  const out = redact('api_key: abcdefghijklmnop')

  expect(out.text).toContain('api_key')
  expect(out.text).not.toContain('abcdefghijklmnop')
})

test('ordinary code is not mistaken for a secret', () => {
  // A pattern that matched ordinary code would hide the evidence the question
  // is about, which is worse than sending a value that was not a secret.
  for (const line of [
    'const total = subtotal + tax',
    'git commit --only src/run.rs',
    'read the file at packages/core/src/policy.ts',
    'if (count > 8) { return undefined }',
  ]) {
    expect(redact(line).count).toBe(0)
  }
})

test('a redacted window keeps the character counts it was measured at', () => {
  // The counts are what the window costs in the session. A reclaim figure
  // quoted against a redacted length would understate what removing it saves.
  const base = windowsOf(
    [
      { index: 0, role: 'user', text: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123', chars: 40, opensTurn: true },
      { index: 1, role: 'assistant', text: 'ordinary text', chars: 13, opensTurn: false },
    ],
    10_000,
  )[0]!
  const sent = redactWindow(base)

  expect(sent.redactions).toBe(1)
  expect(sent.window.entries[0]?.chars).toBe(40)
  expect(sent.window.entries[0]?.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123')
  expect(sent.window.entries[1]?.text).toBe('ordinary text')
})

test('a lane naming no project runs anywhere', () => {
  // Every lane written before the field existed is unchanged by it.
  expect(allowsProject(lane({ projects: [] }), '/Users/x/anything', '/Users/x')).toBe(true)
})

test('a lane naming projects runs only under one of them', () => {
  const scoped = lane({ projects: ['~/acme', '/opt/work'] })

  expect(allowsProject(scoped, '/Users/x/acme', '/Users/x')).toBe(true)
  expect(allowsProject(scoped, '/Users/x/acme/api', '/Users/x')).toBe(true)
  expect(allowsProject(scoped, '/opt/work/thing', '/Users/x')).toBe(true)
  expect(allowsProject(scoped, '/Users/x/Private', '/Users/x')).toBe(false)
  expect(allowsProject(scoped, '/Users/x/acme-other', '/Users/x')).toBe(false)
  expect(allowsProject(scoped, '', '/Users/x')).toBe(false)
})

test('what a session returns to is never reclaimable, whatever its age', () => {
  // An error, a measurement and the person's own words outrank every other
  // rule: they are what a session comes back for.
  const entries = [
    entry(0, 20, true),
    { index: 1, role: 'assistant', text: 'Traceback: the build failed', chars: 27, opensTurn: false },
    { index: 2, role: 'assistant', text: 'measured 213726ms across 4 windows', chars: 34, opensTurn: false },
    { index: 3, role: 'assistant', text: 'ordinary narration about nothing', chars: 32, opensTurn: false },
    entry(4, 20),
  ]
  const verdicts = tiersOf(entries, 1)
  const by = new Map(verdicts.map(one => [one.index, one]))

  expect(by.get(0)?.tier).toBe('never')
  // A failure is not protected for being one: most did not matter, and one
  // that still does is in the newest messages, which are never released.
  expect(by.get(1)?.tier).not.toBe('never')
  expect(by.get(2)?.tier).toBe('never')
  expect(by.get(2)?.because).toContain('measurement')
})

test('the current work reaches back through the names it uses', () => {
  // The deterministic half of the newest-anchored framing: rather than ask
  // whether the session moved past a message, see whether it still points at
  // it. Wrong only in the safe direction.
  const entries = [
    { index: 0, role: 'assistant', text: 'read packages/core/src/policy.ts', chars: 32, opensTurn: false },
    { index: 1, role: 'assistant', text: 'unrelated chatter here entirely', chars: 31, opensTurn: false },
    { index: 2, role: 'assistant', text: 'editing packages/core/src/policy.ts now', chars: 39, opensTurn: false },
  ]
  const reached = reachedBy(entries, 1)

  expect(reached.has(0)).toBe(true)
  expect(reached.has(1)).toBe(false)
})

test('short words do not make everything reachable from everything', () => {
  // A transcript shares its ordinary English with every message in it.
  expect(namesIn('the cat sat on a mat and was glad').size).toBe(0)
  expect(namesIn('see packages/core/src/policy.ts').has('packages/core/src/policy.ts')).toBe(true)
})

test('a call repeated with different numbers is one call, said twice', () => {
  // Tool inputs are the mass nothing else touches: a session that runs the
  // same script forty times carries it forty times.
  const entries = [
    { index: 0, role: 'assistant', text: 'Bash({"command":"python run.py --n 4"})', chars: 39, opensTurn: false },
    { index: 1, role: 'assistant', text: 'Bash({"command":"python run.py --n 8"})', chars: 39, opensTurn: false },
    { index: 2, role: 'assistant', text: 'Bash({"command":"git status"})', chars: 30, opensTurn: false },
  ]
  const repeats = repeatedCalls(entries)

  expect(repeats.get(1)).toBe(0)
  expect(repeats.has(2)).toBe(false)
  expect(repeats.has(0)).toBe(false)
})

test('only what no rule settled is worth a provider call', () => {
  const entries = [
    entry(0, 100, true),
    { index: 1, role: 'assistant', text: 'nothing notable in this message at all', chars: 2000, opensTurn: false },
    entry(2, 100),
  ]
  const verdicts = tiersOf(entries, 1)

  expect(residueOf(verdicts)).toEqual([1])
})

test('one framing can never let a message go', () => {
  // A call that merely looks finished and a call the work has moved past are
  // the same thing seen from one side.
  const weights = { recencyWeight: 0.5, dissent: 0.05, bar: 0.2 }
  const agreeing = combine({ callNeeded: 0.1, resultNeeded: 0.1 }, { callNeeded: 0.15, resultNeeded: 0.1 }, weights)
  const split = combine({ callNeeded: 0.1, resultNeeded: 0.1 }, { callNeeded: 0.9, resultNeeded: 0.9 }, weights)

  expect(agreeing?.agreed).toBe(true)
  expect(split?.agreed).toBe(false)
  expect(releases(agreeing, 0.2, false, 0.1)).toBe(true)
  expect(releases(split, 0.2, false, 0.1)).toBe(false)
  expect(releases(undefined, 0.2, false, 0.1)).toBe(false)
})

test('a judgement that agrees with the evidence needs less of itself', () => {
  // The bar moves when the rules already found what supersedes it.
  const weights = { recencyWeight: 0.5, dissent: 0.05, bar: 0.2 }
  const borderline = combine({ callNeeded: 0.25, resultNeeded: 0.25 }, { callNeeded: 0.25, resultNeeded: 0.25 }, weights)

  expect(releases(borderline, 0.2, false, 0.1)).toBe(false)
  expect(releases(borderline, 0.2, true, 0.1)).toBe(true)
})

test('a reclaimed message can be fetched back by reference', () => {
  // A reduction that cannot be undone is a bet. A reference makes it a lookup.
  const one = { index: 41, role: 'assistant', text: 'a long result body', chars: 18, opensTurn: false }
  const ref = rehydrationFor(one)

  expect(ref.ref).toContain('m41.')
  expect(ref.index).toBe(41)
  expect(ref.chars).toBe(18)
  // The fingerprint notices the text changing underneath the reference.
  expect(printOf('a long result body')).toBe(ref.print)
  expect(printOf('a long result bodY')).not.toBe(ref.print)
})

test('the measurement says how much the rules settled for nothing', () => {
  // The newest message is current work and so is never reclaimable; the
  // residue is the stretch behind it that no rule settled.
  const entries = [
    entry(0, 100, true),
    { index: 1, role: 'assistant', text: 'Traceback: it failed', chars: 300, opensTurn: false },
    { index: 2, role: 'assistant', text: 'plain narration of no consequence', chars: 600, opensTurn: false },
    { index: 3, role: 'assistant', text: 'still working', chars: 100, opensTurn: false },
  ]
  const measured = measure(entries, tiersOf(entries, 1))

  // The person's words and the newest message are never released; the
  // traceback and the narration are both ordinary material now.
  expect(measured.chars).toBe(1100)
  expect(measured.neverChars).toBe(200)
  expect(measured.residueChars).toBe(900)
  expect(measured.residueShare).toBe(82)
})

test('a short window does not reach back over almost all of itself', () => {
  // A fixed reach over a window that closed early at a turn boundary leaves
  // almost no advance, and the same transcript then makes many times the
  // windows, each one mostly the last. Measured at 65 windows for a
  // transcript that holds about ten.
  const entries = Array.from({ length: 300 }, (_, at) =>
    entry(at, 1_000, at % 3 === 0),
  )
  const windows = windowsOf(entries, 20_000, 18_000)
  const advances = windows
    .slice(1)
    .map((window, at) => window.fromIndex - windows[at]!.fromIndex)

  expect(windows.length).toBeLessThan(40)
  expect(Math.min(...advances)).toBeGreaterThan(1)
})

test('a name the whole transcript uses is not evidence of reach', () => {
  // Measured on a real session: matching on any shared name marked 68.9% of
  // it as reached, which left almost nothing to examine. A name that is
  // everywhere cannot single a message out.
  const common = 'packages/core/src/policy.ts'
  const entries = Array.from({ length: 80 }, (_, at) => ({
    index: at,
    role: 'assistant',
    text: at === 3 ? `rare-token-zqxj and ${common}` : `touching ${common}`,
    chars: 40,
    opensTurn: false,
  }))
  // The newest message names the rare token, so only message 3 is reached by
  // it; the common path reaches nothing because every message carries it.
  entries[79] = { ...entries[79]!, text: 'rare-token-zqxj again' }

  const reached = reachedBy(entries, 1)

  expect(reached.has(3)).toBe(true)
  expect(reached.has(10)).toBe(false)
})

/**
 * One message of the live conversation, as the survivor rules read it.
 */
function row(
  at: number,
  chars: number,
  over: Partial<{
    role: string
    text: string
    opensTurn: boolean
    uses: string[]
    results: string[]
    handle: string
  }> = {},
) {
  return {
    at,
    role: over.role ?? 'assistant',
    text: over.text ?? 'x'.repeat(chars),
    chars,
    opensTurn: over.opensTurn ?? false,
    uses: over.uses ?? [],
    results: over.results ?? [],
    handle: over.handle ?? `h${at}`,
  }
}

test('a tool call and its result are never separated', () => {
  // A result without its call is a conversation the engine cannot replay, and
  // a call whose result is gone is one the engine has no answer for. The pair
  // moves as one in both directions.
  const rows = [
    row(0, 50, { uses: ['t1'] }),
    row(1, 900, { role: 'user', results: ['t1'] }),
    row(2, 50, { opensTurn: true, role: 'user', text: 'the person speaks' }),
  ]
  // The rules released the result but not the call.
  const verdicts = rows.map(one => ({
    index: one.at,
    tier: one.at === 1 ? ('repeat' as const) : ('reached' as const),
    because: '',
    from: -1,
  }))

  const keep = survivorsOf(rows, verdicts, new Set(), 0)

  expect(keep.has(0)).toBe(keep.has(1))
})

test('reach does not hold an exchange its own pair was released from', () => {
  // Reach is a cheap guess that the newest messages still point at something.
  // Holding a pair because one half carries a shared name is what left the
  // rules freeing nothing: measured on two 1,200,000-character windows, 58%
  // and 60% of everything released came back this way.
  const rows = [
    row(0, 50, { uses: ['t1'] }),
    row(1, 900, { role: 'user', results: ['t1'] }),
    row(2, 50, { opensTurn: true, role: 'user', text: 'the person speaks' }),
  ]
  const verdicts = rows.map(one => ({
    index: one.at,
    tier: one.at === 1 ? ('repeat' as const) : ('reached' as const),
    because: '',
    from: -1,
  }))

  const keep = survivorsOf(rows, verdicts, new Set(), 0)

  expect(keep.has(0)).toBe(false)
  expect(keep.has(1)).toBe(false)
  expect(keep.has(2)).toBe(true)
})

test('what a session returns to holds its whole exchange', () => {
  // `never` is the one tier a release cannot reach through.
  const rows = [
    row(0, 50, { uses: ['t1'] }),
    row(1, 900, { role: 'user', results: ['t1'] }),
    row(2, 50),
  ]
  const verdicts = rows.map(one => ({
    index: one.at,
    tier: one.at === 0 ? ('never' as const) : ('repeat' as const),
    because: '',
    from: -1,
  }))

  const keep = survivorsOf(rows, verdicts, new Set(), 0)

  expect(keep.has(0)).toBe(true)
  expect(keep.has(1)).toBe(true)
})

test('a message carrying several calls goes only when every one of them may', () => {
  // Deciding each call against its own result separately drops `t1`'s result
  // while the message issuing `t1` stays for `t2` — a call the engine has no
  // answer for. The exchange is therefore every row a shared id reaches.
  const rows = [
    row(0, 50, { uses: ['t1', 't2'] }),
    row(1, 900, { role: 'user', results: ['t1'] }),
    row(2, 900, { role: 'user', results: ['t2'] }),
    row(3, 50),
  ]
  const verdicts = [
    { index: 0, tier: 'repeat' as const, because: '', from: -1 },
    { index: 1, tier: 'repeat' as const, because: '', from: -1 },
    { index: 2, tier: 'never' as const, because: '', from: -1 },
    { index: 3, tier: 'reached' as const, because: '', from: -1 },
  ]

  const keep = survivorsOf(rows, verdicts, new Set(), 0)

  expect(keep.has(0)).toBe(true)
  expect(keep.has(1)).toBe(true)
  expect(keep.has(2)).toBe(true)
})

test('a settling word that is everywhere stops singling a message out', () => {
  // A session whose subject is rulings says `ruling` in ordinary narration.
  // Measured on a 1,786-row window, the fixed list held 197 rows — 23.3% of
  // its characters — on the strength of `ruling` appearing 841 times.
  const common = Array.from({ length: 60 }, (_, at) => ({
    index: at,
    role: 'assistant',
    text: `the ruling here was ordinary narration number ${at}`,
    chars: 50,
    opensTurn: false,
  }))
  const verdicts = tiersOf(common, 1)
  const by = new Map(verdicts.map(one => [one.index, one]))

  expect(by.get(0)?.tier).not.toBe('never')

  // The same word stays evidence while it remains rare.
  const rare = Array.from({ length: 60 }, (_, at) => ({
    index: at,
    role: 'assistant',
    text: at === 0 ? 'the ruling was recorded' : `ordinary narration number ${at}`,
    chars: 50,
    opensTurn: false,
  }))
  const kept = new Map(tiersOf(rare, 1).map(one => [one.index, one]))

  expect(kept.get(0)?.tier).toBe('never')
  expect(kept.get(0)?.because).toContain('measurement')
})

test('both halves go when both were released', () => {
  const rows = [
    row(0, 50, { uses: ['t1'] }),
    row(1, 900, { role: 'user', results: ['t1'] }),
    row(2, 50),
  ]
  const verdicts = rows.map(one => ({
    index: one.at,
    tier: one.at === 2 ? ('reached' as const) : ('repeat' as const),
    because: '',
    from: -1,
  }))

  const keep = survivorsOf(rows, verdicts, new Set(), 0)

  expect(keep.has(0)).toBe(false)
  expect(keep.has(1)).toBe(false)
  expect(keep.has(2)).toBe(true)
})

test('the newest messages are never released, whatever the rules say', () => {
  const rows = [row(0, 100), row(1, 100), row(2, 100)]
  const verdicts = rows.map(one => ({
    index: one.at,
    tier: 'repeat' as const,
    because: '',
    from: -1,
  }))

  const keep = survivorsOf(rows, verdicts, new Set(), 2)

  expect(keep.has(0)).toBe(false)
  expect(keep.has(1)).toBe(true)
  expect(keep.has(2)).toBe(true)
})

test('residue goes only when a reviewer released that handle', () => {
  // The rules alone never remove what they could not settle. Only a reviewer's
  // agreement moves residue, and it is keyed by handle because a position
  // means nothing across a compaction.
  const rows = [row(0, 500, { handle: 'hA' }), row(1, 500, { handle: 'hB' }), row(2, 50)]
  const verdicts = rows.map(one => ({
    index: one.at,
    tier: one.at === 2 ? ('reached' as const) : ('residue' as const),
    because: '',
    from: -1,
  }))

  const keep = survivorsOf(rows, verdicts, new Set(['hA']), 0)

  expect(keep.has(0)).toBe(false)
  expect(keep.has(1)).toBe(true)
})

test('a refinement that frees almost nothing is not installed', () => {
  // It would have spent the compaction that summarises, for nothing.
  const rows = [row(0, 100), row(1, 9900)]

  expect(worthInstalling(rows, new Set([1]), 0.1)).toBe(false)
  expect(worthInstalling(rows, new Set([0]), 0.1)).toBe(true)
  expect(worthInstalling([], new Set(), 0.1)).toBe(false)
})

test('a long output is not immortalised by a word inside it', () => {
  // A short message saying a command failed is an error. A sixty-kilobyte log
  // that mentions the word once is an output that contains it, and protecting
  // that forever made 63% of a measured conversation unreclaimable.
  const short = {
    index: 0,
    role: 'assistant',
    text: 'the build failed',
    chars: 16,
    opensTurn: false,
  }
  const long = {
    index: 1,
    role: 'assistant',
    text: `${'log line\n'.repeat(900)}one step failed`,
    chars: 9_000,
    opensTurn: false,
  }
  const now = { index: 2, role: 'assistant', text: 'working', chars: 7, opensTurn: false }
  const by = new Map(tiersOf([short, long, now], 1).map(one => [one.index, one]))

  // Neither is protected now: the anchor covers a failure that still matters.
  expect(by.get(0)?.tier).not.toBe('never')
  expect(by.get(1)?.tier).not.toBe('never')
})

test('a large message is asked about even when the work reaches it', () => {
  // Reach settled 73% of a measured conversation and left 5% to examine,
  // because the large outputs all shared some name with current work. A
  // reclaim that pays for the question is exactly the one worth asking.
  const token = 'zqxj-rare-token'
  const small = {
    index: 0,
    role: 'assistant',
    text: `small mention of ${token}`,
    chars: 200,
    opensTurn: false,
  }
  const large = {
    index: 1,
    role: 'assistant',
    text: `${token} ${'payload '.repeat(100)}`,
    chars: 50_000,
    opensTurn: false,
  }
  const filler = Array.from({ length: 60 }, (_, at) => ({
    index: at + 2,
    role: 'assistant',
    text: 'unremarkable narration',
    chars: 22,
    opensTurn: false,
  }))
  const now = {
    index: 62,
    role: 'assistant',
    text: `still working on ${token}`,
    chars: 30,
    opensTurn: false,
  }
  const by = new Map(tiersOf([small, large, ...filler, now], 1).map(one => [one.index, one]))

  expect(by.get(0)?.tier).toBe('reached')
  expect(by.get(1)?.tier).toBe('residue')
})

test('every subcommand the help prints is one the parser accepts', () => {
  // `forget` was added to the type and to the table that says what it takes,
  // but a third hardcoded list decided what parsed — so the help printed it and
  // the parser refused it in the same breath. The list is now read off that
  // table, and this is what keeps the two from drifting apart again.
  for (const sub of SUBCOMMANDS) {
    const read = parseArgs(sub)

    expect(read.sub).toBe(sub)
    expect(read.problems).toEqual([])
  }

  // And a word that is not one is still refused, so the check above is not
  // passing by accepting everything.
  const bogus = parseArgs('frobnicate')

  expect(bogus.problems.length).toBeGreaterThan(0)

  // The one the help prints, specifically, with its words carried through.
  const forget = parseArgs('forget the 500s from the API')

  expect(forget.sub).toBe('forget')
  expect(forget.problems).toEqual([])
  expect(forget.rest).toBe('the 500s from the API')
})

test('a message the person named goes whatever tier the rules gave it', () => {
  // `/backseat forget` exists to drop what the rules protect: an API error is
  // kept by `tidy`'s own never-rule, and `survivorsOf` frees a residue row
  // only when a cleaner released its handle. Naming it overrules both.
  const rows = [
    { at: 0, role: 'user', text: 'do the thing', chars: 12, opensTurn: true, uses: [], results: [], handle: 'm0' },
    { at: 1, role: 'assistant', text: 'calling it', chars: 10, opensTurn: false, uses: [], results: [], handle: 'm1' },
    { at: 2, role: 'user', text: 'HTTP 500 from the API', chars: 21, opensTurn: false, uses: [], results: [], handle: 'm2' },
    { at: 3, role: 'assistant', text: 'moving on', chars: 9, opensTurn: false, uses: [], results: [], handle: 'm3' },
  ]
  const verdicts = rows.map(row => ({
    index: row.at,
    // The tier the rules would give it is the one this must ignore.
    tier: 'never' as const,
    because: 'a measurement or a decision',
    from: -1,
  }))

  // Nothing released and nothing named: everything stays.
  expect(survivorsOf(rows, verdicts, new Set(), 1).size).toBe(rows.length)

  // Named, and it goes.
  const keep = survivorsOf(rows, verdicts, new Set(), 1, new Set(['m2']))

  expect(keep.has(2)).toBe(false)
  expect(keep.has(3)).toBe(true)

  // Recency does not protect it either: what is asked about is usually among
  // the newest, so a request that spared them would spare its own subject.
  expect(survivorsOf(rows, verdicts, new Set(), 1, new Set(['m3'])).has(3)).toBe(
    false,
  )
  expect(survivorsOf(rows, verdicts, new Set(), 40, new Set(['m2'])).has(2)).toBe(
    false,
  )
})

test('quoted text is matched without any provider', () => {
  // The state a person is most likely to be in when they want a provider's
  // errors gone is the one where that provider is down. A description needs a
  // cleaner to interpret; text they can quote does not.
  const rows = [
    { at: 0, role: 'user', text: 'do it', chars: 5, opensTurn: true, uses: [], results: [], handle: 'm0' },
    { at: 1, role: 'user', text: 'API error: You have hit your weekly limit · resets 8am', chars: 54, opensTurn: false, uses: [], results: [], handle: 'm1' },
    { at: 2, role: 'assistant', text: 'safeguards stopped the response above · continuing once', chars: 55, opensTurn: false, uses: [], results: [], handle: 'm2' },
    { at: 3, role: 'assistant', text: 'the real work', chars: 13, opensTurn: false, uses: [], results: [], handle: 'm3' },
  ]

  // Word for word, case insensitively, and only what matches.
  const found = matchedBy(rows, ['API error:', 'SAFEGUARDS STOPPED'])

  expect([...found].sort()).toEqual(['m1', 'm2'])

  // An ask too short to be text is left to a cleaner, because a few characters
  // match most of a conversation.
  expect(matchedBy(rows, ['it']).size).toBe(0)
  expect(matchedBy(rows, []).size).toBe(0)

  // A row with no handle cannot be released, so it is never named.
  const unhandled = [{ ...rows[1]!, handle: '' }]

  expect(matchedBy(unhandled, ['API error:']).size).toBe(0)

  // The message carrying the ask contains the ask, so it matches itself. On a
  // live session the only twelve messages holding one were the twelve times it
  // had been typed: releasing those spends the ask on its own echo and leaves
  // what it named in place. The caller filters them out before matching, and
  // this is the shape it filters on.
  const echo = {
    at: 4,
    role: 'user',
    text: '/backseat forget API error: You have hit your weekly limit',
    chars: 58,
    opensTurn: true,
    uses: [],
    results: [],
    handle: 'm4',
  }

  expect(matchedBy([echo], ['API error:']).has('m4')).toBe(true)
  expect(
    matchedBy(
      [echo].filter(row => !row.text.includes('/backseat forget')),
      ['API error:'],
    ).size,
  ).toBe(0)

  // And what it finds goes, past the tier the rules gave it.
  const verdicts = rows.map(row => ({
    index: row.at,
    tier: 'never' as const,
    because: 'a measurement or a decision',
    from: -1,
  }))
  const keep = survivorsOf(rows, verdicts, new Set(), 1, found)

  expect(keep.has(1)).toBe(false)
  expect(keep.has(2)).toBe(false)
  expect(keep.has(3)).toBe(true)
})

test('a named result takes the call that produced it', () => {
  // An error is the result half of a pair. Releasing it while its call stays
  // leaves a call with no result, which is not a conversation the engine can
  // be handed back — so the pair goes together or not at all.
  const rows = [
    { at: 0, role: 'user', text: 'do it', chars: 5, opensTurn: true, uses: [], results: [], handle: 'm0' },
    { at: 1, role: 'assistant', text: 'calling', chars: 7, opensTurn: false, uses: ['c1'], results: [], handle: 'm1' },
    { at: 2, role: 'user', text: 'HTTP 500 from the API', chars: 21, opensTurn: false, uses: [], results: ['c1'], handle: 'm2' },
    { at: 3, role: 'assistant', text: 'moving on', chars: 9, opensTurn: false, uses: [], results: [], handle: 'm3' },
  ]
  const verdicts = rows.map(row => ({
    index: row.at,
    tier: 'never' as const,
    because: 'a measurement or a decision',
    from: -1,
  }))

  // The result is named; the call is not, and is both newer-than-nothing and
  // tiered never. It goes anyway, because the pair cannot be split.
  const keep = survivorsOf(rows, verdicts, new Set(), 1, new Set(['m2']))

  expect(keep.has(2)).toBe(false)
  expect(keep.has(1)).toBe(false)

  // Naming the call instead takes the result with it, for the same reason.
  const other = survivorsOf(rows, verdicts, new Set(), 1, new Set(['m1']))

  expect(other.has(1)).toBe(false)
  expect(other.has(2)).toBe(false)

  // Nothing else is touched.
  expect(keep.has(0)).toBe(true)
  expect(keep.has(3)).toBe(true)
})

test('a released giant keeps both of its ends instead of vanishing', () => {
  // 87 messages of 2,645 held half a measured conversation. Dropping one whole
  // loses the command and first lines that say what the output was; keeping it
  // whole frees nothing.
  const body = `$ cargo build --release\n${'warning: unused\n'.repeat(4000)}`
  const short = shortened(body, 'm41.ab12cd34')

  expect(short).toBeDefined()
  expect(short!.startsWith('$ cargo build --release')).toBe(true)
  expect(short!.length).toBeLessThan(body.length / 4)
  expect(short!).toContain('/backseat rehydrate m41.ab12cd34')
})

test('a result whose answer is its last line keeps that line', () => {
  // The reason the rules had to refuse every output ending in its own answer:
  // keeping only the opening dropped the line saying how it turned out, which
  // is the one a session comes back for — and those are most of the long
  // outputs worth reclaiming at all.
  const body = [
    '$ cargo test --all',
    'warning: unused\n'.repeat(4000),
    'error[E0425]: cannot find value `handle` in this scope',
    'test result: FAILED. 311 passed; 1 failed',
  ].join('\n')
  const short = shortened(body, 'm41.ab12cd34')

  expect(short).toBeDefined()
  expect(short!.startsWith('$ cargo test --all')).toBe(true)
  expect(short!).toContain('test result: FAILED. 311 passed; 1 failed')
  expect(short!).toContain('error[E0425]')
  expect(short!.length).toBeLessThan(body.length / 4)

  // What went is the middle, and the note says how much of it.
  expect(short!).toContain('from between them')
})

test('neither kept end is cut through a surrogate pair', () => {
  // A slice at a fixed character count can land between the halves of a pair,
  // which would leave an unpaired code unit at the join.
  const pairs = '\u{1f600}'.repeat(4000)
  const short = shortened(pairs, 'm1.aaaaaaaa')

  expect(short).toBeDefined()
  expect(/[\ud800-\udbff](?![\udc00-\udfff])/u.test(short!)).toBe(false)
  expect(/(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(short!)).toBe(false)
})

test('a message too small to gain from shortening is left whole', () => {
  // The note would cost most of what the cut saves.
  expect(shortened('x'.repeat(KEPT_HEAD), 'm1.aaaaaaaa')).toBeUndefined()
  expect(shortened('short', 'm1.aaaaaaaa')).toBeUndefined()
  expect(shortened('x'.repeat(KEPT_HEAD * 3), 'm1.aaaaaaaa')).toBeDefined()
})

test('a refusal that names its own window is waited out, not re-asked', () => {
  // Re-asking every fifteen minutes spends a process to be told the same thing
  // twenty times over a five-hour window.
  const kimi =
    "error: failed to run prompt: provider.api_error: 429 You've reached your" +
    ' 5-hour usage limit. Your quota will reset when the current 5-hour window ends.'

  expect(waitFrom(kimi)).toBe(5 * 3600000)

  // A refusal that says nothing about when it lifts keeps the flat wait.
  expect(waitFrom('error: request failed')).toBe(FLAT_WAIT_MS)
  expect(waitFrom('')).toBe(FLAT_WAIT_MS)

  // The words are the provider's, so a wait read from them is capped.
  expect(waitFrom('you have reached your 99-hour limit')).toBe(6 * 3600000)
})

test("the engine's own spent compaction is waited out, not asked once a turn", () => {
  // A compaction is run by the account running the session, not by a reviewer,
  // so it refuses for want of quota on its own account and refuses again in
  // the same second. The watcher asks once per turn above its mark, so without
  // a wait the refusal is re-earned on every turn until the limit lifts.
  //
  // Asserted here rather than through a session, because a `session.compact`
  // handler that raises does not reach `$.session.compact`'s caller with its
  // own message: the engine's own argument check answers first, so a session
  // cannot be made to produce the refusal this reads.
  const spentAt = 1_000_000

  expect(isSpentWait(spentAt, spentAt)).toBe(true)
  expect(isSpentWait(spentAt + COMPACT_SPENT_WAIT_MS - 1, spentAt)).toBe(true)

  // The wait having run out is what lets the next turn ask again.
  expect(isSpentWait(spentAt + COMPACT_SPENT_WAIT_MS, spentAt)).toBe(false)
  expect(isSpentWait(spentAt + COMPACT_SPENT_WAIT_MS + 1, spentAt)).toBe(false)

  // Nothing recorded is not a wait: a session that has never been refused asks
  // the first time it is full, and a clock reading zero is not a refusal.
  expect(isSpentWait(0, 0)).toBe(false)
  expect(isSpentWait(Date.now(), 0)).toBe(false)

  // The refusal that names a spent limit is the one worth recording, and the
  // engine's wording for it differs from any provider's.
  expect(
    isAtLimit("Error during compaction: You've hit your session limit · resets 2am"),
  ).toBe(true)
  expect(isAtLimit('Error during compaction: a turn is already running')).toBe(false)
})
