import type { Finding, LaneResult } from '../verdict'

/**
 * Every lane that reported a finding, as one label.
 *
 * A subject two reviewers reached from different questions is one finding
 * with both their names on it, and the agreement is worth saying: it is the
 * difference between one reviewer's opinion and two.
 *
 * @param finding the finding to label
 * @returns the lane names, joined
 */
function sourceOf(finding: Finding): string {
  return [finding.lane, ...finding.alsoFrom].join('+')
}

/**
 * The text a held turn is stopped with: what was found and where, and the
 * one instruction that resolves it.
 *
 * Returned by the `classic.Stop` hook as its `block` reason under the
 * `severity` and `block` enforcement modes.
 *
 * @param blocking the findings that hold the turn
 * @returns the reason the turn is held
 */
export function holdReason(blocking: readonly Finding[]): string {
  const lines = blocking.map(
    finding =>
      `- [${sourceOf(finding)}/${finding.severity}] ${finding.file}:${finding.lineStart} — ${finding.title}` +
      (finding.recommendation !== ''
        ? ` (fix: ${finding.recommendation})`
        : ''),
  )

  return [
    `The backseat panel is holding this turn on ${blocking.length} finding(s):`,
    ...lines,
    'Check each against the code before acting — a reviewer can be wrong.',
    'Fix what is right, say why for what is not, then finish.',
  ].join('\n')
}

/**
 * The findings as context for the model, under the delivering enforcement.
 *
 * This is what makes `deliver` more than a drawing: the person sees the
 * cards and the model sees this, so a finding can be acted on without
 * anyone pressing a button. It says the findings are advisory and that each
 * must be verified, because three reviewers obeyed rather than checked
 * would be three unreviewed authors.
 *
 * @param current the findings the panel is holding
 * @returns one block of text for the model
 */
export function context(current: readonly Finding[]): string {
  const lines = current.map(
    finding =>
      `- [${sourceOf(finding)}/${finding.severity}, confidence ${finding.confidence.toFixed(2)}] ` +
      `${finding.file}:${finding.lineStart}-${finding.lineEnd} — ${finding.title}. ${finding.body}` +
      (finding.reference !== '' ? ` About: ${finding.reference}.` : '') +
      (finding.recommendation !== ''
        ? ` Suggested: ${finding.recommendation}`
        : ''),
  )

  return [
    'The backseat review panel looked at the change you just made and reported the',
    'following. These are advisory: they do not hold the turn, and a reviewer can be',
    'wrong. Verify each against the code. Raise the ones that hold with the person',
    'rather than silently acting on them.',
    '',
    ...lines,
  ].join('\n')
}

/**
 * What `/backseat` prints: every lane's outcome, then the findings the panel
 * is holding.
 *
 * Lane outcomes are printed even when nothing was found, because a lane that
 * failed and a lane that was clean are the distinction a person needs and the
 * cards cannot show.
 *
 * @param lanes every lane's result from the last review
 * @param open the findings still being drawn
 * @param held the findings ranked but not drawn
 * @returns the command's text
 */
export function listing(
  lanes: readonly LaneResult[],
  open: readonly Finding[],
  held: number,
): string {
  if (lanes.length === 0) {
    return 'No turn has been reviewed yet. A turn that changes no code is never reviewed.'
  }

  const out: string[] = ['Lanes:']

  for (const lane of lanes) {
    out.push(
      `  ${lane.lane}: ${lane.outcome}, ${lane.findings.length} finding(s), ` +
        `${Math.round(lane.latencyMs)}ms` +
        (lane.via !== '' ? ` — answered by ${lane.via}, its fallback` : '') +
        (lane.detail !== '' ? ` — ${lane.detail}` : ''),
    )

    // What the reviewer said that did not become a finding: the prose of an
    // answer in no shape the parser reads, or a provider's own words about
    // why it would not answer. It goes under its lane rather than into the
    // one-line detail, because it is the part worth reading in full.
    if (lane.notes !== '') {
      for (const line of lane.notes.split(/\r?\n/)) {
        if (line.trim() !== '') {
          out.push(`      ${line.trim()}`)
        }
      }
    }
  }

  if (open.length === 0) {
    out.push('', 'Nothing open.')

    return out.join('\n')
  }

  out.push('', 'Open findings:')

  for (const finding of open) {
    out.push(
      `  [${sourceOf(finding)}/${finding.severity}] ${finding.file}:${finding.lineStart}-${finding.lineEnd}`,
      `    ${finding.title}`,
      finding.recommendation !== '' ? `    fix: ${finding.recommendation}` : '',
    )
  }

  if (held > 0) {
    out.push('', `${held} further finding(s) held.`)
  }

  return out.filter(line => line !== '').join('\n')
}

/**
 * One provider's availability, as the setup probe found it.
 *
 * `detail` is the version line when the probe answered and the reason when
 * it did not, so a lane set to a provider that is not installed says which
 * of the two happened instead of reporting a failed review later.
 */
export type LaneRow = {
  name: string
  provider: string
  model: string
  needs: readonly string[]
  docs: readonly string[]
  instructions: boolean
  minConfidence: number
  severityFloor: string
  scope: string
  onAgents: boolean
  fallback: string
  sees: readonly string[]
  on: string
}

/**
 * One lane directory as the setup report prints it: where it is, which tier
 * it serves, and how many lanes were read out of it.
 *
 * A machine-wide lane that is not running is nearly always a path question,
 * so the path is printed whether or not anything was found there.
 */
export type LaneDirReport = {
  scope: string
  path: string
  found: number
  isPresent: boolean
}

export type Probe = {
  provider: string
  isReady: boolean
  detail: string
}

/**
 * What `/backseat setup` prints: whether each provider a lane names can be
 * reached, the lane roster as it actually resolved, the order the lanes will
 * run in, and anything wrong with a lane file.
 *
 * This is the answer to "why did nothing happen": a lane whose provider is
 * missing, a lane file with a misspelled field, and a `needs` that formed a
 * cycle are all visible here and nowhere else.
 *
 * @param probes one entry per distinct provider the lanes name
 * @param waves the lanes grouped in run order
 * @param dirs the lane directories, where they are and what came out of them
 * @param docs the shared documents that resolved, and the ones that did not
 * @param problems complaints from reading the lane directories
 * @returns the command's text
 */
export function setupReport(
  probes: readonly Probe[],
  waves: readonly LaneRow[][],
  dirs: readonly LaneDirReport[],
  docs: { found: readonly string[]; missing: readonly string[] },
  problems: readonly string[],
  purpose: string,
): string {
  const out: string[] = ['Providers:']

  if (probes.length === 0) {
    out.push('  none — every lane is off, or no lane is configured')
  }

  for (const probe of probes) {
    out.push(
      `  ${probe.provider}: ${probe.isReady ? 'installed' : 'NOT USABLE'} — ${probe.detail}`,
    )
  }

  if (probes.some(probe => probe.isReady)) {
    out.push(
      '  (installed means the command runs and answers its version. A sign-in',
      '  that has expired, or a usage limit that is spent, shows up only when a',
      '  lane actually runs.)',
    )
  }

  for (const line of laneLines(waves)) {
    out.push(line)
  }

  out.push('', 'Lane directories:')

  for (const dir of dirs) {
    out.push(
      `  ${whereOf(dir.scope)}: ${dir.path} — ` +
        (dir.isPresent
          ? `${dir.found} lane file(s)`
          : 'not there yet, so nothing is read from it'),
    )
  }

  out.push('', 'Shared documents:')

  if (docs.found.length === 0 && docs.missing.length === 0) {
    out.push('  none configured — lanes judge against the diff alone')
  }

  for (const path of docs.found) {
    out.push(`  ${path}: read`)
  }

  for (const path of docs.missing) {
    out.push(`  ${path}: not found, skipped`)
  }

  out.push('', 'Purpose:')
  out.push(
    purpose === ''
      ? '  none set — /backseat purpose <what this work is for>'
      : `  ${purpose}`,
  )

  if (problems.length > 0) {
    out.push('', 'Lane files:')

    for (const problem of problems) {
      out.push(`  ${problem}`)
    }
  }

  return out.join('\n')
}

/**
 * The lane roster as lines: one block per wave, each lane with the provider
 * and model it will actually ask and the floors it will actually apply.
 *
 * Shared by `/backseat setup` and `/backseat lanes` so the two can never
 * disagree about what is configured.
 *
 * @param waves the lanes grouped in run order
 * @returns the lines, headed by "Lanes, in the order they run:"
 */
function laneLines(waves: readonly LaneRow[][]): string[] {
  const out: string[] = ['', 'Lanes, in the order they run:']

  if (waves.length === 0) {
    out.push('  none configured')
  }

  waves.forEach((wave, index) => {
    out.push(`  wave ${index + 1}:`)

    for (const lane of wave) {
      const bits = [lane.provider + (lane.model !== '' ? `/${lane.model}` : '')]

      bits.push(whereOf(lane.scope))

      // What a lane looks at is said only when it is not the ordinary one, so
      // a roster of reviewers reads the way it did before.
      const sees = lane.sees ?? []

      if (sees.includes('transcript')) {
        bits.push(
          sees.includes('diff')
            ? 'reads the transcript and the change'
            : 'reads the transcript',
        )
      }

      if (lane.on === 'ask') {
        bits.push('waits to be asked')
      }

      // `off` is how a lane file says it has no fallback, so saying it "falls
      // back to off" would report the absence as a destination.
      if (lane.fallback !== '' && lane.fallback !== 'off') {
        bits.push(`falls back to ${lane.fallback}`)
      }

      if (lane.onAgents) {
        bits.push("also on agents' turns")
      }

      if (lane.needs.length > 0) {
        bits.push(`reads ${lane.needs.join('+')}`)
      }

      if (lane.docs.length > 0) {
        bits.push(`docs ${lane.docs.join(' ')}`)
      }

      if (lane.instructions) {
        bits.push('has instructions')
      }

      bits.push(`confidence ≥ ${lane.minConfidence}`)

      if (lane.severityFloor !== '') {
        bits.push(`severity ≥ ${lane.severityFloor}`)
      }

      out.push(`    ${lane.name}: ${bits.join(' · ')}`)
    }
  })

  return out
}

/**
 * A lane's tier in words.
 *
 * The tier answers "why is this reviewer running here", which a bare scope
 * name does not: a person reading the roster wants to know whether to edit a
 * file in this repository, a file on the machine, or the options.
 *
 * @param scope the lane's tier
 * @returns the words for it
 */
function whereOf(scope: string): string {
  if (scope === 'user') {
    return 'machine-wide'
  }

  if (scope === 'project') {
    return 'from this repo'
  }

  if (scope === 'session') {
    return 'this session only'
  }

  return 'from options'
}

/**
 * What `/backseat lanes` prints: the roster and the purpose, without
 * probing a provider.
 *
 * `setup` runs a process per provider to answer "can this be reached"; this
 * answers the cheaper and more frequent question, "what is configured".
 *
 * @param waves the lanes grouped in run order
 * @param purpose what the person said the work is for
 * @param problems complaints and notes from reading the lane directories
 * @returns the command's text
 */
export function lanesReport(
  waves: readonly LaneRow[][],
  purpose: string,
  problems: readonly string[],
): string {
  const out = laneLines(waves).slice(1)

  out.push('', 'Purpose:')
  out.push(
    purpose === ''
      ? '  none set — /backseat purpose <what this work is for>'
      : `  ${purpose}`,
  )

  if (problems.length > 0) {
    out.push('', 'Lane files:')

    for (const problem of problems) {
      out.push(`  ${problem}`)
    }
  }

  return out.join('\n')
}

/**
 * What `/backseat cancel` prints.
 *
 * It says plainly what cancelling does and does not do: the panel stops
 * waiting and discards the answers, and a subprocess already started runs to
 * its own timeout because `$.process.run` offers no way to end it. Claiming
 * a kill that did not happen would be worse than the limitation.
 *
 * @param lanes the lanes that were in flight
 * @returns the command's text
 */
export function cancelReport(lanes: readonly string[]): string {
  if (lanes.length === 0) {
    return 'No review is in flight.'
  }

  return [
    `Stopped waiting on ${lanes.length} lane(s): ${lanes.join(', ')}.`,
    'Their answers will be discarded when they arrive.',
    'A provider subprocess that has already started runs to its own timeout;',
    'this cancels the panel, not the child process.',
  ].join('\n')
}

/**
 * What `/backseat help` prints, and what a bad subcommand prints under its
 * complaint.
 *
 * @returns the command's text
 */
export function helpText(): string {
  return [
    '/backseat                      what the last review found, and which lanes ran',
    '/backseat review [--base <ref>] [--lanes a,b]',
    '                               review now, instead of waiting for the next',
    '                               turn that changes code; --base diffs against a',
    '                               ref rather than the working tree',
    '/backseat clean                what in this session\'s own transcript no longer',
    '                               needs to stay, from the lanes that read it',
    '/backseat forget <what>        ask the cleaner to find and release that, past the rules',
    '/backseat rehydrate <ref>      fetch a reclaimed message back by the reference',
    '                               a finding named',
    '/backseat setup                whether each provider can be reached, the lane',
    '                               roster, the run order, and lane-file problems',
    '/backseat lanes                the roster and the purpose, without probing',
    '/backseat purpose <text>       what this work is for; every lane is told it',
    '/backseat purpose --clear      forget it',
    '/backseat model <model>        change the model every lane asks',
    '/backseat model <lane> <model> change one lane\'s model ("default" to undo)',
    '/backseat lane <name> <question> [--agents]',
    '                               add a reviewer for this session alone',
    '/backseat lane <name> --clear  remove it; --clear alone removes them all',
    '/backseat cancel               stop the panel waiting on a review in flight',
    '/backseat help                 this',
    '',
    'A lane is defined in full by a file: frontmatter for provider, reviewers,',
    'fallback, command, model, question, docs, needs, severity, confidence and',
    "agents, then the body as that reviewer's standing instructions.",
    '',
    'Every lane in the roster reviews each turn that changes code — the diff is',
    "taken against the commit each repository was on when the turn's first edit",
    'landed, so work the turn committed itself is reviewed too, as is work it',
    'left uncommitted. Nothing waits for a commit.',
    '',
    'reviewers asks the same question of several providers at once, and what two',
    'of them agree on becomes one finding naming both. fallback is the other',
    'thing: a substitute asked only when a provider fails — could not be run,',
    'exited badly, timed out, or answered with no verdict. A clean review is a',
    'complete answer and is never retried. One retry, not a chain.',
    '',
    'An account out of quota is remembered for 15 minutes: its lanes are then',
    'skipped without a process being started, never failed and never clean,',
    "with the provider's own words — reset time included — kept as the lane's",
    'note. When every reviewer a turn could ask is spent, the review is',
    'abandoned before the diff is taken. A reviewer nobody could ask has not',
    'approved the change.',
    '',
    'Whatever a reviewer said that did not become a finding is kept as its',
    'notes and printed under its row, so an answer that missed the format is',
    'still readable.',
    '',
    'sees says what a lane is shown: diff, the change a turn made, which is',
    'the default; transcript, this session\'s own history, for a lane asking',
    'what no longer needs to stay in it; or both, which is one reviewer whose',
    'subject covers the conversation as well as the code. on says when it',
    'runs: turn, or ask. A lane reading the transcript defaults to ask,',
    'because that evidence is the session rather than the turn.',
    '',
    '/backseat clean asks the transcript-reading lanes now. The transcript is',
    'cut into windows that each fit one question, every lane is asked about',
    'every window, and a lane is asked of the provider it names and no other.',
    'Nothing is edited: the cards say what looks reclaimable and where.',
    '',
    'refine: on makes a compaction hand back the engine\'s own messages minus',
    'what was released, instead of a summary. A survivor is kept by its handle,',
    'so it stands exactly as it was: nothing is paraphrased and nothing is',
    'rebuilt. A call and its result are never separated, the newest messages',
    'are never released, and a refinement freeing less than a tenth of the',
    'conversation is not installed — the engine summarises instead.',
    '',
    'refineAtPercent arms it: a turn ending with the context window that full',
    'starts a refinement, so the conversation is thinned before the engine',
    'would have compacted it.',
    '',
    'Rules run before any provider does. What a session returns to — an error,',
    'a measurement, a decision, the words of the person whose session it is —',
    'is never reclaimable. What the newest work still names is reached and',
    'kept. A tool call whose input repeats an earlier one is reported without',
    'a provider at all. Only the residue, which no rule settled, is asked',
    'about, and the summary says what share that was.',
    '',
    'Every finding names a reference like m41.ab12cd34. /backseat rehydrate',
    'fetches that message back out of the transcript, so a reduction is a',
    'cache miss rather than a loss.',
    '',
    'Where the file sits is how far the reviewer reaches. Under laneDir',
    '(.backseat/lanes) it reviews this repository. Under userLaneDir',
    '(~/.claude/backseat/lanes) it reviews every repository on the machine, which',
    'is where a coding-pattern reviewer belongs. A name defined in both is the',
    "repository's, whole, so a repo can retune or park a machine-wide lane.",
    '',
    "A lane reviews the main loop's turns. Add agents: true, or --agents, and it",
    "also reviews each subagent's own turn, so delegated work is reviewed too.",
    '',
    'Options are read by /config, user settings or `claude plugin configure` —',
    'not --settings. Lane files need no settings at all.',
  ].join('\n')
}
