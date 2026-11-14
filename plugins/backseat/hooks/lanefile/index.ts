import type { Lane, LaneScope, Severity, Sight, Trigger } from '../config'
import { RANK, SCOPES, SIGHTS, TRIGGERS } from '../config'

/**
 * Where lanes come from outside the code: a file, a tier of files, or a
 * command at the prompt.
 *
 * A lane file is a frontmatter block of fields, then the reviewer's
 * instructions as the body. `mergeLanes` resolves the tiers those files sit
 * in, `lanesForTurn` picks the ones a given turn is reviewed by, and
 * `sessionLaneOf` builds the lane `/backseat lane` adds.
 *
 * The body is why this exists. A lane's question fits in a settings string,
 * but the standing instructions that make a reviewer useful on one
 * particular repository — which patterns count, which directories are
 * generated, what this team means by a duplicate — do not. They belong in a
 * file in the repository, beside the code they are about, where they are
 * reviewed and versioned like anything else.
 *
 * The frontmatter is `key: value` lines between `---` fences, with lists
 * written comma-separated. It is deliberately not YAML: a lane file is read
 * by a hooks module that may import nothing but `claude-code` and its own
 * files, and a hand-rolled subset with predictable rules is worth more here
 * than the parts of YAML nobody would use.
 *
 * ```
 * ---
 * provider: kimi
 * fallback: codex
 * reviewers: codex, kimi
 * model: kimi-k2-thinking
 * command: gemini -m {model} -p {prompt}
 * question: Did this change add work to a hot path?
 * docs: docs/perf-budget.md
 * needs: reuse
 * severity: high
 * confidence: 0.75
 * agents: true
 * enabled: true
 * ---
 * Treat anything under `src/render/` as a hot path. A finding needs a named
 * caller and an argument about how often it runs.
 * ```
 */

/**
 * The fields a lane file may set, and what each one does.
 *
 * `needs` is the cross-link: it names the lanes whose findings this lane is
 * given as evidence, and by naming them it also orders the run, since a lane
 * cannot read findings that do not exist yet.
 *
 * `reviewers` asks the same question of several providers at once, so their
 * answers can corroborate one another; it is not a list of substitutes. A
 * lane with reviewers becomes one lane per reviewer, and a subject two of
 * them report is merged into one finding naming both.
 *
 * `fallback` names the provider to ask when this lane's own provider fails:
 * could not be run, exited badly, timed out, or answered with no verdict in
 * it. It is not asked when the provider reports a clean review, because that
 * is a complete answer.
 *
 * `agents` says whether the lane also reviews what a subagent wrote, at the
 * end of that subagent's own turn. It is off by default, because most
 * reviewers are about the work the person asked for and a subagent's turn
 * ends mid-task; a reviewer of coding patterns is the case for turning it
 * on, since a pattern is as wrong in delegated work as in the main loop's.
 */
const FIELDS: readonly string[] = [
  'name',
  'provider',
  'command',
  'model',
  'question',
  'docs',
  'needs',
  'severity',
  'confidence',
  'agents',
  'fallback',
  'reviewers',
  'enabled',
  'sees',
  'on',
  'projects',
]

/**
 * One lane out of a lane file, or `undefined` when the file defines no lane.
 *
 * A file with no question is dropped: the question is the whole of what
 * distinguishes one reviewer from another, and a lane without one asks the
 * provider to invent its own subject.
 *
 * A file with `enabled: false` defines no lane and instead reports the name
 * it `parked`. That is how a lane is parked without deleting the file, and
 * it has to name what it parked rather than simply saying nothing: a project
 * file parking a machine-wide lane only works if the name it refuses
 * reaches `mergeLanes`, which is the only place that can take it off the
 * roster.
 *
 * Unknown frontmatter keys are reported rather than ignored, because a
 * misspelled `sevrity` would otherwise read as a lane with no floor.
 *
 * @param fallbackName the lane's name when the frontmatter sets none, from
 *   the file's own basename
 * @param text the file's whole content
 * @param defaults the provider, confidence and fallback a lane that names
 *   none inherits, and the tier the file was found in
 * @returns the lane, the name it parks if it parks one, and any complaints
 *   about its frontmatter
 */
export function laneFrom(
  fallbackName: string,
  text: string,
  defaults: {
    provider: string
    confidence: number
    scope: LaneScope
    fallback: string
  },
): { lane: Lane | undefined; parked: string; problems: string[] } {
  const split = frontmatterOf(text)
  const problems: string[] = []

  if (split === undefined) {
    return {
      lane: undefined,
      parked: '',
      problems: [`${fallbackName}: no --- frontmatter block`],
    }
  }

  const fields = new Map<string, string>()

  for (const line of split.head.split(/\r?\n/)) {
    const trimmed = line.trim()

    if (trimmed === '' || trimmed.startsWith('#')) {
      continue
    }

    const at = trimmed.indexOf(':')

    if (at <= 0) {
      problems.push(`${fallbackName}: "${cut(trimmed)}" is not a key: value line`)
      continue
    }

    const key = trimmed.slice(0, at).trim()
    const value = trimmed.slice(at + 1).trim()

    if (!FIELDS.includes(key)) {
      problems.push(`${fallbackName}: unknown field "${key}"`)
      continue
    }

    fields.set(key, value)
  }

  const name = fields.get('name') ?? fallbackName

  if ((fields.get('enabled') ?? 'true').toLowerCase() === 'false') {
    return { lane: undefined, parked: name, problems }
  }

  const question = fields.get('question') ?? ''

  if (question === '') {
    return {
      lane: undefined,
      parked: '',
      problems: [...problems, `${fallbackName}: no question, so it reviews nothing`],
    }
  }

  const severity = (fields.get('severity') ?? '').toLowerCase()

  if (severity !== '' && !RANK.includes(severity as Severity)) {
    problems.push(`${fallbackName}: severity "${cut(severity)}" is not a severity`)
  }

  // An unset field must fall back, not read as zero: Number('') is 0, and a
  // confidence floor of 0 keeps every guess the reviewer had.
  const asked = fields.get('confidence')
  const confidence =
    asked === undefined || asked === '' ? Number.NaN : Number(asked)

  if (Number.isNaN(confidence) && asked !== undefined && asked !== '') {
    problems.push(`${fallbackName}: confidence "${cut(asked)}" is not a number`)
  }

  const onAgents = (fields.get('agents') ?? '').toLowerCase()

  if (onAgents !== '' && onAgents !== 'true' && onAgents !== 'false') {
    problems.push(`${fallbackName}: agents "${cut(onAgents)}" is not true or false`)
  }

  // An unreadable or absent `sees` is the default rather than a problem: the
  // evidence a lane did not name is the change its question is about.
  const named = listOf(fields.get('sees')).filter(word =>
    SIGHTS.includes(word as Sight),
  ) as Sight[]
  const sees: readonly Sight[] = named.length > 0 ? named : ['diff']

  return {
    parked: '',
    lane: {
      name,
      question,
      instructions: split.body.trim(),
      provider: fields.get('provider') ?? defaults.provider,
      command: fields.get('command') ?? '',
      model: fields.get('model') ?? '',
      docs: listOf(fields.get('docs')),
      needs: listOf(fields.get('needs')),
      severityFloor: RANK.includes(severity as Severity) ? (severity as Severity) : '',
      minConfidence:
        Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
          ? confidence
          : defaults.confidence,
      scope: defaults.scope,
      onAgents: onAgents === 'true',
      fallback: fields.get('fallback') ?? defaults.fallback,
      fallbackCommand: '',
      group: name,
      sees,
      projects: listOf(fields.get('projects')),
      // Reading a transcript costs the session rather than the turn, so a lane
      // that does it waits to be asked unless its file says otherwise.
      on: TRIGGERS.includes(fields.get('on') as Trigger)
        ? (fields.get('on') as Trigger)
        : sees.includes('transcript')
          ? 'ask'
          : 'turn',
      reviewers: listOf(fields.get('reviewers')),
    },
    problems,
  }
}

/**
 * The lanes of every tier as one roster, each name kept once.
 *
 * A later tier replaces a name an earlier one defined, whole: the lane that
 * wins is the one the more specific tier wrote, not a field-by-field blend of
 * the two, because a half-overridden reviewer is a reviewer nobody wrote.
 * Replacing is how a repository retunes a machine-wide lane, and how
 * `enabled: false` in a project file parks one.
 *
 * A tier may also park a name: `enabled: false` in a project file takes a
 * machine-wide lane off the roster for this repository, and a lane the next
 * tier up defines again is back on it.
 *
 * @param tiers each tier's lanes and the names it parks, least specific first
 * @returns the roster, and a note for each name a tier replaced or parked
 */
export function mergeLanes(
  tiers: readonly {
    scope: LaneScope
    lanes: readonly Lane[]
    parked?: readonly string[]
  }[],
): { lanes: Lane[]; notes: string[] } {
  const byName = new Map<string, Lane>()
  const notes: string[] = []

  for (const tier of [...tiers].sort(
    (a, b) => SCOPES.indexOf(a.scope) - SCOPES.indexOf(b.scope),
  )) {
    for (const name of tier.parked ?? []) {
      const held = byName.get(name)

      if (held !== undefined) {
        notes.push(`${name}: the ${tier.scope} tier parks the ${held.scope} lane`)
        byName.delete(name)
      }
    }

    for (const lane of tier.lanes) {
      const held = byName.get(lane.name)

      if (held !== undefined && held.scope !== tier.scope) {
        notes.push(`${lane.name}: the ${tier.scope} lane replaces the ${held.scope} one`)
      }

      byName.set(lane.name, lane)
    }
  }

  return { lanes: [...byName.values()], notes }
}

/**
 * The lanes that review one turn, by whose turn it was.
 *
 * The main loop's turn is reviewed by every lane. A subagent's turn is
 * reviewed only by the lanes that asked for it, so that delegating work does
 * not put the whole panel on every step of it.
 *
 * @param lanes the whole roster
 * @param agent the `agentId` of the turn that ended, empty for the main loop
 * @returns the lanes due to review it
 */
export function lanesForTurn(
  lanes: readonly Lane[],
  agent: string,
): Lane[] {
  // A lane that waits to be asked is not run by a turn. Only an explicit `ask`
  // is held back — a lane whose trigger is absent runs, so a lane built
  // somewhere that does not set one keeps reviewing instead of silently
  // dropping out of every turn.
  const reviewers = lanes.filter(lane => lane.on !== 'ask')

  return agent === '' ? reviewers : reviewers.filter(lane => lane.onAgents)
}

/**
 * Whether a lane may run in this working directory.
 *
 * A lane naming no project runs anywhere, so every lane written before this
 * existed is unchanged. A lane naming projects runs only under one of them,
 * which is what keeps a machine-wide lane that sends evidence to a remote
 * provider from reaching work that should not leave the machine.
 *
 * A name is matched as a path prefix, with a leading `~` standing for the home
 * directory, because that is how the paths are written by hand.
 *
 * @param lane the reviewer
 * @param cwd the session's working directory
 * @param home the home directory, for a `~` prefix
 * @returns whether the lane may run here
 */
export function allowsProject(lane: Lane, cwd: string, home: string): boolean {
  if (lane.projects.length === 0) {
    return true
  }

  const where = String(cwd ?? '')

  return lane.projects.some(entry => {
    const root = entry.startsWith('~/') ? `${home}${entry.slice(1)}` : entry

    return root !== '' && (where === root || where.startsWith(`${root}/`))
  })
}

/**
 * A lane added by `/backseat lane`, which lasts as long as the session.
 *
 * It takes the panel's own provider and confidence floor: a lane written at
 * the prompt is a question someone has right now, and asking them to pick a
 * provider for it would be asking the wrong question.
 *
 * @param name the lane's name
 * @param question the one sentence it asks
 * @param onAgents whether it also reviews what a subagent wrote
 * @param defaults the provider, confidence floor and fallback it inherits
 * @returns the lane
 */
export function sessionLaneOf(
  name: string,
  question: string,
  onAgents: boolean,
  defaults: { provider: string; confidence: number; fallback: string },
): Lane {
  return {
    name,
    question,
    instructions: '',
    provider: defaults.provider,
    command: '',
    model: '',
    docs: [],
    needs: [],
    minConfidence: defaults.confidence,
    severityFloor: '',
    scope: 'session',
    onAgents,
    fallback: defaults.fallback,
    fallbackCommand: '',
    group: name,
    reviewers: [],
    sees: ['diff'],
    on: 'turn',
    projects: [],
  }
}

/**
 * Whether a directory entry is a lane file, by its name.
 *
 * Consumed by the lane loader in `register.ts`, which lists the lane
 * directory and reads what this accepts. A dotfile is skipped so an editor's
 * swap file does not become a reviewer.
 *
 * @param name the entry's name, as `$.fs.list` gives it
 * @returns whether to read it as a lane
 */
export function isLaneFile(name: string): boolean {
  return name.endsWith('.md') && !name.startsWith('.')
}

/**
 * A lane file's name without its extension, which is the lane's name when
 * the frontmatter sets none.
 *
 * @param name the file's name
 * @returns the lane's default name
 */
export function nameOf(name: string): string {
  return name.replace(/\.md$/, '')
}

/**
 * The frontmatter and the body of a lane file, or `undefined` when the file
 * opens with no `---` fence.
 *
 * @param text the file's whole content
 * @returns the frontmatter block and everything after it
 */
function frontmatterOf(
  text: string,
): { head: string; body: string } | undefined {
  const body = String(text ?? '').replace(/^﻿/, '')
  const opened = /^---[ \t]*\r?\n/.exec(body)

  if (opened === null) {
    return undefined
  }

  const rest = body.slice(opened[0].length)
  const closed = /^---[ \t]*$/m.exec(rest)

  if (closed === null || closed.index === undefined) {
    return undefined
  }

  return {
    head: rest.slice(0, closed.index),
    body: rest.slice(closed.index + closed[0].length),
  }
}

/**
 * A comma-separated field as trimmed, non-empty entries.
 *
 * @param value the field's value, absent when the field was not set
 * @returns the entries
 */
function listOf(value: string | undefined): string[] {
  return String(value ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
}

/**
 * Text cut short for a complaint line, so one malformed field cannot print a
 * whole file.
 *
 * @param text the text to cut
 * @returns the text, at most 40 characters
 */
function cut(text: string): string {
  return text.length > 40 ? `${text.slice(0, 39)}…` : text
}
