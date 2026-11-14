import type { Entry, Framing, Window } from '../cleaner'
import { cleanerEvidence, cleanerTask } from '../cleaner'
import type { Lane } from '../config'
import type { Finding } from '../verdict'

/**
 * What a lane is given to review: the turn's own changes, the documents that
 * govern them, and whatever earlier waves found.
 *
 * `diff` is the evidence. `paths` is there so a lane can be told what was
 * touched even when the diff was cut at its size limit. `docs` holds the
 * documents the lane was configured to read, already loaded, so no reviewer
 * has to be trusted to find them. `earlier` is empty in wave 0 and holds the
 * previous waves' findings in later waves.
 */
export type Evidence = {
  /** How many secret-shaped values were replaced in `window` before sending. */
  redactions?: number
  purpose: string
  /**
   * The commands the turn ran, newest last, as `activityOf` in `register.ts`
   * reads them from the session's own messages.
   *
   * A turn's diff says what its files hold now; this says what it did. A
   * change made by running something, and a change whose file the diff could
   * not reach, are judged on this or on nothing.
   */
  activity?: readonly string[]
  /**
   * The changed files that no repository holds, as `collectDiff` in
   * `register.ts` reports them.
   *
   * A reviewer told nothing about them judges every file as though a commit
   * could carry it, and reports on committing one that nothing can commit.
   */
  outside?: readonly string[]
  diff: string
  paths: readonly string[]
  docs: readonly { path: string; text: string }[]
  earlier: readonly Finding[]
  isDiffTruncated: boolean
  /** Present only for a cleaner lane, whose evidence is the transcript. */
  window?: Window
  /** Which question the window is being asked; `own` when absent. */
  framing?: Framing
  /** The newest messages, shown only to the newest-anchored framing. */
  anchor?: readonly Entry[]
}

/**
 * The answer shape every lane is asked for, and the rules that make a
 * reviewer's silence trustworthy.
 *
 * The output contract is JSON because findings carry a file, a line span and
 * a confidence, and a line-oriented answer loses them. `parse` in `verdict`
 * nonetheless accepts a one-line form and the bare word `CLEAN`, so a
 * provider that will not hold to JSON still produces findings.
 *
 * The standing rules exist because a reviewer that reports on every turn is
 * one a person learns to dismiss: the instruction to answer `CLEAN` is
 * repeated, given its own paragraph, and stated as the expected case.
 */
const CONTRACT = [
  '<output_contract>',
  'Answer with one JSON object and nothing else, in this shape:',
  '{"verdict":"clean"|"findings","findings":[{"severity":"critical"|"high"|"medium"|"low",',
  '"title":"one line","body":"what is wrong and why it matters","file":"path/from/repo/root",',
  '"line_start":1,"line_end":1,"confidence":0.0,"recommendation":"the edit that settles it",',
  '"reference":"the document, symbol or file the finding is about"}]}',
  'If you have nothing to report, answer with exactly: CLEAN',
  '</output_contract>',
  '',
  '<standing_rules>',
  'CLEAN is the expected answer. Most turns have nothing worth reporting, and',
  'reporting nothing is a complete and correct review.',
  'Report only what you can ground in the diff or in the documents given to you below.',
  'Do not report style, naming or formatting unless a given document requires it.',
  'Do not report a problem that the diff does not introduce or worsen.',
  'Do not restate what the change does. A summary is not a finding.',
  'Every finding must name a file that appears in the diff, and a line span inside it.',
  'Set confidence honestly: below 0.6 means you are guessing, and a guess is dropped.',
  '</standing_rules>',
].join('\n')

/**
 * The prompt for one lane over one body of evidence.
 *
 * The lane's question leads, because it is the only thing that distinguishes
 * one reviewer from another; the contract and the standing rules follow
 * unchanged for every lane, so that a custom lane gets the same discipline
 * as a shipped one.
 *
 * The question is framed as the reviewer's subject rather than as the only
 * thing it may answer, and the standing instructions are said to settle what
 * the subject covers. A reviewer told to judge the change "against that
 * question" alone reasons its way out of reporting a defect its instructions
 * describe but the question's wording misses — it says so, and reports
 * nothing. That makes every sentence of a lane's instructions dead text
 * unless the question happens to enumerate it. Documents are given in full rather than named, since a
 * reviewer asked to go and read a specification will instead infer it from
 * the diff and report its inference as drift.
 *
 * @param lane the reviewer this prompt is for
 * @param evidence the turn's changes, the governing documents, earlier findings
 * @returns the prompt text a provider is given
 */
export function promptFor(lane: Lane, evidence: Evidence): string {
  const isCleaning = evidence.window !== undefined
  const parts: string[] = isCleaning
    ? [
        '<task>',
        ...cleanerTask(
          lane.name,
          lane.question,
          evidence.window!,
          evidence.framing ?? 'own',
        ),
        '</task>',
        '',
      ]
    : [
        '<task>',
        `You are a reviewer named "${lane.name}". This is your subject:`,
        lane.question,
        'A turn of work by another agent has just changed the files below.',
        'Judge that change, and nothing else about the repository.',
        'Your subject is the question above as your standing instructions define',
        'it: where they name something to look for, it is part of your subject even',
        'if the question does not spell it out. A defect your instructions describe',
        'is never out of scope for being outside the question\'s wording.',
        '</task>',
        '',
      ]

  if (evidence.purpose !== '') {
    parts.push(
      '<purpose_of_this_work>',
      'The person said this is what the work is for. Judge the change against',
      'it: a change that serves this purpose is not drift because it is not what',
      'you would have done, and a change that quietly does something else is.',
      '',
      evidence.purpose,
      '</purpose_of_this_work>',
      '',
    )
  }

  if ((evidence.activity ?? []).length > 0) {
    parts.push(
      '<what_the_turn_ran>',
      'The commands this turn ran, in order. They are evidence of what the',
      'work did, not of what the files now hold: judge a command that changes',
      'the tree, moves data, or reaches outside it on this, even when the diff',
      'below shows nothing for it.',
      '',
      ...(evidence.activity ?? []),
      '</what_the_turn_ran>',
      '',
    )
  }

  if ((evidence.outside ?? []).length > 0) {
    parts.push(
      '<files_no_repository_holds>',
      'These changed files are in no repository. Nothing can commit them, and',
      'no commit, branch, review or release will ever carry them, so a defect',
      'about committing one of them — or about what committing it would mean —',
      'does not apply. Judge what the change does, not how it would be kept.',
      '',
      ...(evidence.outside ?? []),
      '</files_no_repository_holds>',
      '',
    )
  }

  if (lane.instructions !== '') {
    parts.push(
      '<your_standing_instructions>',
      'These are this repository\'s own instructions for you. They outrank the',
      'general guidance below wherever the two differ, except for the output',
      'contract, which is not negotiable. They also settle what your subject',
      'covers: anything they tell you to look for is yours to report.',
      '',
      lane.instructions,
      '</your_standing_instructions>',
      '',
    )
  }

  parts.push(CONTRACT, '')

  if (evidence.docs.length > 0) {
    parts.push('<governing_documents>')
    parts.push(
      'These are the documents this change answers to. Quote them when you contradict them.',
    )

    for (const doc of evidence.docs) {
      parts.push('', `--- ${doc.path} ---`, doc.text)
    }

    parts.push('</governing_documents>', '')
  } else {
    parts.push(
      '<governing_documents>',
      'No governing documents were configured for this lane. Judge the change against',
      "the repository's own conventions as the diff shows them, and set confidence lower",
      'than you would with a document in hand.',
      '</governing_documents>',
      '',
    )
  }

  if (evidence.earlier.length > 0) {
    parts.push('<what_other_reviewers_found>')
    parts.push('Earlier reviewers of this same change reported the following.')
    parts.push('Use it as evidence. Do not repeat it as your own finding.')

    for (const finding of evidence.earlier) {
      parts.push(
        `- [${finding.lane}/${finding.severity}] ${finding.file}:${finding.lineStart} — ${finding.title}` +
          (finding.reference !== '' ? ` (about: ${finding.reference})` : ''),
      )
    }

    parts.push('</what_other_reviewers_found>', '')
  }

  if (isCleaning) {
    parts.push(
      ...cleanerEvidence(
        evidence.window!,
        evidence.redactions ?? 0,
        evidence.anchor ?? [],
      ),
    )

    // A lane that names both sights is shown the change beside each window,
    // so a rule broken in the conversation and one broken in the code are the
    // same reviewer's subject.
    if (evidence.diff !== '') {
      parts.push('', '<diff>', evidence.diff, '</diff>')
    }
  } else {
    parts.push(
      '<files_changed>',
      evidence.paths.join('\n'),
      '</files_changed>',
      '',
    )
    parts.push('<diff>')
    parts.push(evidence.diff)

    if (evidence.isDiffTruncated) {
      parts.push(
        '',
        '[the diff was cut at its size limit; the file list above is complete and this',
        'diff is not, so do not conclude that an unlisted file was untouched]',
      )
    }

    parts.push('</diff>')
  }

  // The answer shape is restated last, after the diff. A provider reads the
  // contract, then a diff and a set of documents many times its length, and
  // answers against whatever it read most recently: a contract in the middle
  // of the prompt is a contract competing with the evidence. A reviewer that
  // found the right defect and described it in prose is reported as a
  // provider that could not answer, so the shape has to be the last thing
  // asked for.
  parts.push(
    '',
    '<answer_now>',
    'Answer with the one JSON object the output contract above describes, and',
    'nothing else: no preamble, no explanation outside it, no closing remark.',
    'If you have nothing to report, answer with exactly: CLEAN',
    '</answer_now>',
  )

  return parts.join('\n')
}

/**
 * The prompt that expands one finding for a person who asked what it means.
 *
 * Raised by the explain button on a card. It is deliberately not the lane's
 * own prompt again: the finding is already made, and asking for it to be
 * re-derived invites a second, different finding.
 *
 * @param finding the finding to explain
 * @returns the prompt text a provider is given
 */
export function explainPrompt(finding: Finding): string {
  return [
    '<task>',
    `A reviewer named "${finding.lane}" reported this about the change just made:`,
    `${finding.severity}: ${finding.title}`,
    `at ${finding.file}:${finding.lineStart}-${finding.lineEnd}`,
    finding.reference !== '' ? `about: ${finding.reference}` : '',
    '',
    finding.body,
    '',
    'Explain to the person, in plain language, what this means for their code and',
    'what happens if they leave it. At most 120 words. No preamble, no restatement',
    'of the finding, no markdown headings. If the finding looks wrong to you, say so',
    'and say why.',
    '</task>',
  ]
    .filter(line => line !== '')
    .join('\n')
}

/**
 * The prompt handed to the session when a person presses the fix button on a
 * card.
 *
 * It is phrased as the person's own instruction because that is what pressing
 * the button means: the finding stops being a report and becomes the next
 * piece of work.
 *
 * @param finding the finding to act on
 * @returns the text submitted into the conversation
 */
export function fixPrompt(finding: Finding): string {
  const where = `${finding.file}:${finding.lineStart}-${finding.lineEnd}`
  const about =
    finding.reference !== '' ? ` It concerns ${finding.reference}.` : ''
  const how =
    finding.recommendation !== ''
      ? ` The suggested fix is: ${finding.recommendation}`
      : ''

  return (
    `The ${finding.lane} reviewer found this in the change you just made, at ${where}: ` +
    `${finding.title}. ${finding.body}${about}${how} ` +
    'Check it against the code before you act — the reviewer may be wrong. ' +
    'If it is right, fix it. If it is wrong, say why and do nothing.'
  )
}

/**
 * The lanes in the order they can run, grouped into waves.
 *
 * A lane runs in the first wave after every lane it `needs`, so the waves
 * are a topological sort of the `needs` graph and nothing else decides the
 * order. A lane that needs a lane which is not enabled is treated as having
 * that need met: a reviewer must not be stranded because an unrelated lane
 * was turned off.
 *
 * A cycle cannot be ordered, so the lanes still unplaced when no further
 * progress is possible are emitted together as a final wave. They run, and
 * they see none of each other's findings, which is the most that can be
 * honoured of a `needs` that contradicts itself.
 *
 * With `crossLink` off every lane is in one wave and `inputsFor` gives each
 * of them nothing, so a lane sees only the change.
 *
 * @param lanes the enabled lanes
 * @param crossLink whether lanes read each other at all
 * @returns the waves, in run order
 */
export function wavesOf(
  lanes: readonly Lane[],
  crossLink: boolean,
): Lane[][] {
  if (!crossLink) {
    return lanes.length > 0 ? [[...lanes]] : []
  }

  // Keyed on the shared name, so a `needs` edge naming a lane reaches every
  // reviewer that lane was expanded into.
  const enabled = new Set(lanes.map(lane => lane.group))
  const placed = new Set<string>()
  const waves: Lane[][] = []
  let rest = [...lanes]

  while (rest.length > 0) {
    const wave = rest.filter(lane =>
      lane.needs.every(need => !enabled.has(need) || placed.has(need)),
    )

    if (wave.length === 0) {
      waves.push(rest)
      break
    }

    for (const lane of wave) {
      placed.add(lane.name)
    }

    // A group counts as placed only once every reviewer in it is, so a lane
    // that reads it waits for all of them rather than the first to land.
    for (const group of new Set(lanes.map(entry => entry.group))) {
      const all = lanes.filter(entry => entry.group === group)

      if (all.every(entry => placed.has(entry.name))) {
        placed.add(group)
      }
    }

    waves.push(wave)
    rest = rest.filter(lane => !placed.has(lane.name))
  }

  return waves
}

/**
 * The findings one lane is given as evidence: those of the lanes it `needs`,
 * and no others.
 *
 * Handing a lane every earlier finding would make the cross-link a broadcast
 * and spend a reviewer's context on findings it was never asked to reason
 * about. Naming the lanes it reads is what makes the link configurable.
 *
 * @param lane the lane about to run
 * @param results every lane result so far, from earlier waves
 * @returns the findings to put under `<what_other_reviewers_found>`
 */
export function inputsFor(
  lane: Lane,
  results: readonly { lane: string; findings: readonly Finding[] }[],
): Finding[] {
  if (lane.needs.length === 0) {
    return []
  }

  // A result's name may be `<lane>:<provider>`, so an edge naming the lane
  // reads every reviewer's findings from it.
  return results
    .filter(result =>
      lane.needs.some(
        need => result.lane === need || result.lane.startsWith(`${need}:`),
      ),
    )
    .flatMap(result => [...result.findings])
}

/**
 * A list in batches of at most `size`, so no more lanes are in flight than
 * the configured concurrency allows.
 *
 * @param items the lanes to batch
 * @param size the most that may run together
 * @returns the batches, in order
 */
export function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []

  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size))
  }

  return out
}
