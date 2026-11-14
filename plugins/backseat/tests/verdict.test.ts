import { expect, test } from 'claude-code/testing'

import type { Finding, LaneResult } from '../hooks/verdict'
import { parse, rank, subjectOf, unsent } from '../hooks/verdict'

/**
 * One finding, with the fields a test is not asserting on filled in.
 *
 * @param over the fields this finding is about
 * @returns a complete finding
 */
function finding(over: Partial<Finding>): Finding {
  return {
    lane: 'spec',
    alsoFrom: [],
    severity: 'medium',
    title: 'a title',
    body: 'a body',
    file: 'src/thing.ts',
    lineStart: 1,
    lineEnd: 1,
    confidence: 0.9,
    recommendation: '',
    reference: '',
    ...over,
  }
}

/**
 * One lane result carrying the given findings.
 *
 * @param lane the reviewer's name
 * @param found what it reported
 * @returns the lane's result, as `rank` reads it
 */
function result(lane: string, found: readonly Finding[]): LaneResult {
  return {
    lane,
    outcome: found.length > 0 ? 'findings' : 'clean',
    findings: found,
    summary: '',
    detail: '',
    latencyMs: 1,
    via: '',
    notes: '',
  }
}

test('a JSON answer yields its findings', () => {
  const read = parse(
    'spec',
    JSON.stringify({
      verdict: 'findings',
      findings: [
        {
          severity: 'high',
          title: 'Contradicts the specification',
          body: 'The specification requires a floor',
          file: 'src/thing.ts',
          line_start: 10,
          line_end: 12,
          confidence: 0.9,
          recommendation: 'apply the floor',
          reference: 'docs/spec.md',
        },
      ],
    }),
    0.6,
  )

  expect(read.isAnswered).toBe(true)
  expect(read.findings.length).toBe(1)
  expect(read.findings[0]?.severity).toBe('high')
  expect(read.findings[0]?.lane).toBe('spec')
  expect(read.findings[0]?.reference).toBe('docs/spec.md')
})

test('a fenced JSON answer is unwrapped', () => {
  const read = parse(
    'reuse',
    '```json\n{"verdict":"findings","findings":[{"severity":"critical","title":"Duplicates parseThing","body":"b","file":"src/a.ts","line_start":3,"line_end":3,"confidence":0.8,"recommendation":"call it","reference":"src/parse.ts"}]}\n```',
    0.6,
  )

  expect(read.isAnswered).toBe(true)
  expect(read.findings[0]?.title).toBe('Duplicates parseThing')
})

test('the one-line form yields findings when a provider will not emit JSON', () => {
  const read = parse(
    'docs',
    [
      'Looked at the change.',
      'high | docs/design/x.md:4-9 | Says the store is a file | rewrite the storage section',
    ].join('\n'),
    0.6,
  )

  expect(read.isAnswered).toBe(true)
  expect(read.findings.length).toBe(1)
  expect(read.findings[0]?.file).toBe('docs/design/x.md')
  expect(read.findings[0]?.lineStart).toBe(4)
  expect(read.findings[0]?.lineEnd).toBe(9)
  expect(read.findings[0]?.recommendation).toBe('rewrite the storage section')
})

test('CLEAN is an answer, and noise is not', () => {
  const clean = parse('spec', 'CLEAN', 0.6)

  expect(clean.isAnswered).toBe(true)
  expect(clean.findings.length).toBe(0)

  // A provider that answered with prose has not reviewed anything. Reading
  // this as a clean review is the one failure that would make the panel
  // worse than no panel, so it is reported as unanswered instead.
  const noise = parse(
    'spec',
    'I had some trouble reaching the repository, sorry!',
    0.6,
  )

  expect(noise.isAnswered).toBe(false)
  expect(noise.detail).not.toBe('')
  // The provider's own last words, so a failure can be told apart from a
  // refusal, a sign-in prompt, or a finding in the wrong shape.
  expect(noise.detail).toContain('sorry')
})

test('a guess is dropped and a finding with no file is never built', () => {
  const guessed = parse(
    'spec',
    JSON.stringify({
      verdict: 'findings',
      findings: [
        {
          severity: 'high',
          title: 'Might be wrong',
          body: 'b',
          file: 'src/a.ts',
          line_start: 1,
          line_end: 1,
          confidence: 0.2,
          recommendation: '',
          reference: '',
        },
      ],
    }),
    0.6,
  )

  expect(guessed.isAnswered).toBe(true)
  expect(guessed.findings.length).toBe(0)

  const fileless = parse(
    'spec',
    JSON.stringify({
      verdict: 'findings',
      findings: [{ severity: 'high', title: 'Nowhere' }],
    }),
    0,
  )

  expect(fileless.findings.length).toBe(0)
})

test('a subject keyed on a reference ignores the line number and the wording', () => {
  const first = finding({
    lineStart: 10,
    lineEnd: 12,
    title: 'The store is described as a file',
    reference: 'docs/design/x.md',
  })
  const moved = finding({
    lineStart: 80,
    lineEnd: 84,
    title: 'the store, described as a FILE',
    reference: 'docs/design/x.md.',
  })

  // An edit above a finding moves it, and a reviewer rewords a standing
  // finding on every turn: neither makes it a new finding, and neither does
  // a full stop after the reference.
  expect(subjectOf(first)).toBe(subjectOf(moved))

  const elsewhere = finding({
    file: 'src/other.ts',
    reference: 'docs/design/x.md',
  })

  expect(subjectOf(first)).not.toBe(subjectOf(elsewhere))

  // Two lanes reaching the same problem from different questions share its
  // subject, so `rank` can merge them into one card instead of drawing one
  // problem twice.
  const otherLane = finding({ lane: 'reuse', reference: 'docs/design/x.md' })

  expect(subjectOf(first)).toBe(subjectOf(otherLane))

  const otherDoc = finding({ reference: 'docs/design/y.md' })

  expect(subjectOf(first)).not.toBe(subjectOf(otherDoc))
})

test('a subject with no reference falls back to the title, wording and all', () => {
  // Without a reference there is nothing else to key on, so two wordings of
  // one problem are two subjects. This is the cost of a reviewer that leaves
  // the field empty, and the reason the answer schema requires it.
  const asked = finding({
    title: 'The store is described as a file',
    reference: '',
  })
  const reworded = finding({
    title: 'The store is called a file',
    reference: '',
  })

  expect(subjectOf(asked)).not.toBe(subjectOf(reworded))

  const samePlace = finding({
    title: 'The store is described as a file.',
    reference: '',
  })

  expect(subjectOf(asked)).toBe(subjectOf(samePlace))
})

test('findings rank worst first, once each, and skip what was seen', () => {
  const ranked = rank(
    [
      result('spec', [
        finding({ severity: 'medium', reference: 'docs/spec.md' }),
      ]),
      result('reuse', [
        finding({
          lane: 'reuse',
          severity: 'critical',
          reference: 'src/parse.ts',
        }),
        finding({
          lane: 'reuse',
          severity: 'low',
          reference: 'src/parse.ts',
          confidence: 0.7,
        }),
      ]),
      result('docs', [
        finding({
          lane: 'docs',
          severity: 'high',
          reference: 'docs/design/x.md',
        }),
      ]),
    ],
    new Set<string>(),
  )

  expect(ranked.map(found => found.severity)).toEqual([
    'critical',
    'high',
    'medium',
  ])

  // The reuse lane reported one subject twice; the worse of the two is kept.
  expect(ranked.filter(found => found.lane === 'reuse').length).toBe(1)

  const seen = new Set([
    subjectOf(finding({ lane: 'reuse', reference: 'src/parse.ts' })),
  ])
  const after = rank(
    [
      result('reuse', [
        finding({
          lane: 'reuse',
          severity: 'critical',
          reference: 'src/parse.ts',
        }),
      ]),
    ],
    seen,
  )

  expect(after.length).toBe(0)
})

test('two lanes agreeing on one subject merge into one finding', () => {
  const ranked = rank(
    [
      result('spec', [
        finding({
          lane: 'spec',
          severity: 'medium',
          reference: 'src/parse.ts',
          title: 'A second parser',
          body: 'A second parser',
          recommendation: '',
          confidence: 0.7,
        }),
      ]),
      result('reuse', [
        finding({
          lane: 'reuse',
          severity: 'critical',
          reference: 'src/parse.ts',
          title: 'splitList duplicates parseList',
          body: 'It re-implements the same split and trim',
          recommendation: 'call parseList',
          confidence: 0.9,
        }),
      ]),
    ],
    new Set<string>(),
  )

  expect(ranked.length).toBe(1)

  // The worse report leads, and the other lane is named beside it.
  expect(ranked[0]?.lane).toBe('reuse')
  expect(ranked[0]?.alsoFrom).toEqual(['spec'])
  expect(ranked[0]?.severity).toBe('critical')
  expect(ranked[0]?.confidence).toBe(0.9)
  expect(ranked[0]?.recommendation).toBe('call parseList')
})

test('a merge takes a field the leading finding left empty', () => {
  const ranked = rank(
    [
      result('reuse', [
        finding({
          lane: 'reuse',
          severity: 'high',
          reference: 'src/parse.ts',
          title: 'Duplicate',
          body: 'Duplicate',
          recommendation: '',
          confidence: 0.9,
        }),
      ]),
      result('spec', [
        finding({
          lane: 'spec',
          severity: 'low',
          reference: 'src/parse.ts',
          title: 'Duplicate',
          body: 'The specification names one parser',
          recommendation: 'delete the second one',
          confidence: 0.6,
        }),
      ]),
    ],
    new Set<string>(),
  )

  expect(ranked.length).toBe(1)
  expect(ranked[0]?.lane).toBe('reuse')
  // The terse leader keeps its severity but gains the thorough follower's
  // body and fix, so merging never loses the more useful report.
  expect(ranked[0]?.severity).toBe('high')
  expect(ranked[0]?.body).toBe('The specification names one parser')
  expect(ranked[0]?.recommendation).toBe('delete the second one')
})

test('a CLEAN behind a CLI banner is still an answer, and prose still is not', () => {
  // Every CLI prints something of its own first. A clean review hidden behind
  // a version line would be reported as a broken provider, which is the one
  // misreading that makes the panel worse than no panel.
  const behind = parse('spec', 'kimi version 2.1.1\nCLEAN', 0.6)

  expect(behind.isAnswered).toBe(true)
  expect(behind.findings.length).toBe(0)

  // And after a narration, decorated with the provider's own bullet and
  // followed by the provider's own footer, which is where a real answer sits.
  const after = parse(
    'spec',
    [
      'kimi version 2.1.1',
      '• Let me look at the change.',
      'It touches one line.',
      '',
      '• CLEAN',
      '',
      'To resume this session: kimi -r session_d7218099',
    ].join('\n'),
    0.6,
  )

  expect(after.isAnswered).toBe(true)
  expect(after.findings.length).toBe(0)

  // Prose that merely contains the word is not an answer. Reading it as one
  // would turn a reviewer that could not look into one that found nothing.
  const prose = parse(
    'spec',
    'I could not reach the repository, so I cannot say whether it is clean or not.',
    0.6,
  )

  expect(prose.isAnswered).toBe(false)
})

test('a finding is read from the answer, not from the diff the provider quoted', () => {
  // A provider that reasons aloud quotes the change in a fence of its own
  // before it answers. Taking the first fence parses that quotation, fails,
  // and reports a real finding as no answer at all.
  const read = parse(
    'far-sequence',
    [
      'kimi version 2.1.1',
      '• Let me look at the change.',
      '',
      '  ```rust',
      '  if out.bytes > CEILING {',
      '-     return Outcome::Failed(Breach::OutputCeiling);',
      '+     return Outcome::Completed;',
      '  ```',
      '',
      '  The change maps a detected breach to success. Output the JSON.',
      '',
      '  ```json',
      '  {"verdict":"findings","findings":[{"severity":"critical",',
      '  "title":"Exceeded output ceiling reported as success",',
      '  "body":"A breach reported as a completion teaches the caller the check passed.",',
      '  "file":"src/run.rs","line_start":8,"line_end":8,"confidence":1.0,',
      '  "recommendation":"Restore the Failed outcome.","reference":"run_guest in src/run.rs"}]}',
      '  ```',
      '',
      'To resume this session: kimi -r session_b346359f',
    ].join('\n'),
    0.6,
  )

  expect(read.isAnswered).toBe(true)
  expect(read.findings.length).toBe(1)
  expect(read.findings[0]?.severity).toBe('critical')
  expect(read.findings[0]?.file).toBe('src/run.rs')
  expect(read.findings[0]?.lane).toBe('far-sequence')
})

test('a declared clean verdict with no list is an answer', () => {
  // Read as a non-answer this is reported as a provider that could not look,
  // which is the opposite of what it said.
  const read = parse('spec', '{"verdict":"clean"}', 0.6)

  expect(read.isAnswered).toBe(true)
  expect(read.findings.length).toBe(0)
  expect(read.detail).toBe('')
})

test("a provider's bullet in front of its JSON is decoration, not a shape", () => {
  // The right finding, behind one character that is not JSON. A reader that
  // insists the brace comes first reports this as an answer with nothing in
  // it, and the reviewer looks broken while being correct.
  const read = parse(
    'far-sequence',
    '• {"verdict":"findings","findings":[{"severity":"critical",' +
      '"title":"Exceeded output ceiling reported as Completed",' +
      '"body":"A breach reported as a completion teaches the caller the check passed.",' +
      '"file":"src/run.rs","line_start":8,"line_end":8,"confidence":0.95,' +
      '"recommendation":"Return the breach.","reference":"run_guest"}]}',
    0.6,
  )

  expect(read.isAnswered).toBe(true)
  expect(read.findings.length).toBe(1)
  expect(read.findings[0]?.severity).toBe('critical')
  expect(read.findings[0]?.file).toBe('src/run.rs')
})

test('a subject already handed over is not handed over again', () => {
  const told = new Set([subjectOf(finding({ file: 'src/old.ts' }))])
  const { fresh, subjects } = unsent(
    [finding({ file: 'src/new.ts' }), finding({ file: 'src/old.ts' })],
    told,
  )

  expect(fresh.map(one => one.file)).toEqual(['src/new.ts'])
  expect(subjects).toEqual([subjectOf(finding({ file: 'src/new.ts' }))])
})

test('two findings on one subject are handed over once, not twice', () => {
  // One subject is a file and a reference, so these two are the same subject
  // reported twice. Nothing has recorded it yet, so the batch has to collapse
  // them itself: a filter against what earlier deliveries carried passes both.
  const one = { file: 'src/thing.ts', reference: 'src/thing.ts' }
  const { fresh, subjects } = unsent(
    [finding({ ...one, body: 'first' }), finding({ ...one, body: 'second' })],
    new Set(),
  )

  expect(fresh.map(found => found.body)).toEqual(['first'])
  expect(subjects.length).toBe(1)
})

test('one file reported for two different reasons is two subjects', () => {
  // The subject is the file and the reference, not the file alone: two
  // genuinely different reports on one file are both worth handing over.
  const { fresh } = unsent(
    [
      finding({ file: 'src/thing.ts', reference: 'docs/spec.md' }),
      finding({ file: 'src/thing.ts', reference: 'docs/patterns.md' }),
    ],
    new Set(),
  )

  expect(fresh.length).toBe(2)
})

test('nothing is handed over when every subject was already told', () => {
  const one = finding({ file: 'src/thing.ts' })
  const { fresh, subjects } = unsent([one], new Set([subjectOf(one)]))

  expect(fresh).toEqual([])
  expect(subjects).toEqual([])
})

test('the order the panel ranked the findings in is kept', () => {
  const { fresh } = unsent(
    [
      finding({ file: 'a.ts' }),
      finding({ file: 'b.ts' }),
      finding({ file: 'c.ts' }),
    ],
    new Set(),
  )

  expect(fresh.map(one => one.file)).toEqual(['a.ts', 'b.ts', 'c.ts'])
})
