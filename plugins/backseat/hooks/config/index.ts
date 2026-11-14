import type { PluginOptions } from 'claude-code'

/**
 * A severity, ordered: `RANK` gives each one its place, and
 * `atOrAbove` compares two by it.
 */
export type Severity = 'critical' | 'high' | 'medium' | 'low'

/**
 * What a finding does once a lane reports it. `deliver` draws it and nothing
 * else; `severity` also holds the turn when the finding is at or above
 * `blockFrom`; `block` holds the turn for any finding. Read by the
 * `classic.Stop` hook in `register.ts`, which allows every turn under
 * `deliver`.
 */
export type Enforcement = 'deliver' | 'severity' | 'block'

/**
 * One reviewer: the question it asks, the standing instructions it asks it
 * under, who answers it, what it reads, and the floors its answers clear.
 *
 * `name` keys the lane's findings in the store and labels its card.
 * `question` is the one sentence the lane's prompt is built around, and
 * `instructions` is the free text a lane file adds under it — the standing
 * rules that make a reviewer useful on one repository rather than in
 * general. `provider` names the adapter that answers it, `model` the model
 * to ask for or empty for the provider's own default, and `docs` the
 * documents this lane reads on top of the shared ones.
 *
 * `needs` names the lanes whose findings this lane is given as evidence. It
 * is the cross-link, and because a lane cannot read findings that do not
 * exist yet it is also the run order: `wavesOf` derives the waves from it.
 *
 * `minConfidence` and `severityFloor` are this lane's own floors. A lane
 * that is noisier than the others can be held to a higher bar without
 * raising the bar for every lane.
 *
 * `fallback` names a second provider to ask when the first one fails — not
 * when it answers that it found nothing, which is a complete review, but
 * when it could not be run, exited badly, timed out, or answered in a shape
 * with no verdict in it. A spent usage limit, an expired sign-in and a
 * missing binary all look like that, and they are the common reasons a panel
 * goes quiet without saying so. `fallbackCommand` is the template its
 * provider resolved to, filled in by the lane loader exactly as `command` is.
 */
export type Lane = {
  name: string
  question: string
  instructions: string
  provider: string
  command: string
  model: string
  docs: readonly string[]
  needs: readonly string[]
  minConfidence: number
  severityFloor: Severity | ''
  scope: LaneScope
  onAgents: boolean
  fallback: string
  fallbackCommand: string
  group: string
  reviewers: readonly string[]
  sees: readonly Sight[]
  on: Trigger
  projects: readonly string[]
}

/**
 * What a lane is shown.
 *
 * `diff` is the change the turn made, which is what every reviewer is asked
 * about by default. `transcript` is the session's own history, which is what a
 * lane looking for what no longer needs to stay in context is asked about. A
 * lane may name both, and is then shown the transcript a window at a time with
 * the change attached to each one.
 *
 * This is a property of a lane rather than a kind of lane, so that what a
 * reviewer looks at and what it asks stay independent: a lane enforcing a
 * standing rule can read the conversation as well as the diff without becoming
 * a different sort of thing.
 */
export type Sight = 'diff' | 'transcript'

/** The sights, for reading them out of a lane file. */
export const SIGHTS: readonly Sight[] = ['diff', 'transcript']

/**
 * When a lane runs.
 *
 * `turn` is every turn that changes code. `ask` is only when it is asked for
 * by name, which is what a lane reading a whole transcript wants: that
 * evidence is the session rather than the turn, so paying for it on every turn
 * would cost more than the work being reviewed.
 *
 * A lane that reads the transcript defaults to `ask` for that reason, and may
 * still be set to `turn` by anyone willing to pay for it.
 */
export type Trigger = 'turn' | 'ask'

/** The triggers, for reading one out of a lane file. */
export const TRIGGERS: readonly Trigger[] = ['turn', 'ask']

/**
 * Where a lane was defined, which is what decides who it reviews for.
 *
 * `config` is a lane named in the options, `user` a file in the user lane
 * directory, which applies in every repository on the machine, `project` a
 * file in the repository's own lane directory, and `session` a lane added by
 * `/backseat lane`, which lasts as long as the session does.
 *
 * The order is the precedence: a name defined twice is kept once, by the
 * most specific tier that defines it, so a repository can retune or park a
 * machine-wide reviewer without the machine-wide file knowing about it.
 */
export type LaneScope = 'config' | 'user' | 'project' | 'session'

/**
 * The tiers, least specific first. `mergeLanes` reads this order as its
 * precedence, and the setup report prints a lane's tier so that "why is this
 * reviewer running here" has an answer.
 */
export const SCOPES: readonly LaneScope[] = [
  'config',
  'user',
  'project',
  'session',
]

/**
 * Everything the hooks read, derived once from the manifest's `userConfig`
 * when `register` runs.
 *
 * Built by `read` and consumed by every hook in `register.ts`; the pure
 * modules take the fields they need rather than the whole of it, so a lane
 * prompt cannot come to depend on a delivery limit.
 *
 * There are two lane directories because a reviewer has two useful reaches.
 * `laneDir` is inside the repository, for the reviewers that only make sense
 * against this code. `userLaneDir` is outside it, for the ones that make
 * sense against all of it — a coding-pattern reviewer belongs there, read in
 * every repository on the machine. Empty means the default beside the user's
 * other Claude configuration, which `register` resolves since only it can
 * read the environment.
 */
export type Config = {
  lanes: readonly Lane[]
  laneDir: string
  userLaneDir: string
  refine: string
  refineAtPercent: number
  autofix: string
  fallback: string
  providers: readonly string[]
  claudeModel: string
  enforcement: Enforcement
  blockFrom: Severity
  specDocs: readonly string[]
  designDocs: readonly string[]
  crossLink: boolean
  everyTurns: number
  maxConcurrency: number
  maxCards: number
  timeoutMs: number
  minConfidence: number
  debug: boolean
}

/**
 * The severities, worst first. The index is the rank `atOrAbove` and the
 * card ranking in `deliver` compare on, so the order of this list is the
 * meaning of "more severe".
 */
export const RANK: readonly Severity[] = ['critical', 'high', 'medium', 'low']

/**
 * The provider names an adapter exists for, plus `off`. A lane naming
 * anything else is dropped by `read`, because a typo in a provider name must
 * not silently become a lane that reviews nothing while appearing to be on.
 */
export const PROVIDERS: readonly string[] = ['claude', 'fork', 'kimi', 'codex', 'off']

/**
 * The lanes the plugin ships, by name: the question each one asks and the
 * lanes it reads.
 *
 * `docs` needs the other two because its question is about what they found:
 * a rewrite the `reuse` lane names is a document the `docs` lane must then
 * check, and that evidence only exists once `reuse` has answered.
 */
const BUILT_IN: Readonly<
  Record<string, { question: string; needs: readonly string[] }>
> = {
  spec: {
    question:
      'Does this change do what the documents that govern it say, and only that?',
    needs: [],
  },
  reuse: {
    question:
      'Does this change rewrite behaviour the repository already has somewhere else?',
    needs: [],
  },
  docs: {
    question:
      'Which design documents does this change make untrue, and what is the correcting edit?',
    needs: ['spec', 'reuse'],
  },
}

/**
 * Whether `severity` is as severe as `floor` or worse, by `RANK`.
 *
 * Used by the `classic.Stop` hook to pick the findings that hold a turn and
 * by `deliver` to mark a card as blocking.
 *
 * @param severity the finding's severity
 * @param floor the severity the comparison is against
 * @returns whether the finding is at or above the floor
 */
export function atOrAbove(severity: Severity, floor: Severity): boolean {
  return RANK.indexOf(severity) <= RANK.indexOf(floor)
}

/**
 * Reads the manifest's options into the `Config` the hooks use, dropping
 * what cannot be honoured rather than guessing at it.
 *
 * A lane survives only if it has a question (built in, or given in
 * `customLanes`) and a provider an adapter exists for. A number is clamped
 * into the range its hook can actually work in: a `maxConcurrency` of zero
 * would review nothing while reporting that it reviewed, and a `timeoutMs`
 * under a second cannot outlast a provider's own startup.
 *
 * @param options the `userConfig` values, with the manifest's defaults filled in
 * @returns the configuration every hook in `register.ts` reads
 */
export function read(options: PluginOptions): Config {
  const custom = parseCustomLanes(options.customLanes)
  const fallback = text(options.provider, 'claude')
  const named = list(options.lanes, ['spec', 'reuse', 'docs'])

  const confidence = Math.min(1, Math.max(0, number(options.minConfidence, 0.6)))

  const lanes = named
    .map(name =>
      laneOf(name, custom, options, fallback, confidence, text(options.fallback, '')),
    )
    .filter((lane): lane is Lane => lane !== undefined)
    .filter(lane => lane.provider !== 'off')

  return {
    lanes,
    laneDir: text(options.laneDir, '.backseat/lanes'),
    userLaneDir: text(options.userLaneDir, ''),
    refine: text(options.refine, 'off') === 'on' ? 'on' : 'off',
    autofix: text(options.autofix, 'off') === 'on' ? 'on' : 'off',
    refineAtPercent: Math.max(
      0,
      Math.min(100, Number(options.refineAtPercent ?? 0) || 0),
    ),
    fallback: text(options.fallback, ''),
    providers: list(options.providers, [], ';'),
    claudeModel: text(options.claudeModel, 'sonnet'),
    enforcement: enforcementOf(options.enforcement),
    blockFrom: severityOf(options.blockFrom, 'high'),
    specDocs: list(options.specDocs, []),
    designDocs: list(options.designDocs, []),
    crossLink: flag(options.crossLink, true),
    everyTurns: Math.max(1, Math.trunc(number(options.everyTurns, 1))),
    maxConcurrency: Math.min(
      8,
      Math.max(1, Math.trunc(number(options.maxConcurrency, 2))),
    ),
    maxCards: Math.min(4, Math.max(1, Math.trunc(number(options.maxCards, 3)))),
    timeoutMs: Math.min(
      600000,
      Math.max(1000, Math.trunc(number(options.timeoutMs, 300000))),
    ),
    minConfidence: confidence,
    debug: flag(options.debug, false),
  }
}

/**
 * The lane for one name, or `undefined` when nothing gives it a question.
 *
 * A name in `customLanes` wins over a built-in of the same name, so a
 * sharper question can replace a shipped one without renaming the lane and
 * losing its stored findings. A lane file wins over both, and is merged in by
 * the loader rather than here, because reading it needs the filesystem and
 * only the loader knows which tier the file sat in.
 *
 * @param name the lane's name, as `lanes` lists it
 * @param custom the lanes parsed out of `customLanes`, by name
 * @param options the `userConfig` values, read for the per-lane provider
 * @param fallback the provider a lane with none of its own uses
 * @param confidence the confidence floor a lane with none of its own uses
 * @param second the provider to ask when the first one fails, empty for none
 * @returns the lane, or `undefined` when its name names no question
 */
function laneOf(
  name: string,
  custom: ReadonlyMap<string, { question: string; provider: string }>,
  options: PluginOptions,
  fallback: string,
  confidence: number,
  second: string,
): Lane | undefined {
  const own = custom.get(name)
  const built = BUILT_IN[name]

  if (own === undefined && built === undefined) {
    return undefined
  }

  const asked = text(options[`${name}Provider`], 'default')
  const chosen = own?.provider ?? ''
  const provider =
    asked !== 'default' ? asked : chosen !== '' ? chosen : fallback

  // A provider name is not checked here. Only the lane loader has read the
  // `providers` templates, so it is the one that can tell a template-defined
  // provider from a typo, and it reports the typo rather than dropping the
  // lane silently.

  return {
    name,
    question: own?.question ?? built?.question ?? '',
    instructions: '',
    provider,
    command: '',
    model: '',
    docs: [],
    needs: built?.needs ?? [],
    minConfidence: confidence,
    severityFloor: '',
    scope: 'config',
    onAgents: false,
    fallback: second,
    fallbackCommand: '',
    group: name,
    reviewers: [],
    // A lane named in the options reviews the turn's change: reading the
    // transcript needs a question about it, which only a lane file carries.
    sees: ['diff'],
    on: 'turn',
    projects: [],
  }
}

/**
 * The lanes written in `customLanes`, by name.
 *
 * Each entry is `name|provider|question`; the provider may be empty to mean
 * the default. An entry without a question is dropped, because a lane whose
 * prompt has no question asks the reviewer to invent one.
 *
 * Entries are separated by semicolons, not commas, because a lane's
 * question is a sentence and sentences contain commas.
 *
 * @param raw the `customLanes` option
 * @returns the parsed lanes, by name
 */
function parseCustomLanes(
  raw: unknown,
): ReadonlyMap<string, { question: string; provider: string }> {
  const out = new Map<string, { question: string; provider: string }>()

  for (const entry of list(raw, [], ';')) {
    const parts = entry.split('|')
    const name = (parts[0] ?? '').trim()
    const provider = (parts[1] ?? '').trim()
    const question = parts.slice(2).join('|').trim()

    if (name !== '' && question !== '') {
      out.set(name, { question, provider })
    }
  }

  return out
}

/**
 * The enforcement mode an option names, `deliver` for anything else.
 *
 * Defaulting an unreadable value to `deliver` keeps a malformed setting from
 * holding turns: the failure a person cannot explain must be the quiet one.
 *
 * @param raw the `enforcement` option
 * @returns the mode the `classic.Stop` hook reads
 */
function enforcementOf(raw: unknown): Enforcement {
  return raw === 'severity' || raw === 'block' ? raw : 'deliver'
}

/**
 * The severity an option names, or `fallback`.
 *
 * @param raw the option's value
 * @param fallback the severity to use when the value names none
 * @returns a severity in `RANK`
 */
function severityOf(raw: unknown, fallback: Severity): Severity {
  return RANK.includes(raw as Severity) ? (raw as Severity) : fallback
}

/**
 * A string option, or `fallback` when it is absent or empty.
 *
 * @param raw the option's value
 * @param fallback the string to use instead
 * @returns the trimmed string
 */
function text(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : fallback
}

/**
 * A number option, or `fallback` when it is not a finite number.
 *
 * @param raw the option's value
 * @param fallback the number to use instead
 * @returns a finite number
 */
function number(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

/**
 * A boolean option, or `fallback` when it is not a boolean.
 *
 * @param raw the option's value
 * @param fallback the boolean to use instead
 * @returns the flag
 */
function flag(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback
}

/**
 * A list option as trimmed, non-empty strings.
 *
 * A list is written as one string because `userConfig` declares only
 * `string`, `number`, `boolean`, `directory` and `file`; an array is
 * accepted too, so a value set directly in `pluginConfigs` rather than
 * through `/config` reads the same way.
 *
 * @param raw the option's value, a separated string or an array
 * @param fallback the list to use when the option holds nothing
 * @param separator the character between entries
 * @returns the cleaned list
 */
function list(
  raw: unknown,
  fallback: readonly string[],
  separator = ',',
): string[] {
  const from = Array.isArray(raw)
    ? raw
    : typeof raw === 'string' && raw.trim() !== ''
      ? raw.split(separator)
      : fallback

  return from
    .map(entry => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(entry => entry !== '')
}

/**
 * Whether a finding of this severity holds the turn, under the configured
 * enforcement.
 *
 * Read by the `classic.Stop` hook to pick the findings that hold a turn and
 * by the card view to mark a card as blocking, so the drawing and the
 * decision can never disagree.
 *
 * @param config the enforcement mode and the severity floor
 * @param severity the finding's severity
 * @returns whether a finding of that severity holds the turn
 */
export function isBlocking(config: Config, severity: Severity): boolean {
  if (config.enforcement === 'deliver') {
    return false
  }

  return config.enforcement === 'block' || atOrAbove(severity, config.blockFrom)
}
