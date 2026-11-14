import type { Severity } from '../config'
import { RANK } from '../config'

/**
 * One thing a lane found: what is wrong, where, and what would settle it.
 *
 * `lane` is the reviewer that reported it and `alsoFrom` the others that
 * reported the same subject, so a card can say "spec + reuse" instead of
 * drawing one problem twice. `file`, `lineStart` and `lineEnd` are what makes a finding
 * actionable; a lane that cannot name a file is reporting an opinion, and
 * `parse` drops it. `reference` is the document or symbol the finding is
 * about — the spec it contradicts, the existing code it duplicates, the
 * design document it falsifies — and it is what `subjectOf` deduplicates on.
 */
export type Finding = {
  lane: string
  alsoFrom: readonly string[]
  severity: Severity
  title: string
  body: string
  file: string
  lineStart: number
  lineEnd: number
  confidence: number
  recommendation: string
  reference: string
}

/**
 * What one lane's run came to.
 *
 * `outcome` separates the three things a silent lane can mean, because they
 * need different answers: `clean` is a reviewer that looked and found
 * nothing, `skipped` is a lane that never ran, and `failed` is a lane whose
 * provider broke. Only `failed` is worth showing a person, and only when
 * `debug` is on.
 */
export type LaneResult = {
  lane: string
  outcome: 'findings' | 'clean' | 'skipped' | 'failed'
  findings: readonly Finding[]
  summary: string
  detail: string
  latencyMs: number
  via: string
  notes: string
}

/**
 * `via` names the provider that actually answered, and is empty when that
 * was the lane's own. A finding that came from a lane's fallback was judged
 * by a different model than the roster names, which is worth saying rather
 * than hiding: it is the difference between the reviewer you configured and
 * the one that was available.
 *
 * `notes` is what the reviewer said that the panel could not turn into a
 * finding: the prose of an answer in no recognised shape, or the provider's
 * own words about why it would not answer. It is kept because a reviewer
 * that said something useful in the wrong format has still said it, and a
 * panel that reports only `failed` throws that away and leaves nothing to
 * act on or to debug the shape with.
 */

/**
 * The verdict line a reviewer writes above its findings, and the only line
 * `parse` requires of a lane that found nothing.
 *
 * Taking `CLEAN` as a whole-line answer is what lets a reviewer be cheap
 * when it has nothing to say, which is the state it is told to prefer.
 */
const CLEAN = /^\s*clean\s*[.!]?\s*$/i

/**
 * A finding in the one-line form, as a reviewer that will not emit JSON
 * writes it: `severity | file:line-line | title | recommendation`.
 *
 * `parse` reads JSON first and falls back to this, so a provider whose CLI
 * wraps or truncates structured output still yields findings instead of a
 * failed lane.
 */
const LINE =
  /^\s*(critical|high|medium|low)\s*\|\s*([^|:]+?)(?::(\d+)(?:-(\d+))?)?\s*\|\s*([^|]+?)(?:\s*\|\s*(.*))?$/i

/**
 * Reads a reviewer's answer into findings, tolerating everything but a
 * finding that cannot be acted on.
 *
 * Three shapes are accepted, in order: a JSON object or fenced JSON block
 * carrying `findings`, the one-line form above, and the bare word `CLEAN`.
 * Anything else yields no findings and a `detail` saying so, which is a
 * lane that did not answer rather than a lane that approved — the
 * distinction `LaneResult.outcome` keeps, so that a provider returning
 * noise can never read as a clean review.
 *
 * @param lane the reviewer's name, stamped onto every finding it reported
 * @param text the provider's answer
 * @param minConfidence findings below this confidence are dropped
 * @returns the findings, and a detail line when nothing could be read
 */
export function parse(
  lane: string,
  text: string,
  minConfidence: number,
): { findings: Finding[]; isAnswered: boolean; detail: string } {
  const body = String(text ?? '').trim()

  if (body === '') {
    return {
      findings: [],
      isAnswered: false,
      detail: 'the provider returned nothing',
    }
  }

  if (CLEAN.test(body)) {
    return { findings: [], isAnswered: true, detail: '' }
  }

  const structured = fromJson(lane, body)

  if (structured !== undefined) {
    return {
      findings: structured.filter(
        finding => finding.confidence >= minConfidence,
      ),
      isAnswered: true,
      detail: '',
    }
  }

  const lines = fromLines(lane, body)

  if (lines.length > 0) {
    return {
      findings: lines.filter(finding => finding.confidence >= minConfidence),
      isAnswered: true,
      detail: '',
    }
  }

  const isDeclared = isClean(body)

  return {
    findings: [],
    isAnswered: isDeclared,
    detail: isDeclared
      ? ''
      : `the provider answered in a shape with no findings in it — it ended: ${ending(body)}`,
  }
}

/**
 * The findings in a JSON answer, or `undefined` when there is no JSON to
 * read.
 *
 * A fenced block is unwrapped first, because a reviewer told to answer in
 * JSON will often answer in a fence anyway. An object with a `findings`
 * array is the shape asked for; a bare array is accepted as the same thing,
 * since that is the other way the instruction is commonly read.
 *
 * @param lane the reviewer's name
 * @param body the provider's answer, trimmed
 * @returns the findings, or `undefined` when the answer holds no JSON
 */
function fromJson(lane: string, body: string): Finding[] | undefined {
  // Every fenced block, newest first, then the whole answer. A provider that
  // reasons aloud quotes the diff in a fence of its own before it answers, so
  // taking the first fence parses that quotation and reads a real answer as no
  // answer at all. The last fence is the one it meant.
  const fences = [...body.matchAll(/```[a-z]*\s*([\s\S]*?)```/gi)]
    .map(match => match[1] ?? '')
    .reverse()

  for (const candidate of [...fences, body].map(undecorated)) {
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) {
      continue
    }

    let parsed: unknown

    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }

    if (Array.isArray(parsed)) {
      return read(lane, parsed)
    }

    if (!isRecord(parsed)) {
      continue
    }

    if (Array.isArray(parsed.findings)) {
      return read(lane, parsed.findings)
    }

    // A declared clean verdict with no list is an answer, not a shape with
    // nothing in it: read as a non-answer it would be reported as a provider
    // that could not look.
    if (str(parsed.verdict).toLowerCase() === 'clean') {
      return []
    }
  }

  return undefined
}

/**
 * Text with a provider's own decoration taken off the front.
 *
 * A CLI that prints its answer as a bullet or a quoted line gives the right
 * JSON behind a character that is not JSON, and a reader that insists on the
 * brace being first reports a correct finding as an answer with nothing in
 * it. The decoration is the provider's, not the answer's.
 *
 * @param text a candidate answer
 * @returns the text, trimmed and undecorated
 */
function undecorated(text: string): string {
  return text.trim().replace(/^[\u2022\u00b7>*\-\s]+/, '')
}

/**
 * The findings in a parsed list, dropping the entries that are not findings.
 *
 * @param lane the reviewer the findings are attributed to
 * @param raw the parsed entries
 * @returns the findings
 */
function read(lane: string, raw: readonly unknown[]): Finding[] {
  return raw
    .map(entry => findingOf(lane, entry))
    .filter((finding): finding is Finding => finding !== undefined)
}

/**
 * The findings in a line-form answer.
 *
 * Every line is tried against `LINE` and the ones that do not match are
 * dropped, so a reviewer may wrap its findings in prose without the prose
 * becoming a finding.
 *
 * @param lane the reviewer's name
 * @param body the provider's answer, trimmed
 * @returns the findings the answer's lines carry
 */
function fromLines(lane: string, body: string): Finding[] {
  const out: Finding[] = []

  for (const line of body.split(/\r?\n/)) {
    const match = LINE.exec(line)

    if (match === null) {
      continue
    }

    const start = Number(match[3] ?? 1)
    const end = Number(match[4] ?? start)

    out.push({
      lane,
      alsoFrom: [],
      severity: (match[1] ?? 'low').toLowerCase() as Severity,
      title: (match[5] ?? '').trim(),
      body: (match[5] ?? '').trim(),
      file: (match[2] ?? '').trim(),
      lineStart: Math.max(1, start),
      lineEnd: Math.max(Math.max(1, start), end),
      confidence: 0.7,
      recommendation: (match[6] ?? '').trim(),
      reference: '',
    })
  }

  return out
}

/**
 * One finding out of a JSON entry, or `undefined` when the entry names no
 * file or no title.
 *
 * A missing severity reads as `low` and a missing confidence as `0.5`:
 * a reviewer that omits them is not thereby reporting a crisis. A missing
 * file, though, is not defaulted — a finding nobody can navigate to is the
 * one kind this plugin refuses to draw.
 *
 * @param lane the reviewer's name
 * @param entry one element of the answer's `findings`
 * @returns the finding, or `undefined` when it cannot be acted on
 */
function findingOf(lane: string, entry: unknown): Finding | undefined {
  if (!isRecord(entry)) {
    return undefined
  }

  const file = str(entry.file ?? entry.path)
  const title = str(entry.title ?? entry.issue)

  if (file === '' || title === '') {
    return undefined
  }

  const start = Math.max(
    1,
    Math.trunc(num(entry.line_start ?? entry.lineStart ?? entry.line, 1)),
  )
  const end = Math.max(
    start,
    Math.trunc(num(entry.line_end ?? entry.lineEnd, start)),
  )
  const severity = str(entry.severity).toLowerCase()

  return {
    lane,
    alsoFrom: [],
    severity: RANK.includes(severity as Severity)
      ? (severity as Severity)
      : 'low',
    title,
    body: str(entry.body ?? entry.detail ?? entry.explanation) || title,
    file,
    lineStart: start,
    lineEnd: end,
    confidence: Math.min(1, Math.max(0, num(entry.confidence, 0.5))),
    recommendation: str(entry.recommendation ?? entry.fix ?? entry.next_step),
    reference: str(
      entry.reference ?? entry.document ?? entry.existing ?? entry.spec,
    ),
  }
}

/**
 * The last thing a provider said, cut short, for a failure message.
 *
 * A reviewer that found the right defect and described it in prose is
 * reported as a provider that could not answer, and without its own last
 * words that report is unactionable: there is no way to tell a refusal from a
 * finding in the wrong shape from a sign-in prompt. The tail is where the
 * answer should be, so that is what is quoted.
 *
 * @param body the provider's whole answer
 * @returns its last line, at most 160 characters, quoted
 */
function ending(body: string): string {
  const lines = body
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
  const last = lines[lines.length - 1] ?? ''

  if (last === '') {
    return '(nothing at all)'
  }

  return JSON.stringify(last.length > 160 ? `${last.slice(0, 159)}…` : last)
}

/**
 * Whether an answer declares the review clean.
 *
 * The contract asks for the bare word, but a CLI puts its own line first: a
 * version banner ahead of the answer would hide a clean review behind it, and
 * a clean review read as a non-answer is reported as a broken provider. So
 * the word is looked for as a line of its own among the first few lines and
 * the last few, which is where an answer sits whether or not the provider
 * narrated its way there. A bullet or a quote marker in front of it is the
 * provider's own decoration, and a session id or a resume hint after it is
 * the provider's own footer; neither is part of the answer.
 *
 * A line of its own is the whole of the test: prose that merely contains the
 * word is not an answer, and reading it as one would turn a reviewer that
 * could not look into a reviewer that found nothing.
 *
 * @param body the provider's whole answer
 * @returns whether it declares the review clean
 */
function isClean(body: string): boolean {
  const lines = body
    .split(/\r?\n/)
    .map(line => line.trim().replace(/^[\u2022\u00b7>*\-\s]+|[.!*\s]+$/g, ''))
    .filter(line => line !== '')

  if (lines.length === 0) {
    return false
  }

  // The first lines carry a banner, the last carry whatever the CLI prints
  // after the answer — a session id, a resume hint — so the answer sits a
  // line or two in from either end rather than exactly at one.
  const looked = [...lines.slice(0, 3), ...lines.slice(-5)]

  return looked.some(line => line.toLowerCase() === 'clean')
}

/**
 * The key two findings must share to be the same finding.
 *
 * The subject is the file and the thing the finding is about — not the lane
 * that raised it, and never the sentence. Two reviewers asking different
 * questions reach the same duplicated function from different directions,
 * and drawing that twice makes the panel look like it found two problems;
 * `rank` merges them and the card names both lanes.
 *
 * Line numbers are left out because an edit above a finding moves it without
 * changing it, and the wording is left out because one reviewer rewords a
 * standing finding on every turn.
 *
 * @param finding the finding to key
 * @returns the key `rank` merges on and the store's shown-set compares on
 */
export function subjectOf(finding: Finding): string {
  const reference = finding.reference !== '' ? finding.reference : finding.title

  return [finding.file, normalize(reference)].join(' ')
}

/**
 * Every lane's findings as one list: the most severe first, each subject
 * once, and a subject several lanes agree on merged into one finding that
 * names them all.
 *
 * A merge keeps the worst severity and the highest confidence reported for
 * the subject, because agreement between reviewers is evidence and the
 * panel should not round it down. It prefers a body, a recommendation and a
 * reference that are actually filled in, so merging never loses the more
 * useful of two reports.
 *
 * Consumed by the delivery hook, which draws the head of this list and
 * counts the tail.
 *
 * @param results every lane's result, in configured order
 * @param seen subjects already shown in this session, which are dropped
 * @returns the findings worth drawing, most severe first
 */
/**
 * The findings a delivery should hand over, and the subjects it must record.
 *
 * `classic.Stop` in `register.ts` calls this with the subjects already handed
 * over, from memory and from the store together. A subject is handed over
 * once: `told` bars one an earlier delivery carried, and the walk bars a
 * second finding on the same subject in this batch, which `told` cannot see
 * because nothing has recorded it yet.
 *
 * The subjects are returned beside the findings so the caller records exactly
 * what it is about to send, before it sends it.
 *
 * @param findings the panel's findings, worst first
 * @param told the subjects already handed over
 * @returns the findings to send, in order, and their subjects
 */
export function unsent(
  findings: readonly Finding[],
  told: ReadonlySet<string>,
): { fresh: Finding[]; subjects: string[] } {
  const fresh: Finding[] = []
  const subjects: string[] = []
  const sending = new Set<string>()

  for (const finding of findings) {
    const subject = subjectOf(finding)

    if (told.has(subject) || sending.has(subject)) {
      continue
    }

    sending.add(subject)
    subjects.push(subject)
    fresh.push(finding)
  }

  return { fresh, subjects }
}

export function rank(
  results: readonly LaneResult[],
  seen: ReadonlySet<string>,
): Finding[] {
  const order = new Map(results.map((result, index) => [result.lane, index]))
  const kept = new Map<string, Finding>()

  for (const result of results) {
    for (const finding of result.findings) {
      const subject = subjectOf(finding)

      if (seen.has(subject)) {
        continue
      }

      const held = kept.get(subject)

      kept.set(subject, held === undefined ? finding : merged(held, finding))
    }
  }

  return [...kept.values()].sort((left, right) => {
    const bySeverity = RANK.indexOf(left.severity) - RANK.indexOf(right.severity)

    if (bySeverity !== 0) {
      return bySeverity
    }

    const byAgreement = right.alsoFrom.length - left.alsoFrom.length

    if (byAgreement !== 0) {
      return byAgreement
    }

    const byLane = (order.get(left.lane) ?? 0) - (order.get(right.lane) ?? 0)

    return byLane !== 0 ? byLane : right.confidence - left.confidence
  })
}

/**
 * Two findings about one subject as one.
 *
 * The one with the worse severity leads, so the card's colour and the
 * blocking decision read from the strongest report; the other lane is
 * recorded in `alsoFrom`. A field the leader left empty is taken from the
 * follower, which is how a terse reviewer and a thorough one about the same
 * subject produce one complete finding.
 *
 * @param held the finding already kept for this subject
 * @param next another lane's finding about it
 * @returns the merged finding
 */
function merged(held: Finding, next: Finding): Finding {
  const isNextWorse =
    RANK.indexOf(next.severity) < RANK.indexOf(held.severity) ||
    (next.severity === held.severity && next.confidence > held.confidence)
  const lead = isNextWorse ? next : held
  const other = isNextWorse ? held : next
  const names = new Set([...lead.alsoFrom, ...other.alsoFrom, other.lane])

  names.delete(lead.lane)

  return {
    ...lead,
    alsoFrom: [...names].sort(),
    confidence: Math.max(held.confidence, next.confidence),
    body: lead.body !== '' && lead.body !== lead.title ? lead.body : other.body,
    recommendation:
      lead.recommendation !== '' ? lead.recommendation : other.recommendation,
    reference: lead.reference !== '' ? lead.reference : other.reference,
  }
}

/**
 * A reference or title reduced to what makes it the same subject twice:
 * lowercase, punctuation dropped, runs of space collapsed.
 *
 * A dot is kept inside the string because a reference is usually a path and
 * `docs/spec.md` must not reduce to `docs/spec md`, but a dot at either end
 * is sentence punctuation and is dropped, so a reviewer that ends its
 * reference with a full stop names the same subject as one that does not.
 *
 * @param value the reference or title
 * @returns the comparable form
 */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9/._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+/, '')
    .replace(/[\s.]+$/, '')
}

/**
 * Whether a value is a plain object, so its fields can be read.
 *
 * @param value the value to test
 * @returns whether the value has readable fields
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A field as a trimmed string, empty when it is not a string or number.
 *
 * @param value the field's value
 * @returns the string form
 */
function str(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim()
  }

  return typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : ''
}

/**
 * A field as a finite number, or `fallback`.
 *
 * A numeric string is read, because a reviewer asked for a line number will
 * sometimes quote it.
 *
 * @param value the field's value
 * @param fallback the number to use when the field holds none
 * @returns a finite number
 */
function num(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)

    return Number.isFinite(parsed) ? parsed : fallback
  }

  return fallback
}

/**
 * A lane result, with its latency measured from when the lane started.
 *
 * @param lane the reviewer's name
 * @param outcome what the run came to
 * @param found the findings, empty for every outcome but `findings`
 * @param startedAt when the lane started, in milliseconds
 * @param detail why the lane found nothing, empty when it found something
 * @param via the provider that answered, empty when it was the lane's own
 * @returns the lane's result
 */
export function resultOf(
  lane: string,
  outcome: LaneResult['outcome'],
  found: readonly Finding[],
  startedAt: number,
  detail: string,
  via = '',
  notes = '',
): LaneResult {
  return {
    lane,
    outcome,
    findings: found,
    summary: '',
    detail,
    latencyMs: Date.now() - startedAt,
    via,
    notes,
  }
}
