/**
 * How to run one reviewer as a subprocess: what to execute, what to send it,
 * and how to find its answer in what comes back.
 *
 * Built by `invocationFor` and consumed by the single `$.process.run` call in
 * `register.ts`, which is the only place a provider's process is started.
 * Keeping the shape to data means a new provider is a new entry in
 * `DESCRIPTORS` rather than a new branch at the call site.
 */
export type Invocation = {
  argv: readonly string[]
  stdin: string
  env: Readonly<Record<string, string>>
}

/**
 * One provider's command line.
 *
 * `args` are the descriptor's own words and come first, because they may
 * name a subcommand; the model and schema flags are appended after them, since
 * a flag belonging to a subcommand is rejected as unknown when it is placed
 * ahead of it. `stdinArg` is the word such a CLI wants last to mean "read the
 * prompt from standard input".
 *
 * `promptVia` says where the prompt goes: `stdin` for a CLI that reads
 * instructions from standard input, `argv` for one that takes them as an
 * argument. A long diff makes `argv` the riskier of the two, so a provider
 * is given `stdin` wherever its CLI supports it.
 *
 * `schemaVia` names the flag that makes the provider enforce the answer
 * shape itself, if it has one. A provider that can be held to the schema
 * needs no tolerance from the parser; one that cannot relies on it.
 *
 * `answerFrom` says how to read the final answer out of standard output:
 * `text` when the whole of stdout is the answer, `jsonl` when stdout is a
 * stream of events and the answer is the last one carrying text.
 */
type Descriptor = {
  bin: string
  args: readonly string[]
  promptVia: 'stdin' | 'argv'
  stdinArg?: string
  promptFlag?: string
  schemaVia?: string
  answerFrom: 'text' | 'jsonl'
  versionArgs: readonly string[]
}

/**
 * The providers with a subprocess adapter, by the name the `provider`
 * options use. `fork` is absent on purpose: it is answered by
 * `$.model.fork` inside `register.ts` and never spawns anything.
 *
 * The flags are the ones each CLI documents for a non-interactive,
 * read-only, non-persisting run:
 *
 * `codex exec` takes `-` to read the prompt from standard input, `--sandbox
 * read-only` so a reviewer cannot edit the tree it is reviewing,
 * `--ephemeral` so a review leaves no session behind, `--skip-git-repo-check`
 * so a non-repository workspace still reviews, and `--output-schema` so the
 * answer shape is enforced by the provider rather than hoped for.
 *
 * `kimi -p` takes the prompt as an argument and prints the response;
 * `--output-format text` is its default and is named anyway, so a change of
 * default cannot turn the answer into a stream the parser is not reading.
 */
const DESCRIPTORS: Readonly<Record<string, Descriptor>> = {
  codex: {
    bin: 'codex',
    args: [
      'exec',
      '--sandbox',
      'read-only',
      '--ephemeral',
      '--skip-git-repo-check',
      '--color',
      'never',
    ],
    promptVia: 'stdin',
    stdinArg: '-',
    schemaVia: '--output-schema',
    answerFrom: 'text',
    versionArgs: ['--version'],
  },
  kimi: {
    bin: 'kimi',
    args: ['--output-format', 'text'],
    promptVia: 'argv',
    promptFlag: '-p',
    answerFrom: 'text',
    versionArgs: ['--version'],
  },
}

/**
 * Whether a provider name has a subprocess adapter.
 *
 * Read by `register.ts` to choose between `$.model.fork` and
 * `$.process.run`, so an unknown provider becomes a skipped lane rather
 * than a spawn of a binary that does not exist.
 *
 * @param provider the lane's provider name
 * @returns whether `invocationFor` can build a command line for it
 */
export function isSubprocess(provider: string): boolean {
  return Object.hasOwn(DESCRIPTORS, provider)
}

/**
 * The command line that asks one provider the lane's prompt.
 *
 * `schemaPath` is used only by a provider whose descriptor names a
 * `schemaVia` flag; for the others it is ignored, and the shape is recovered
 * by the parser instead.
 *
 * @param provider the lane's provider name
 * @param prompt the lane's prompt
 * @param schemaPath the answer schema shipped with this plugin
 * @param model the model to ask for, empty to let the provider choose
 * @returns the invocation, or `undefined` when the provider has no adapter
 */
export function invocationFor(
  provider: string,
  prompt: string,
  schemaPath: string,
  model: string,
): Invocation | undefined {
  const descriptor = DESCRIPTORS[provider]

  if (descriptor === undefined) {
    return undefined
  }

  const argv: string[] = [descriptor.bin]

  // The descriptor's own words come first, because they may name a
  // subcommand: a flag placed ahead of one is read by the wrong parser and
  // the CLI rejects it as unknown, which looks exactly like a CLI that does
  // not support the flag at all.
  for (const arg of descriptor.args) {
    argv.push(arg)
  }

  if (model !== '') {
    argv.push('-m', model)
  }

  if (descriptor.schemaVia !== undefined && schemaPath !== '') {
    argv.push(descriptor.schemaVia, schemaPath)
  }

  if (descriptor.promptVia === 'argv') {
    if (descriptor.promptFlag !== undefined) {
      argv.push(descriptor.promptFlag)
    }

    argv.push(prompt)
  } else if (descriptor.stdinArg !== undefined) {
    argv.push(descriptor.stdinArg)
  }

  return {
    argv,
    stdin: descriptor.promptVia === 'stdin' ? prompt : '',
    env: {},
  }
}

/**
 * The command line that asks a provider for its version, used to tell a
 * provider that is not installed from one that answered badly.
 *
 * @param provider the lane's provider name
 * @returns the argv, or `undefined` when the provider has no adapter
 */
export function probeFor(provider: string): readonly string[] | undefined {
  const descriptor = DESCRIPTORS[provider]

  return descriptor === undefined
    ? undefined
    : [descriptor.bin, ...descriptor.versionArgs]
}

/**
 * The reviewer's answer, out of what its process wrote to standard output.
 *
 * A `jsonl` provider writes one event per line and the answer is the text of
 * the last event that carries any; a `text` provider's whole output is the
 * answer. Either way the result is handed to the verdict parser, which is
 * what decides whether it holds findings.
 *
 * @param provider the lane's provider name
 * @param stdout what the process wrote
 * @returns the answer text, empty when the output carries none
 */
export function answerFrom(provider: string, stdout: string): string {
  const descriptor = DESCRIPTORS[provider]
  const body = String(stdout ?? '')

  if (descriptor === undefined || descriptor.answerFrom === 'text') {
    return body.trim()
  }

  let answer = ''

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()

    if (trimmed === '' || !trimmed.startsWith('{')) {
      continue
    }

    try {
      const event: unknown = JSON.parse(trimmed)
      const text = textOf(event)

      if (text !== '') {
        answer = text
      }
    } catch {
      continue
    }
  }

  return answer.trim()
}

/**
 * The text an event line carries, across the field names providers use for
 * it, or empty when it carries none.
 *
 * The names are tried rather than one being assumed, because an event
 * stream's field naming is the part of a provider's surface most likely to
 * differ between its own versions.
 *
 * @param event one parsed event line
 * @returns the text the event carries
 */
function textOf(event: unknown): string {
  if (typeof event !== 'object' || event === null) {
    return ''
  }

  const record = event as Record<string, unknown>

  for (const key of ['text', 'content', 'message', 'delta', 'result']) {
    const value = record[key]

    if (typeof value === 'string' && value.trim() !== '') {
      return value
    }

    if (typeof value === 'object' && value !== null) {
      const nested = textOf(value)

      if (nested !== '') {
        return nested
      }
    }
  }

  return ''
}

/**
 * Why a fork produced no text, as a line for the debug row.
 *
 * The reason is read defensively rather than destructured, because a build
 * can add an arm to the fork result and a panel that threw on an unknown
 * one would report a working provider as broken.
 *
 * @param reply what `$.model.fork` resolved with
 * @returns the reason, or a line saying the fork answered nothing
 */
export function forkReason(reply: unknown): string {
  if (typeof reply === 'object' && reply !== null && 'reason' in reply) {
    return `the fork did not answer (${String((reply as { reason: unknown }).reason)})`
  }

  return 'the fork did not answer'
}

/**
 * An error as one line.
 *
 * @param error whatever was thrown
 * @returns the message
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The first line of a provider's output, which is its version banner.
 *
 * Read by the provider probe, where the banner is the answer being looked
 * for. A failure is described by `reasonOf` instead, because the first line
 * of a failed run is the banner rather than the cause.
 *
 * @param text the output
 * @returns its first non-empty line, cut to a readable length
 */
export function firstLine(text: string): string {
  const line = lineAt(String(text ?? ''), 0)

  return cut(line === '' ? 'no output' : line)
}

/**
 * The words a provider uses when it is saying why it stopped.
 *
 * A status in the 400s or 500s counts as one of them, since a CLI that
 * passes an HTTP refusal through prints the number and little else.
 */
const MARKS =
  /\b(?:error|fail(?:ed|ure)?|denied|refused|unauthoriz(?:ed)|unauthorised|forbidden|limit|quota|exceeded|expired|timed out|timeout|not found|no such|cannot|can't|unable|invalid|missing|usage)\b|\b[45]\d{2}\b/i

/**
 * Why a provider's process failed, as one line.
 *
 * The first line is the wrong line to quote. Every CLI here prints its own
 * version, and some print a hook's progress, before saying anything about
 * the run — so a reviewer turned away for being out of quota reports as
 * `exited 1: kimi version 2.1.1`, which describes a reviewer that broke and
 * names nothing a person could act on.
 *
 * The line that carries the cause is looked for instead, and the last such
 * line is taken, because a CLI that narrates its way to a failure states the
 * cause after the noise rather than before it. Where no line carries one,
 * the last line is quoted rather than the first, on the same reasoning.
 * Standard error is read ahead of standard output, since a CLI that
 * separates them puts the cause there.
 *
 * @param stderr what the process wrote to standard error
 * @param stdout what it wrote to standard output
 * @param max the longest the line may be; the default suits a one-line row,
 *   and a caller keeping the words to show in full asks for more, since the
 *   part a person needs — a limit's reset time — is at the end of the
 *   sentence rather than the start
 * @returns the line that says why, cut to a readable length
 */
export function reasonOf(stderr: string, stdout: string, max = 160): string {
  const lines = [
    ...linesOf(String(stderr ?? '')),
    ...linesOf(String(stdout ?? '')),
  ]

  if (lines.length === 0) {
    return 'no output'
  }

  const said = lines.filter(line => MARKS.test(line))

  return cut(said.at(-1) ?? lines.at(-1) ?? 'no output', max)
}

/**
 * How a provider says it has nothing left to spend.
 *
 * Measured wordings: codex writes `You've hit your usage limit. Upgrade to
 * Pro … or try again at 4:42 PM`, and kimi writes `provider.auth_error: 403
 * You've reached your 5-hour usage limit. Your quota will reset when the
 * current 5-hour window ends`. A bare 429 counts, since a CLI that passes
 * the status through prints little else.
 *
 * `session limit` is the engine's own wording when a compaction cannot run
 * because the account running the session is spent — `You've hit your session
 * limit · resets 2am`. It reaches this through `$.session.compact`'s error
 * rather than a provider's output, and it is the same thing: something that
 * will refuse again at once and must be waited out rather than retried.
 */
const LIMITED =
  /\b(?:usage limit|rate limit|session limit|quota|out of credit|insufficient_quota|too many requests)\b|\b429\b/i

/**
 * Whether a provider's failure was it refusing for want of quota.
 *
 * This is the one failure worth remembering rather than retrying: a spent
 * limit will refuse the next lane in the same second, and the one after
 * that, so a panel that treats it as an ordinary failure spends every lane
 * and every fallback on a refusal it has already been given — and reports
 * seven broken reviewers where there is one exhausted account.
 *
 * @param detail the failure detail, as `reasonOf` built it
 * @returns whether it names a spent limit
 */
export function isAtLimit(detail: string): boolean {
  return LIMITED.test(String(detail ?? ''))
}

/**
 * How long the engine's own compaction is left alone once it has refused for
 * want of quota.
 */
export const COMPACT_SPENT_WAIT_MS = 1800000

/**
 * Whether the engine's own compaction is still inside the wait a spent limit
 * earned it.
 *
 * A compaction is run by the account running the session rather than by a
 * reviewer, so it carries a limit of its own and refuses again in the same
 * second while that limit is spent. The watcher asks once per turn above its
 * mark, so a refusal with no wait behind it is re-earned on every turn for as
 * long as the account stays spent.
 *
 * `spentAt` of zero means no refusal has been recorded, which is also the
 * reading a clock mocked to zero gives: without the first test a session whose
 * clock starts at zero would hold before it had ever asked.
 *
 * @param now the current clock reading
 * @param spentAt when a refusal naming a spent limit arrived, or 0 for none
 * @returns whether to hold rather than ask again
 */
export function isSpentWait(now: number, spentAt: number): boolean {
  return spentAt > 0 && now - spentAt < COMPACT_SPENT_WAIT_MS
}

/**
 * How long a provider that keeps failing outright is left alone.
 *
 * Shorter than a limit's wait because a hard failure can be transient — a
 * dropped network, a signed-out CLI — where a spent limit is known to last.
 */
export const FAILING_WAIT_MS = 300000

/**
 * How many failures in a row earn that wait.
 *
 * One failure is noise and is retried at once. The count is what separates
 * that from a provider that cannot run at all: `Prompt hook blocked the
 * request` and a timed-out process are not limits, so nothing recorded them,
 * and a cleaner asked on every compaction paid the whole timeout each time.
 */
export const FAILURES_BEFORE_WAIT = 3

/** The wait used when a refusal says nothing about when it lifts. */
export const FLAT_WAIT_MS = 900000

/**
 * The longest a provider is left alone on the strength of its own words.
 *
 * A refusal states a window, not a schedule, and a misread one must not take a
 * provider out of the panel for a working day.
 */
const LIMIT_WAIT_CAP_MS = 21600000

/**
 * How long to leave a provider alone, read from what it said.
 *
 * The flat wait is built for a refusal that says nothing about when it lifts.
 * One that names its window — "you've reached your 5-hour usage limit" — is
 * telling the panel how long to wait, and re-asking every fifteen minutes
 * spends a process to be told the same thing twenty times over.
 *
 * Only a window the refusal states is used, and it is capped: the words are
 * the provider's, and a wait is still a wait rather than the account's own
 * schedule.
 *
 * @param said what the provider wrote when it refused
 * @returns how long to leave it alone, in milliseconds
 */
export function waitFrom(said: string): number {
  const found = /(\d{1,2})\s*-?\s*hour/iu.exec(String(said ?? ''))
  const hours = Number(found?.[1] ?? 0)

  if (!Number.isFinite(hours) || hours <= 0) {
    return FLAT_WAIT_MS
  }

  return Math.min(hours * 3600000, LIMIT_WAIT_CAP_MS)
}

/**
 * The non-empty lines of some output, trimmed.
 *
 * @param text the output
 * @returns its lines, without the blank ones
 */
function linesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
}

/**
 * One line of some output by position, or empty when it has none there.
 *
 * @param text the output
 * @param at the position among the non-empty lines
 * @returns the line
 */
function lineAt(text: string, at: number): string {
  return linesOf(text)[at] ?? ''
}

/**
 * A line at a length a panel row can hold.
 *
 * @param line the line
 * @param max the longest it may be
 * @returns the line, cut with an ellipsis where it was too long
 */
function cut(line: string, max = 160): string {
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * A provider nobody wrote an adapter for, described by its own command line.
 *
 * This is what makes the panel provider-agnostic in practice rather than in
 * principle: a CLI that answers a prompt on standard input or in an argument
 * needs a template, not a code change. `DESCRIPTORS` stays as the tested
 * shape for the two CLIs whose flags are known to work.
 *
 * The template is split on whitespace into argv, so no shell is involved and
 * nothing a prompt contains can become a flag. Three placeholders are
 * substituted:
 *
 * | Placeholder | Becomes |
 * | :- | :- |
 * | `{prompt}` | the whole prompt, as one argument |
 * | `{model}` | the lane's model, or dropped when the lane names none |
 * | `{schema}` | the path to the answer schema |
 *
 * A template with no `{prompt}` sends the prompt on standard input, which is
 * what a CLI that reads instructions from a pipe wants:
 *
 * ```
 * gemini -m {model} -p {prompt}
 * ollama run {model}
 * codex exec --sandbox read-only -
 * ```
 *
 * @param template the command line, with placeholders
 * @param prompt the lane's prompt
 * @param schemaPath the answer schema shipped with this plugin
 * @param model the model to ask for, empty to leave the flag out
 * @returns the invocation, or `undefined` when the template names no command
 */
export function invocationFromTemplate(
  template: string,
  prompt: string,
  schemaPath: string,
  model: string,
): Invocation | undefined {
  const tokens = String(template ?? '')
    .trim()
    .split(/\s+/)
    .filter(token => token !== '')

  if (tokens.length === 0) {
    return undefined
  }

  const argv: string[] = []
  let isPromptInArgv = false

  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at] ?? ''

    if (token === '{prompt}') {
      argv.push(prompt)
      isPromptInArgv = true
      continue
    }

    // A flag whose only value is a model the lane did not name would be sent
    // with an empty argument, which every CLI reads as a bad flag; drop the
    // pair instead.
    if (token.includes('{model}') && model === '') {
      const isFlagBefore = (argv.at(-1) ?? '').startsWith('-')

      if (isFlagBefore) {
        argv.pop()
      }

      continue
    }

    argv.push(
      token.replaceAll('{model}', model).replaceAll('{schema}', schemaPath),
    )
  }

  if (argv.length === 0) {
    return undefined
  }

  return {
    argv,
    stdin: isPromptInArgv ? '' : prompt,
    env: {},
  }
}

/**
 * The named provider templates a `providers` option holds, by name.
 *
 * Each entry is `name = <command template>`, so one template can serve
 * several lanes without being repeated in each lane file.
 *
 * @param entries the `providers` option, already split into entries
 * @returns the templates by provider name, and anything unreadable
 */
export function templatesFrom(
  entries: readonly string[],
): { templates: Map<string, string>; problems: string[] } {
  const templates = new Map<string, string>()
  const problems: string[] = []

  for (const entry of entries) {
    const at = entry.indexOf('=')

    if (at <= 0) {
      problems.push(`provider "${entry}" is not name = command`)
      continue
    }

    const name = entry.slice(0, at).trim()
    const template = entry.slice(at + 1).trim()

    if (name === '' || template === '') {
      problems.push(`provider "${entry}" is not name = command`)
      continue
    }

    templates.set(name, template)
  }

  return { templates, problems }
}
