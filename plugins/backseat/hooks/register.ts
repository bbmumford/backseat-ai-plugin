import type {
  EngineInterface,
  On,
  PluginOptions,
  SessionMessage,
} from 'claude-code'

import { parseArgs } from './args'
import type { Entry } from './cleaner'
import { claimedChars, redactWindow, summaryLine, windowsOf } from './cleaner'
import type { Framing, Row, Verdict } from './refine'
import {
  combine,
  measure,
  neededFrom,
  printOf,
  releases,
  rehydrationFor,
  repeatedCalls,
  residueOf,
  shortened,
  matchedBy,
  survivorsOf,
  tiersOf,
  worthInstalling,
} from './refine'
import type { Config, Lane, LaneScope } from './config'
import { PROVIDERS, atOrAbove, isBlocking, read as readConfig } from './config'
import { panelOf } from './deliver'
import type { Card } from './deliver'
import {
  absolute,
  byRepo,
  dirOf,
  distinctPaths,
  fitDiff,
  fitDocs,
  isEditTool,
  laneDirsFor,
  laneRootOf,
  newFileDiff,
  pathOf,
} from './evidence'
import type { Snapshot } from './writes'
import {
  SNAPSHOT_LIMIT,
  appearedIn,
  changedPaths as changedWatched,
  isEphemeral,
  unifiedDiff,
  writeTargetsOf,
} from './writes'
import type { Evidence } from './lanes'
import {
  batches,
  explainPrompt,
  fixPrompt,
  inputsFor,
  promptFor,
  wavesOf,
} from './lanes'
import {
  allowsProject,
  isLaneFile,
  laneFrom,
  lanesForTurn,
  mergeLanes,
  nameOf,
  sessionLaneOf,
} from './lanefile'
import {
  answerFrom,
  firstLine,
  FAILING_WAIT_MS,
  FAILURES_BEFORE_WAIT,
  isAtLimit,
  isSpentWait,
  reasonOf,
  forkReason,
  invocationFor,
  invocationFromTemplate,
  isSubprocess,
  messageOf,
  probeFor,
  waitFrom,
  templatesFrom,
} from './providers'
import type { LaneDirReport, LaneRow, Probe } from './report'
import {
  cancelReport,
  context,
  helpText,
  holdReason,
  lanesReport,
  listing,
  setupReport,
} from './report'
import type { Finding, LaneResult } from './verdict'
import { parse, rank, resultOf, subjectOf, unsent } from './verdict'

/**
 * What the panel is showing, and what it has already shown.
 *
 * Held in this closure, not `$.store`: the store is shared by every session
 * on the machine, so a read-modify-write of one collection there loses a
 * sibling session's findings. Only `seen` is stored, under a key of this
 * session's own, so no two sessions write one key.
 */
let findings: Finding[] = []
let lanes: LaneResult[] = []
let isReviewing = false
/**
 * Whether a transcript clean is in flight.
 *
 * Separate from `isReviewing`: a review of a turn's diff is quick and holds
 * nothing, while a clean reads the whole session and holds new work off until
 * it is done.
 */
let isCleaning = false
let sessionKey = ''

/**
 * Where this session's refinement log is kept.
 *
 * Scoped to the session because `note` reads the list, appends, and writes it
 * back: on one shared key, sessions compacting at the same moment overwrote
 * each other's appends, so the log silently lost most of what it recorded and
 * answered nothing about any single session. It is also the question the log
 * is read for — what refinement did here.
 */
let logKey = 'refine:log'

/**
 * What the person has asked the cleaner to drop, in their own words.
 *
 * Standing rather than one-shot: a release only happens inside a compaction,
 * and the next one may be minutes away, so the ask is held until a cleaner has
 * been given it. Each is passed to the cleaner as something to find whatever
 * the lane's own rules protect — an API error and a wrong answer are both
 * things the rules keep, and both are what this exists to remove.
 */
let drops: string[] = []

/**
 * Whether a compaction was asked for and still has to be run.
 *
 * `$.session.compact` refuses to run inside a `command.run` hook, because it
 * would compact under the turn that hook is holding, so `/backseat forget`
 * cannot do it where it is typed. The ask is armed here and run when the turn
 * ends, which is the same boundary the watcher uses.
 */
/**
 * The command as it appears in the conversation that carries it.
 *
 * A message asking for text to be dropped contains that text, so matching the
 * ask word for word matches the asking. Measured on a live session: the only
 * twelve messages containing one ask were the twelve times it had been typed,
 * and releasing those would have spent the ask on its own echo and left what
 * it named in place.
 */
const FORGET_ECHO = '/backseat forget'

let askedCompact = false

/**
 * How many times an asked-for compaction has been tried.
 *
 * The ask survives a refusal so a turn in flight does not throw it away, which
 * on its own is an unbounded retry: something refusing every compaction would
 * be asked once a turn for the rest of the session. This is what ends it, and
 * the person is told rather than left with an ask that quietly never ran.
 */
let askedTries = 0

/** How many refusals an asked-for compaction is given before it is dropped. */
const ASK_TRIES = 5

/**
 * Whether the newest `precompute` dispatch handed back a refinement for the
 * next compaction to install.
 *
 * Read by the watcher before it asks. `$.session.compact()` runs every hook
 * but the calling one, so the compaction it asks for never reaches this
 * plugin's own `session.compact` hook: what it installs is a refinement core
 * kept from a `precompute`, or else core's summary of the whole conversation —
 * the outcome the ask exists to avoid. Set by the hook on a precompute that
 * refines, cleared by any compaction that runs.
 */
let precomputeReady = false

/**
 * Where the told subjects are kept, under this session's own name.
 *
 * `classic.Stop` reads it before deciding and writes it before handing a
 * subject over, so a subject stays told for every loop and event that reaches
 * that hook rather than only within the one that first delivered it. An
 * in-memory set alone is consulted once per caller, which hands the same
 * advice over once per agent loop that ends under one turn.
 */
let toldKey = ''

/**
 * What each loop wrote and how many of its turns have changed code, keyed by
 * `agentId` with the main loop under the empty string.
 *
 * Every hook sees a subagent's turn as well as the main loop's, so one
 * shared list would let whichever turn ended first carry off the other's
 * evidence: a subagent finishing mid-task would consume the files the main
 * turn was about to be reviewed on. Keyed by loop, each turn is reviewed on
 * what that loop actually wrote.
 */
let written = new Map<string, string[]>()
let changedTurns = new Map<string, number>()

/**
 * The commit each repository was on when the turn first wrote to it, keyed by
 * the loop and the directory the write was in.
 *
 * A turn that commits its own work — which is how a disciplined session
 * works — leaves nothing for a diff against the current HEAD to find: the
 * work is in HEAD. Reviewing against the commit that was HEAD when the turn
 * started writing covers both what it committed and what it left in the
 * working tree, so a session that commits as it goes is reviewed rather than
 * silently reported clean.
 *
 * Captured in the `tool.call` hook because it has to be read before the
 * commit happens, and only the first time a turn touches each repository.
 */
let baselines = new Map<string, { root: string; sha: string }>()

/**
 * The before-image of each path a turn has written, by absolute path.
 *
 * `collectDiff` reads it for a path no repository holds, which is the only
 * way such a change can be shown to a lane. It is filled by `tool.call`
 * before a call runs, because once the call has written there is no way to
 * read what it replaced, and an entry is dropped when a diff has used it.
 *
 * Keyed by path and not by loop because a subagent's writes roll up into the
 * turn that delegated them: the image held from whichever loop wrote first is
 * the base the whole turn is diffed against.
 */
let beforeText = new Map<string, Snapshot>()

/**
 * The review a turn started, while it is still running.
 *
 * `session.end` waits on this before clearing the session's state: the review
 * is started without holding the turn, so a session that ends right after its
 * last turn would otherwise tear down the state the review is reading and the
 * lanes would never be asked at all. A session run to answer one prompt and
 * exit is the case this exists for.
 */
let reviewing: Promise<void> | undefined

/**
 * How many before-images are held at once.
 *
 * A review drops the ones it used, so the cap is only reached by a session
 * whose turns write without any lane being due. The oldest goes first, which
 * keeps the newest work diffable.
 */
const BEFORE_LIMIT = 512

/**
 * How many paths and directories one call may watch.
 *
 * A command naming more than this is watched in part: the cost of the watch
 * is paid on every call, and a shell line that touches hundreds of files is
 * reported by the directory listing rather than one stat each.
 */
const WATCH_FILES = 24
const WATCH_DIRS = 8
let sessionCwd = ''

/**
 * The home directory, as `isEphemeral` reads it.
 *
 * Held beside `sessionCwd` and taken once at the session's start, because the
 * test for a scratch path runs on every write a turn makes and asking the
 * environment each time would pay for the same answer repeatedly.
 */
let sessionHome = ''

/**
 * The lanes as they finally resolved, and what was wrong with the lane
 * directory.
 *
 * Read once at `session.start` and again by `/backseat setup`, so that the
 * roster a person is shown is the roster the next review will use.
 */
let roster: Lane[] = []
let laneProblems: string[] = []
let laneDirs: LaneDirReport[] = []

/**
 * Which review the panel is listening to, and the lanes it is waiting on.
 *
 * A cancel raises `generation`, and a review whose generation is stale
 * publishes nothing. `$.process.run` offers no way to end a child, so this
 * cancels the panel rather than the process — which is what `cancelReport`
 * says it does.
 */
let generation = 0
let inFlight = new Set<string>()

/**
 * What the person set with `/backseat purpose` and `/backseat model`, and
 * the store key they live under.
 *
 * `purpose` is handed to every lane: a diff shows what changed and never
 * what it was supposed to achieve, so a reviewer without it guesses at
 * intent and reports the guess as drift. `models` is keyed by lane name,
 * with `*` meaning every lane, so one command can move the whole panel to a
 * different model without editing a lane file.
 *
 * `sessionLanes` holds the reviewers `/backseat lane` added. They are the
 * other half of the question a lane file answers: a file is for the
 * reviewers this repository always wants, and these are for the one a person
 * wants while doing this particular piece of work.
 *
 * All three are kept under a key of this session's own, so two sessions on
 * one machine never overwrite each other's, and all three survive a reload.
 */
let purpose = ''
let models = new Map<string, string>()
let sessionLanes = new Map<string, { question: string; onAgents: boolean }>()
let stateKey = ''

/**
 * Subjects already dismissed or shown, keyed by `subjectOf`, so a lane
 * reporting the same thing next turn is not drawn twice.
 */
const seen = new Set<string>()

/**
 * Subjects `classic.Stop` has handed to the model, keyed by `subjectOf`.
 *
 * Separate from `seen`, which keeps a lane's repeat from being ranked again:
 * `findings` stays populated for as long as `ui.render` is drawing its cards,
 * and the host counts context returned from a Stop hook as a reason to carry
 * the turn on. Handing the same set over every turn therefore holds the
 * session until the engine's consecutive-block cap overrides it, so each
 * subject is handed over once.
 */
const told = new Set<string>()

/**
 * Providers that have said they are out of quota, and the words they said it
 * in, with when they said it.
 *
 * A spent limit refuses in the same second it is asked. A panel that does not
 * remember therefore collects one refusal per lane per turn, spends every
 * fallback on a second refusal, and reports a roster of broken reviewers
 * where there is one exhausted account. Remembering it lets a lane be
 * skipped without a process being started, and lets a whole review be
 * abandoned before a diff is even taken.
 *
 * The provider's own words carry its reset time and are kept to be shown,
 * but they are prose and are not parsed: the wait below is a wait, not the
 * account's schedule.
 */
const limited = new Map<string, { said: string; at: number }>()

/**
 * Providers failing outright, and how many times in a row.
 *
 * Separate from `limited` because a hard failure is not a refusal for want of
 * quota: it carries no window, it may be transient, and nothing was recording
 * it — so a cleaner whose provider could not run at all was asked again on
 * every compaction and paid its whole timeout each time. Held in memory
 * rather than stored, so a restart retries rather than inheriting a wait.
 */
const failing = new Map<string, { said: string; at: number; runs: number }>()


/**
 * Explanations the explain button produced, and the findings it is still
 * working on, both keyed by subject.
 */
const explained = new Map<string, string>()
const explaining = new Set<string>()

/**
 * Subjects whose fix has already been submitted.
 *
 * `cardFor`'s fix action drops the card and submits the work as the person's
 * own instruction. Dropping the finding is not on its own a guard: a card
 * closure built by an earlier `ui.render` still holds the finding, so an
 * action delivered more than once submits the same instruction more than
 * once. `explaining` guards the explain action for the same reason.
 */
const fixedAlready = new Set<string>()

/**
 * Whether a note is posted into the conversation as well as recorded.
 *
 * Off unless `debug` is set: `$.ui.log` writes into the conversation, which
 * the model reads back as context the next turn, and a path that exists to
 * reclaim context must not spend it narrating itself.
 */
let loud = false

/**
 * Registers the panel: a hook that records what a turn wrote, one that
 * reviews it once the turn is over, one that draws what came back, and the
 * command and lifecycle hooks around them.
 *
 * Nothing holds a turn unless `enforcement` is `severity` or `block`; under
 * the default, `classic.Stop` only hands the findings to the model as
 * context, so the session sees what the person sees.
 *
 * @param on the engine's registrar
 * @param options the `userConfig` values, with the manifest's defaults filled in
 */
export function register(on: On, options: PluginOptions): void {
  const config = readConfig(options)

  // `note` is module-level and the config is built here, so the one thing it
  // needs from it is held where it can reach: whether a note is posted into
  // the conversation as well as recorded.
  loud = config.debug

  on('session.start', async ($, e, next) => {
    const id = await $.session.id()

    sessionKey = `seen:${id}`
    logKey = `refine:log:${id}`
    toldKey = `told:${id}`
    stateKey = `state:${id}`

    const cwd = await $.session.cwd().catch(() => '')

    sessionCwd = typeof cwd === 'string' ? cwd : ''
    sessionHome = await homeDir($)

    await loadLimits($)

    await $.command.register({
      name: 'backseat',
      description: 'What the backseat reviewers found, and the panel itself',
      argumentHint:
        '[review | clean | refine | forget <what> | rehydrate <ref> | setup | lanes | purpose <text> | model <m> | lane <name> <q> | cancel | help]',
    })

    await loadState($, stateKey)
    await reload($, config)

    for (const subject of await storedSubjects($, sessionKey)) {
      seen.add(subject)
    }

    for (const subject of await storedSubjects($, toldKey)) {
      told.add(subject)
    }

    if (config.debug || laneProblems.length > 0) {
      $.ui.log(
        `backseat: ${roster.length} lane(s) — ` +
          roster.map(lane => `${lane.name}/${lane.provider}`).join(', ') +
          (laneProblems.length > 0 ? ` · ${laneProblems.join('; ')}` : ''),
        { to: 'debug' },
      )
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Readonly<Record<string, unknown>>
    // Taken before the call, because a call that rewrites a file leaves no
    // way to read what it replaced, and a lane shown only the new text
    // reports on a file rather than on a change.
    const watch = watchedOf(e.tool, input, sessionCwd)
    const had = await snapshotAll($, watch.files)
    const listed = await listAll($, watch.dirs)

    const result = await next(e)

    if (result.deny !== undefined || result.isError) {
      return result
    }

    const loop = e.agentId ?? ''

    const blank: Snapshot = {
      exists: false,
      size: 0,
      mtimeMs: 0,
      text: '',
      isWhole: true,
    }
    const keep = async (path: string, was: Snapshot): Promise<void> => {
      // A scratch or state file is not the change: it cannot be committed,
      // and reviewing it spends a lane on a file written to be discarded.
      if (isEphemeral(path, sessionHome, sessionCwd)) {
        return
      }

      if (!beforeText.has(path)) {
        if (beforeText.size >= BEFORE_LIMIT) {
          const oldest = beforeText.keys().next()

          if (!(oldest.done ?? false)) {
            beforeText.delete(oldest.value)
          }
        }

        beforeText.set(path, was)
      }

      written.set(loop, [...(written.get(loop) ?? []), path])

      await remember($, loop, path)
    }

    // An edit tool is taken at its word: it names the file it wrote, and a
    // write whose length and modified time both happen to survive it would
    // otherwise drop out of the turn.
    if (isEditTool(e.tool)) {
      const named = pathOf(input)

      if (named !== '') {
        const path = absolute(sessionCwd, named)

        await keep(path, had.get(path) ?? blank)
      }
    }

    // Every other write is found by comparison: the shell is the tool that
    // changes a file without naming it in a field, and `writeTargetsOf` plus
    // the directory listing are what see it.
    const now = await statAll($, watch.files)
    const after = watch.dirs.length === 0 ? listed : await listAll($, watch.dirs)

    const found = [
      ...changedWatched(had, now),
      ...appearedIn(listed, after),
    ]

    for (const path of found) {
      await keep(path, had.get(path) ?? blank)
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const loop = e.agentId ?? ''
    const paths = distinctPaths(written.get(loop) ?? [])

    // A subagent's turn is reviewed only by the lanes that asked for
    // subagents, so delegating work does not put the whole panel on every
    // step of it.
    // Asked for after the turn, not during it: the engine counts a
    // `turn.complete` hook as inside the turn and refuses a compaction there.
    // Measured in live sessions — four of five requests were refused with "a
    // turn is in flight" — so the request is deferred past the boundary.
    //
    // Only the main loop's boundary is between turns. A subagent's turn ends
    // while the turn that delegated it is still running, so a request armed
    // there fires inside that turn and is refused for one in flight: measured
    // across a session's log, twenty refusals to one acceptance, with a single
    // turn named as running four times over as four subagents finished inside
    // it. The delegating turn arms its own request when it ends.
    if (
      loop === '' &&
      config.refine === 'on' &&
      (config.refineAtPercent > 0 || askedCompact) &&
      !isCleaning
    ) {
      // `$.clock.after` hands back a timer, not a promise: a `.catch` on it
      // threw before the review below was ever reached, which left the
      // watcher running and the lanes silent. The refinement's own failure is
      // swallowed inside the callback instead.
      $.clock.after(REFINE_DELAY_MS, () => {
        void maybeRefine($, config).catch(() => undefined)
      })
    }

    const due = lanesForTurn(roster, loop)

    // A review already in flight is the one case where the evidence is kept
    // rather than consumed: taking it and reviewing nothing would lose the
    // turn's work outright, so it waits and is reviewed with the next turn's.
    // `written` is deliberately left alone here: a turn that could not be
    // reviewed because every provider was refusing is reviewed with the next
    // one, rather than having its evidence consumed by a review that never ran.
    if (paths.length === 0 || due.length === 0 || isReviewing) {
      return next(e)
    }

    written.delete(loop)

    // What a subagent wrote is also the main loop's work, so it rolls up and
    // is reviewed again at the end of the turn that delegated it. Dropping it
    // here instead would mean a turn that delegated all its editing was
    // reviewed by nobody; `seen` keeps the roll-up from drawing a finding an
    // agent lane has already drawn.
    if (loop !== '') {
      written.set('', [...(written.get('') ?? []), ...paths])
    }

    const count = (changedTurns.get(loop) ?? 0) + 1

    changedTurns.set(loop, count)

    if (count % config.everyTurns !== 0) {
      return next(e)
    }

    const refs = refsFor(loop)

    for (const key of [...baselines.keys()]) {
      if (key.startsWith(`${loop}\u0000`)) {
        baselines.delete(key)
      }
    }

    reviewing = review($, config, paths, '', [], due, refs, loop)

    void reviewing.catch(() => {
      lanes = [
        resultOf('backseat', 'failed', [], Date.now(), 'the review could not be started'),
      ]
    })

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A clean review stays silent, because that is the panel working. A lane
    // that failed or could not be asked does not: silence there is
    // indistinguishable from a panel that never ran, which is the one thing a
    // person cannot diagnose from the outside.
    const unwell = lanes.some(
      one => one.outcome === 'failed' || one.outcome === 'skipped',
    )

    if (findings.length === 0 && !unwell && !(config.debug && lanes.length > 0)) {
      return next(e)
    }

    const ui = await $.ui.resolve(e)
    const cards = findings
      .slice(0, config.maxCards)
      .map(finding => cardFor($, config, finding))
    const panel = panelOf(ui, {
      cards,
      held: Math.max(0, findings.length - config.maxCards),
      lanes,
      isDebug: config.debug,
      columns: e.props.bodyColumns,
    })

    return panel ?? next(e)
  })

  on('command.run', { command: 'backseat' }, async ($, e) => {
    const asked = parseArgs(e.args)

    if (asked.problems.length > 0) {
      return { text: [...asked.problems, '', helpText()].join('\n') }
    }

    if (asked.sub === 'help') {
      return { text: helpText() }
    }

    if (asked.sub === 'cancel') {
      const stopped = [...inFlight]

      generation += 1
      inFlight = new Set()
      isReviewing = false

      return { text: cancelReport(stopped) }
    }

    if (asked.sub === 'setup') {
      return { text: await setup($, config) }
    }

    if (asked.sub === 'lanes') {
      await reload($, config)

      return {
        text: lanesReport(laneRows(), purpose, laneProblems),
      }
    }

    if (asked.sub === 'purpose') {
      if (asked.isClear) {
        purpose = ''
        await saveState($, stateKey)

        return { text: 'Purpose cleared. Lanes judge the change on its own again.' }
      }

      if (asked.rest === '') {
        return {
          text:
            purpose === ''
              ? 'No purpose set. /backseat purpose <what this work is for>'
              : `Purpose: ${purpose}`,
        }
      }

      purpose = asked.rest
      await saveState($, stateKey)

      return {
        text: [
          `Purpose set, and every lane is told it from now on:`,
          `  ${purpose}`,
        ].join('\n'),
      }
    }

    if (asked.sub === 'forget') {
      if (asked.isClear) {
        drops = []
        await saveState($, stateKey)

        return {
          text: 'Nothing is being dropped on request any more.',
        }
      }

      if (asked.rest === '') {
        return {
          text:
            drops.length === 0
              ? [
                  'Nothing asked for yet.',
                  '  /backseat forget <what to drop>',
                  '',
                  'Names what the cleaner should find and release, past the rules',
                  'that would otherwise keep it: an API error, a wrong answer the',
                  'session has moved on from, a stale file read. It takes effect at',
                  'the next compaction, and /backseat rehydrate fetches any of it',
                  'back out of the session file.',
                ].join('\n')
              : ['Asked to drop, at the next compaction:', ...drops.map(one => `  ${one}`)].join('\n'),
        }
      }

      drops = [...drops, asked.rest].slice(-20)
      await saveState($, stateKey)

      // Armed rather than run here: `$.session.compact` refuses inside a
      // `command.run` hook, because it would compact under the turn this hook
      // is holding. The turn's own end is the next boundary, and is where the
      // watcher runs too.
      askedCompact = true
      askedTries = 0

      // Tried at once rather than only at the turn's end. A compaction can
      // only happen between turns, so this is refused while one is running —
      // and because the ask now survives a refusal, the turn's end retries it.
      // Where the command is the whole of the person's input there is no turn
      // to wait for, and this is what makes it land immediately.
      $.clock.after(REFINE_DELAY_MS, () => {
        void maybeRefine($, config).catch(() => undefined)
      })

      return {
        text: [
          `The cleaner is asked to drop, and to release what it finds:`,
          `  ${asked.rest}`,
          '',
          config.refine === 'on'
            ? 'Running now, whatever the context is sitting at. A conversation' +
              ' only compacts between turns, so if one is in flight it lands as' +
              ' that turn ends.'
            : 'refine is off, so nothing will be released until it is on:' +
              ' a release only happens inside a compaction this plugin handles.',
          'Anything released is still in the session file: /backseat rehydrate fetches it back.',
        ].join('\n'),
      }
    }

    if (asked.sub === 'model') {
      if (asked.words.length === 0) {
        const shown = [...models.entries()].map(
          ([name, model]) => `  ${name === '*' ? 'every lane' : name}: ${model}`,
        )

        return {
          text:
            shown.length > 0
              ? ['Model overrides:', ...shown].join('\n')
              : `No override. A claude lane asks ${config.claudeModel}; a CLI lane asks its own default.`,
        }
      }

      const isOne = asked.words.length === 2
      const target = isOne ? (asked.words[0] ?? '') : '*'
      const model = isOne ? (asked.words[1] ?? '') : (asked.words[0] ?? '')

      if (isOne && !roster.some(lane => lane.name === target)) {
        return {
          text: `No lane named "${target}". /backseat lanes lists them.`,
        }
      }

      if (model === 'default' || model === 'clear') {
        models.delete(target)
      } else {
        models.set(target, model)
      }

      await saveState($, stateKey)

      return {
        text:
          model === 'default' || model === 'clear'
            ? `${target === '*' ? 'Every lane' : target} is back to its default model.`
            : `${target === '*' ? 'Every lane' : target} now asks ${model}.`,
      }
    }

    if (asked.sub === 'lane') {
      const name = asked.words[0] ?? ''

      if (asked.isClear && name === '') {
        const count = sessionLanes.size

        sessionLanes = new Map()
        await saveState($, stateKey)
        await reload($, config)

        return {
          text:
            count === 0
              ? 'There were no session lanes to remove.'
              : `Removed ${count} session lane(s). The files and options are untouched.`,
        }
      }

      if (asked.isClear) {
        if (!sessionLanes.delete(name)) {
          return {
            text: `No session lane named "${name}". /backseat lanes lists them.`,
          }
        }

        await saveState($, stateKey)
        await reload($, config)

        return { text: `Session lane "${name}" removed.` }
      }

      if (name === '') {
        const shown = [...sessionLanes.entries()].map(
          ([lane, held]) =>
            `  ${lane}${held.onAgents ? " (also on agents' turns)" : ''}: ${held.question}`,
        )

        return {
          text:
            shown.length > 0
              ? ['Session lanes:', ...shown].join('\n')
              : 'No session lanes. /backseat lane <name> <question> adds one for this session.',
        }
      }

      const question = asked.words.slice(1).join(' ')

      if (question === '') {
        return {
          text: `A lane is a question. /backseat lane ${name} <what it should ask>`,
        }
      }

      const replaced = roster.find(
        lane => lane.name === name && lane.scope !== 'session',
      )

      sessionLanes.set(name, { question, onAgents: asked.isAgents })
      await saveState($, stateKey)
      await reload($, config)

      return {
        text: [
          `Lane "${name}" reviews this session${asked.isAgents ? ", and every subagent's turn in it" : ''}:`,
          `  ${question}`,
          ...(replaced === undefined
            ? []
            : [
                '',
                `This replaces the ${replaced.scope === 'config' ? 'configured' : replaced.scope} lane of the same name for this session, so its`,
                'instructions, documents and cross-links are not in play. Use another',
                'name to run both.',
              ]),
        ].join('\n'),
      }
    }

    if (asked.sub === 'review') {
      if (isReviewing) {
        return {
          text: 'A review is already in flight. Run /backseat cancel first, or wait.',
        }
      }

      const changed = await changedPaths($, asked.base)
      // Outside a repository there is no ref to diff against, so the review
      // is of what this session wrote: `tool.call` holds a before-image of
      // each of those paths, which is the only base such a tree has.
      const asksSession = !changed.isRepo
      const found = asksSession ? [...beforeText.keys()] : changed.paths

      if (asksSession && found.length === 0) {
        return {
          text: [
            'This directory is not a git repository and this session has not',
            'written anything yet, so there is nothing to diff. Once a turn has',
            'written a file, that file is reviewable here: it is diffed against',
            'the copy taken before the write rather than against a commit.',
          ].join('\n'),
        }
      }

      if (found.length === 0) {
        return {
          text:
            asked.base === ''
              ? 'Nothing has changed in the working tree, so there is nothing to review.'
              : `Nothing differs from ${asked.base}, so there is nothing to review.`,
        }
      }

      await review($, config, found, asksSession ? '' : asked.base, asked.only, roster)
    }

    if (asked.sub === 'refine') {
      return { text: await refinePlan($, config) }
    }

    if (asked.sub === 'rehydrate') {
      const ref = asked.words[0] ?? ''

      if (ref === '') {
        return {
          text: 'Name the reference a finding gave, as /backseat rehydrate m41.ab12cd34',
        }
      }

      return { text: await rehydrate($, ref) }
    }

    if (asked.sub === 'clean') {
      if (isReviewing) {
        return {
          text: 'A review is already in flight. Run /backseat cancel first, or wait.',
        }
      }

      const home = await homeDir($)
      const eligible = roster.filter(lane => lane.sees.includes('transcript'))
      const cleaners = eligible.filter(
        lane =>
          allowsProject(lane, sessionCwd, home) &&
          (asked.only.length === 0 || asked.only.includes(lane.name)),
      )

      // A lane held back by its own allowlist is named rather than missing,
      // because a reviewer that is silent for a reason reads exactly like one
      // that is broken.
      if (cleaners.length === 0 && eligible.length > 0) {
        return {
          text: [
            `No transcript lane may run in ${sessionCwd}.`,
            `${eligible.length} lane(s) read the transcript, and each names the`,
            'projects it may run in. Add this directory to a lane\'s `projects:`',
            'to let it read this session.',
          ].join('\n'),
        }
      }

      if (cleaners.length === 0) {
        return {
          text: [
            'No lane reads the transcript. Add `sees: transcript` to a lane',
            'file, with a question about what no longer needs to stay in the',
            'session; such a lane waits to be asked rather than running on a',
            'turn, because its evidence is the session and not the change.',
          ].join('\n'),
        }
      }

      if (cleaners.length > 0 && (await allUnaskable($, cleaners))) {
        return {
          text: [
            'Every transcript lane is inside its refusal wait, so nothing was run.',
            cleaners
              .map(lane => `  ${lane.name}: ${limitSaid(lane.provider) || 'refused for want of quota'}`)
              .join('\n'),
          ].join('\n'),
        }
      }

      const read = await transcriptEntries($)

      if (read.problem !== '') {
        return { text: read.problem }
      }

      await clean($, config, cleaners, read.entries, read.isPartial)
    }

    return { text: listing(lanes, findings, 0) }
  })

  on('session.compact', async ($, e, next) => {
    // The conversation is about to be replaced by a summary. A summary is a
    // paraphrase: what it leaves out is gone, and what it keeps is reworded.
    // Handing back a subset of the engine's own messages instead keeps every
    // survivor exactly as it was — the handle is what maps it back — and drops
    // only what the rules, and a reviewer where one has run, agreed could go.
    //
    // Any compaction consumes what a precompute left; a precompute sets it
    // again only where it hands back a refinement, below.
    precomputeReady = false

    if (config.refine === 'off') {
      await note(
        $,
        `${e.trigger}: refine is off — the engine summarised`,
      )

      return next(e)
    }

    // An asked-for drop is not held by this. Quoted text is matched without a
    // provider, so the one state where a person most needs the command — every
    // reviewer down, the errors they want gone being those reviewers' own —
    // was the state that refused to run it.
    if (drops.length === 0 && (await nothingCanRun($))) {
      await note(
        $,
        `${e.trigger}: no provider can be reached or is inside its refusal wait` +
          ' — the engine summarised',
      )

      return next(e)
    }

    const rows = rowsOf(e.messages)

    // Recorded rather than returned quietly: a compaction that reached this
    // hook and left no account of itself is indistinguishable from one the
    // hook never saw, which is the question `refine:log` exists to answer.
    if (rows.length === 0) {
      await note(
        $,
        `${e.trigger}: the compaction carried no messages — the engine summarised`,
      )

      return next(e)
    }

    const verdicts = tiersOf(entriesOf(rows), ANCHOR_MESSAGES)

    // A handle exists only here: `$.session.messages()` strips them, so a
    // reviewer can only be asked about the live conversation from inside a
    // compaction, and every compaction must therefore be able to ask.
    //
    // Restricting this to `precompute` and `plugin` left the cleaner
    // unreachable: measured over a day of this machine's own sessions, every
    // outcome recorded arrived as `auto` and neither of those triggers fired
    // once, so no reviewer was ever asked and the only releases were the ones
    // the rules settled by themselves.
    //
    // What a person waiting cannot afford is the unbounded run, not the
    // question. `isWaited` is that bound — two windows and two minutes against
    // eight and ten — and a provider inside its refusal wait is skipped
    // without a process being started at all, so the common case costs nothing.
    // Quoted text is matched here, before any provider is considered: it needs
    // no model, so an asked-for drop still lands with every provider
    // unreachable — which is the state a person is most likely to be in when
    // what they want gone is a provider's own error.
    const quoted = matchedBy(
      rows.filter(row => !row.text.includes(FORGET_ECHO)),
      drops,
    )

    if (quoted.size > 0) {
      await note(
        $,
        `${quoted.size} message(s) match what was asked for, word for word,` +
          ' so no reviewer was needed for them',
      )
    }

    const asks = await releasedBy(
      $,
      config,
      rows,
      verdicts,
      e.trigger !== 'precompute',
    )

    // Added to, not replaced: a handle names a message across a compaction,
    // and the dispatch that can afford to ask is `precompute`, which is not
    // waited behind. Replacing the set discarded its answer at the next
    // compaction — the one the answer was produced for.
    releasedHandles = new Set([...releasedHandles, ...asks.released, ...quoted])
    demandedHandles = new Set([...asks.demanded, ...quoted])

    // Cleared once given to a cleaner: the ask was about the conversation as
    // it stood, and leaving it standing would drop its match again at every
    // later compaction.
    if (demandedHandles.size > 0 || quoted.size > 0) {
      drops = []
      await saveState($, stateKey).catch(() => undefined)
    }

    const keep = survivorsOf(
      rows,
      verdicts,
      releasedHandles,
      ANCHOR_MESSAGES,
      demandedHandles,
    )
    const byPosition = new Map(rows.map(row => [row.at, row]))

    // Below the floor this has spent a compaction to free almost nothing, so
    // the engine is left to do what it would have done.
    //
    // An asked-for drop is not measured against it. The floor asks whether a
    // reduction was worth a compaction nobody requested; one error message is
    // far below it, and discarding the refinement there would mean the command
    // reported success and changed nothing.
    if (
      demandedHandles.size === 0 &&
      !worthInstalling(rows, keep, floorFor(e.trigger))
    ) {
      const freed = rows
        .filter(row => !keep.has(row.at))
        .reduce((sum, row) => sum + row.chars, 0)
      const total = rows.reduce((sum, row) => sum + row.chars, 0)

      await note(
        $,
        `${e.trigger}: ${rows.length} rows, would free ${freed} of ${total} ` +
          `characters, under the ${Math.round(floorFor(e.trigger) * 100)}% floor — the engine summarised`,
      )

      return next(e)
    }

    // A refinement that leaves the conversation over the window is not a
    // compaction: the engine counts what it installed, finds it still too
    // long, and answers every later prompt "Prompt is too long" without
    // sending it, so the session can only be recovered by hand. What is kept
    // is estimated from the session's own count, by the share of characters
    // that survive; over REFINE_FIT of the window the engine summarises.
    {
      const total = rows.reduce((sum, row) => sum + row.chars, 0)
      const kept = rows
        .filter(row => keep.has(row.at))
        .reduce((sum, row) => sum + row.chars, 0)
      const context = (await $.session.usage().catch(() => undefined))?.context
      const tokens = context?.tokens ?? 0
      const window = context?.window ?? 0

      if (total > 0 && tokens > 0 && window > 0) {
        const after = Math.round(tokens * (kept / total))

        if (after > window * REFINE_FIT) {
          await note(
            $,
            `${e.trigger}: a refinement would keep ~${after} of ${tokens} tokens, over ` +
              `${Math.round(REFINE_FIT * 100)}% of the ${window}-token window — the engine summarised`,
          )

          return next(e)
        }
      }
    }

    // A released message is not always dropped. One large enough to be worth
    // it keeps its own head, rebuilt without its handle so the engine takes
    // the shortened text: the command and the first lines stay, saying what
    // the output was, and the rest goes. Dropping those whole would lose what
    // they were; keeping them whole would free nothing.
    const messages: SessionMessage[] = []
    let dropped = 0
    let shortenedRows = 0

    e.messages.forEach((message, at) => {
      if (keep.has(at)) {
        messages.push(message)

        return
      }

      const row = byPosition.get(at)
      const short =
        row === undefined
          ? undefined
          : shortened(row.text, rehydrationFor(entryOfRow(row)).ref)

      if (short === undefined) {
        dropped += 1

        return
      }

      // No handle: the engine rebuilds it from what is handed up.
      const { handle: _handle, ...rest } = message

      messages.push({ ...rest, text: short, toolUses: [], toolResults: [] })
      shortenedRows += 1
    })

    await note(
      $,
      `${e.trigger}: refined in place — ${messages.length} of ${rows.length} ` +
        `rows kept, ${shortenedRows} shortened to their ends, ${dropped} released, ` +
        'nothing summarised',
    )

    if (e.trigger === 'precompute') {
      precomputeReady = true
    }

    return { messages }
  }).catch(async ($, e, next) => {
    // A refinement that threw must not take the compaction with it: the engine
    // summarising is the behaviour without this plugin, and is always better
    // than a conversation that cannot be compacted at all.
    //
    // Noted as well as logged, because the log line lives only in the session
    // it was drawn in and this is the one outcome a later reader of
    // `refine:log` would otherwise never see.
    await note(
      $,
      `${e.trigger}: refinement failed on ${e.messages.length} message(s), ` +
        `${e.messages.reduce((sum, one) => sum + (one.text ?? '').length, 0)} characters of text ` +
        `(${next.error.kind}: ${next.error.message}) — the engine summarised`,
    ).catch(() => undefined)

    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    // A clean reads the whole transcript. Work started while it runs moves
    // what it is reading, so its findings would name messages that have since
    // shifted. The panel's own commands are always let through: /backseat
    // cancel has to stay reachable, or a clean that hangs takes the session
    // with it.
    const typed = String((e as { prompt?: unknown }).prompt ?? '').trim()

    if (!isCleaning || typed.startsWith('/backseat')) {
      return next(e)
    }

    return {
      block:
        'A transcript clean is running. It reads the whole session, so work' +
        ' started now would move what it is reading. Wait for the cards, or' +
        ' run /backseat cancel to stop it.',
    }
  }).catch(($, e, next) => {
    // Failing closed here would be a session that cannot be typed into. The
    // gate exists to protect a clean, and losing it costs a stale finding;
    // keeping it when it is broken costs the session.
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    const blocking = findings.filter(finding =>
      isBlocking(config, finding.severity),
    )

    if (blocking.length > 0) {
      return { block: holdReason(blocking) }
    }

    // The host is already carrying this turn on at a Stop hook's request, so
    // more context now is what turns one delivery into a loop.
    if (e.stop_hook_active) {
      return next(e)
    }

    // What another loop handed over is read before deciding, because each
    // loop that ends under this turn reaches this hook with its own memory of
    // what was told and would hand the same subject over again.
    for (const subject of await storedSubjects($, toldKey)) {
      told.add(subject)
    }

    const { fresh, subjects } = unsent(findings, told)

    if (fresh.length === 0) {
      return next(e)
    }

    for (const subject of subjects) {
      told.add(subject)
    }

    // Written before the context is returned, so a loop that reaches this
    // hook next reads this delivery rather than repeating it.
    await $.store.set(toldKey, [...told].slice(-400)).catch(() => undefined)

    return { additionalContext: [context(fresh)] }
  }).catch(($, e, next) => {
    // A gating hook that fails must not fail closed: a panel that cannot
    // decide says so as context and lets the turn end, because the
    // alternative is a session a person cannot finish for a reason the
    // panel could not state.
    return {
      additionalContext: [
        `backseat: the panel could not decide (${next.error.kind}: ${next.error.message}). No finding is holding this turn.`,
      ],
    }
  })

  on('session.end', async ($, e, next) => {
    // Waited on before the teardown below, not after: the state this clears
    // is what the review reads.
    await (reviewing ?? Promise.resolve()).catch(() => undefined)

    reviewing = undefined

    await $.store.delete(sessionKey).catch(() => undefined)
    await $.store.delete(toldKey).catch(() => undefined)
    await $.store.delete(stateKey).catch(() => undefined)

    findings = []
    lanes = []
    written = new Map()
    changedTurns = new Map()
    baselines = new Map()
    beforeText = new Map()
    sessionCwd = ''
    sessionHome = ''
    roster = []
    laneDirs = []
    purpose = ''
    models = new Map()
    sessionLanes = new Map()
    inFlight = new Set()
    isCleaning = false
    seen.clear()
    told.clear()
    limited.clear()
    reachable.clear()
    explained.clear()
    explaining.clear()
    fixedAlready.clear()

    return next(e)
  })
}

/**
 * How much of a transcript one question may carry, and how much of the file is
 * read at all.
 *
 * The window budget is in characters because that is what is measured; a token
 * figure would be an estimate dressed as a count. It is set well under the
 * provider's own window so the lane's instructions, documents and the answer
 * contract fit beside the evidence.
 *
 * The file budget exists because a session transcript reaches a gigabyte and
 * reading one whole would end the session it is trying to help. The tail is
 * what is read: it is the part a session still has in context, and so the part
 * worth reclaiming.
 */
const WINDOW_CHARACTERS = 700_000
const TRANSCRIPT_CHARACTERS = 24 * 1024 * 1024

/**
 * The most one `$.process.run` is asked to carry.
 *
 * A provider is handed its prompt as one argument, and the operating system
 * caps the size of an argument list near a megabyte: a window above that does
 * not make a slow call, it makes a process that never starts. The same bound
 * applies reading, because the host truncates what it captures from a
 * subprocess, so a transcript is read in pieces of this size and joined.
 */
/**
 * The most one spooled piece may hold.
 *
 * `$.fs.read` refuses a file over 4,194,304 bytes, so a transcript longer than
 * that is taken in pieces under the limit and joined. The pieces are cut by
 * byte arithmetic against the end of the file, so they stay contiguous however
 * many code units each one decodes to.
 */
const SPOOL_BYTES = 3_500_000

/**
 * How far a window reaches back over the one before it.
 *
 * A boundary with no overlap hides every relation that crosses it: a result
 * superseded by a read on the other side is reported by neither window,
 * because neither holds both halves. The reach is wide because the relations
 * worth finding are long — a read superseded hundreds of messages later is
 * exactly the kind a short window cannot see.
 */
const WINDOW_OVERLAP = 250_000

/**
 * The most windows one run asks about.
 *
 * A transcript of tens of millions of characters makes tens of windows, and a
 * window is a provider call of minutes. Without a bound, asking to clean a
 * long session starts hours of work and spends a quota on it. The newest
 * windows are the ones asked, because they are the part the session still has
 * in context; the summary says how many of the total were read.
 */
const WINDOW_LIMIT = 8

/**
 * How many of the newest messages count as the work going on now.
 *
 * They are never reclaimable, and the names they use are what decides which
 * older messages the work still reaches.
 */
const ANCHOR_MESSAGES = 40

/**
 * How long one window's question may take.
 *
 * A reviewer of a diff answers in seconds and the panel's own timeout suits
 * it. A window is a prompt of hundreds of thousands of characters, and was
 * measured being cut off mid-answer at the shorter bound: the work was done
 * and thrown away. Nothing waits on this, so the longest bound costs a later
 * card rather than a held turn.
 *
 * This is the host's own ceiling for a subprocess, which refuses anything
 * above it outright.
 */
const CLEAN_TIMEOUT_MS = 600_000

/**
 * How the two framings are weighed against each other.
 *
 * These are the local engine's own settings. The recency weight leans on what
 * the session is doing now; the dissent margin is how far the framings may
 * differ and still be read as agreeing; the bar is what a message must fall
 * under to be let go, and it moves by the bias when the rules already found
 * what supersedes it.
 */
const FRAMING_WEIGHTS = { recencyWeight: 0.6, dissent: 0.15, bar: 0.5 }
const SUPERSESSION_BIAS = 0.15

/**
 * The least share a refinement must free when it is this plugin that asked.
 *
 * A compaction this plugin requested is one the engine was not going to run,
 * so a refinement that frees almost nothing has spent it for nothing and the
 * window is barely better off than before.
 */
const REFINE_FLOOR = 0.1

/**
 * The least share a refinement must free when the engine is already compacting.
 *
 * The floor above weighs a refinement against leaving the conversation alone.
 * On the engine's own trigger that is not the choice: it is compacting now, and
 * standing aside hands it a summary — a paraphrase of the whole conversation,
 * where what is left out is gone and what is kept is reworded. Against that,
 * keeping every survivor verbatim wins at a far smaller reduction, so the bar
 * is the point below which the saving is not worth the rows it costs rather
 * than the point where a compaction pays for itself.
 *
 * Measured on this machine's own sessions at the 10% bar: reductions of 8.5%,
 * 4.5%, 1.0% and 0.9% were all refused and summarised instead.
 */
const ENGINE_FLOOR = 0.03

/**
 * The largest share of the context window a refinement may leave behind.
 *
 * Read by the `session.compact` hook before it installs a refinement; above
 * it the engine summarises instead, so a compaction always leaves room for
 * the next turn.
 */
const REFINE_FIT = 0.8

/**
 * The share this trigger must free to install.
 *
 * @param trigger what asked for the compaction
 * @returns the floor it is held to
 */
function floorFor(trigger: string): number {
  return trigger === 'precompute' || trigger === 'plugin'
    ? REFINE_FLOOR
    : ENGINE_FLOOR
}

/**
 * How long after a turn ends a refinement is asked for.
 *
 * A `turn.complete` hook still runs inside the turn, and a compaction is
 * refused there: "a turn is in flight; the conversation compacts between
 * turns". Long enough to be past that boundary, short enough that the next
 * turn has usually not started.
 */
const REFINE_DELAY_MS = 1_500

/**
 * Handles a reviewer agreed could go, from the last run over this
 * conversation.
 *
 * Keyed by handle rather than by position because a position means nothing
 * across a compaction and a handle is the engine's own name for a message.
 */
let releasedHandles = new Set<string>()

/**
 * Handles the person named through `/backseat forget`, which the rules would
 * otherwise have kept.
 */
let demandedHandles = new Set<string>()

/**
 * The session's own transcript, as the messages a cleaner is asked about.
 *
 * The file is found by its session id rather than by deriving a directory
 * name from the working directory, because the host's own mapping of a path
 * to a project folder is not this plugin's to reproduce.
 *
 * Only the tail is read, and only whole lines of it: the first line of a tail
 * is almost always a fragment, and a fragment parses as nothing.
 *
 * @param $ the mods API
 * @returns the entries, and a sentence naming what stopped it when it found none
 */
async function transcriptEntries(
  $: EngineInterface,
): Promise<{ entries: readonly Entry[]; bytes: number; isPartial: boolean; problem: string }> {
  const empty = { entries: [] as Entry[], bytes: 0, isPartial: false }
  const home = await homeDir($)
  const id = await $.session.id().catch(() => '')

  if (home === '' || id === '') {
    return { ...empty, problem: 'This session has no id on disk, so its transcript cannot be found.' }
  }

  // The host decides which project folder a working directory maps to, and
  // that mapping is not this plugin's to reproduce, so the folders are listed
  // and the one holding this session's file is the answer.
  const root = `${home}/.claude/projects`
  const folders = await $.fs.list(root).catch(() => undefined)

  if (folders === undefined) {
    return { ...empty, problem: `The transcript folder ${root} could not be listed.` }
  }

  let path = ''

  for (const folder of folders) {
    const candidate = `${root}/${folder.name}/${id}.jsonl`

    if (await $.fs.exists(candidate).catch(() => false)) {
      path = candidate
      break
    }
  }

  if (path === '') {
    return {
      ...empty,
      problem:
        `No transcript file was found for this session (${id}) in ${root}, ` +
        `across ${folders.length} project folder(s).`,
    }
  }

  const read = await readTail($, path, TRANSCRIPT_CHARACTERS)
  const body = read.text

  if (body.trim() === '') {
    return {
      ...empty,
      problem:
        `The transcript at ${path} could not be read` +
        (read.problem === '' ? '.' : `: ${read.problem}`),
    }
  }

  const lines = body.split(/\r?\n/)
  const isPartial = read.isPartial
  const entries: Entry[] = []
  let index = 0

  // A tail begins mid-line whenever the file is larger than the budget, so the
  // first line is dropped rather than parsed: half a row is not a message.
  for (const line of isPartial ? lines.slice(1) : lines) {
    if (line.trim() === '') {
      continue
    }

    const row: unknown = parseRow(line)

    if (row === undefined) {
      continue
    }

    const entry = entryOf(row, index)

    if (entry !== undefined) {
      entries.push(entry)
      index += 1
    }
  }

  return entries.length === 0
    ? { ...empty, problem: `The transcript at ${path} holds no readable messages.` }
    : { entries, bytes: body.length, isPartial, problem: '' }
}

/**
 * The last bytes of a file, by way of files rather than a pipe.
 *
 * Two host limits shape this. What a subprocess writes to standard output is
 * captured and truncated silently, so a `tail` of a large transcript comes
 * back a fraction of what was asked for and reports no error — which reads
 * exactly like a short session. And `$.fs.read` refuses a file over four
 * mebibytes. So the tail is written to files under that limit and each is read
 * in turn, oldest piece first.
 *
 * @param $ the mods API
 * @param path the file to read
 * @param want the most bytes to return
 * @returns the text, whether the file holds more, and what stopped it
 */
async function readTail(
  $: EngineInterface,
  path: string,
  want: number,
): Promise<{ text: string; isPartial: boolean; problem: string }> {
  const sized = await $.process
    .run(['wc', '-c', path], { timeoutMs: 20000 })
    .catch(() => undefined)
  const total = Number.parseInt((sized?.stdout ?? '').trim().split(/\s+/)[0] ?? '', 10)

  if (!Number.isFinite(total) || total <= 0) {
    return { text: '', isPartial: false, problem: `${path} reported no size` }
  }

  const take = Math.min(want, total)
  const spool = `${path}.backseat-tail`
  const pieces: string[] = []
  let problem = ''

  for (let read = 0; read < take; read += SPOOL_BYTES) {
    const size = Math.min(SPOOL_BYTES, take - read)
    // Counted from the end of the file, so the pieces of the stretch being
    // kept are written oldest first and join in order.
    const from = take - read
    const copied = await $.process
      .run(
        [
          'sh',
          '-c',
          `tail -c ${from} ${JSON.stringify(path)} | head -c ${size} > ${JSON.stringify(spool)}`,
        ],
        { timeoutMs: 180000 },
      )
      .catch(() => undefined)

    if (copied === undefined || copied.exitCode !== 0) {
      problem = copied === undefined
        ? 'the tail could not be written'
        : `writing the tail exited ${copied.exitCode}: ${reasonOf(copied.stderr, copied.stdout)}`
      break
    }

    const piece = await $.fs.read(spool).catch((error: unknown) => {
      problem = `reading a ${size}-byte piece failed: ${messageOf(error)}`

      return ''
    })

    if (piece === '') {
      break
    }

    pieces.push(String(piece))
  }

  await $.process
    .run(['rm', '-f', spool], { timeoutMs: 20000 })
    .catch(() => undefined)

  return { text: pieces.join(''), isPartial: take < total, problem }
}

/**
 * One transcript row as JSON, or undefined when it is not.
 *
 * @param line one line of the transcript file
 * @returns the parsed row
 */
function parseRow(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/**
 * One row as an entry, or undefined when the row carries no message.
 *
 * The text is rebuilt from the blocks rather than taken from the row, because
 * a row also carries rendered copies and hook records that no reviewer is
 * shown; counting those would make every window a fraction of its budget.
 *
 * @param row a parsed transcript row
 * @param index the position among the messages read so far
 * @returns the entry
 */
function entryOf(row: unknown, index: number): Entry | undefined {
  if (typeof row !== 'object' || row === null) {
    return undefined
  }

  const message = (row as { message?: unknown }).message

  if (typeof message !== 'object' || message === null) {
    return undefined
  }

  const { role, content } = message as { role?: unknown; content?: unknown }

  if (typeof role !== 'string') {
    return undefined
  }

  if (typeof content === 'string') {
    return { index, role, text: content, chars: content.length, opensTurn: role === 'user' }
  }

  if (!Array.isArray(content)) {
    return undefined
  }

  const parts: string[] = []
  let isOnlyResults = true

  for (const block of content) {
    if (typeof block !== 'object' || block === null) {
      continue
    }

    const { type } = block as { type?: unknown }

    if (type === 'text') {
      const { text } = block as { text?: unknown }
      if (typeof text === 'string') parts.push(text)
      isOnlyResults = false
    } else if (type === 'tool_use') {
      const { name, input } = block as { name?: unknown; input?: unknown }
      parts.push(`${String(name)}(${JSON.stringify(input ?? {})})`)
      isOnlyResults = false
    } else if (type === 'tool_result') {
      const body = (block as { content?: unknown }).content
      parts.push(typeof body === 'string' ? body : JSON.stringify(body ?? ''))
    } else {
      isOnlyResults = false
    }
  }

  const text = parts.join('\n')

  return {
    index,
    role,
    text,
    chars: text.length,
    // A user message that carries only tool results is the host returning what
    // the assistant asked for, not a person taking a turn, so it is not a
    // boundary a window may close on.
    opensTurn: role === 'user' && !isOnlyResults,
  }
}

/**
 * Asks the cleaner lanes what in this session's transcript no longer needs to
 * stay, and publishes what they say as cards.
 *
 * The transcript is cut into windows that each fit one question, and every
 * cleaner is asked about every window, so a lane's answer rests on a stretch
 * it saw whole rather than on a reduction of the whole session.
 *
 * A cleaner is asked of the provider it names and of no other: `runLane` is
 * called directly rather than through `withFallback`, so a window is judged by
 * the reviewer configured for it or not at all. A second opinion from a
 * different model about which of someone's own words are disposable is not a
 * substitute for the first.
 *
 * Nothing here edits the transcript. The findings say what looks reclaimable
 * and where; what to do about it stays with the person reading the card.
 *
 * @param $ the mods API
 * @param config the limits and the floors
 * @param cleaners the cleaner lanes to ask
 * @param entries the transcript, as messages
 * @param isPartial whether only the transcript's tail was read
 */
async function clean(
  $: EngineInterface,
  config: Config,
  cleaners: readonly Lane[],
  entries: readonly Entry[],
  isPartial: boolean,
): Promise<void> {
  const mine = generation

  isReviewing = true
  isCleaning = true

  try {
    // The rules first: most of a transcript can be settled for nothing, and a
    // provider call costs minutes. What the rules leave is the residue, and it
    // is the only thing worth asking about.
    const cleaningConfig: Config = {
      ...config,
      timeoutMs: Math.max(config.timeoutMs, CLEAN_TIMEOUT_MS),
    }
    const verdicts = tiersOf(entries, ANCHOR_MESSAGES)
    const measured = measure(entries, verdicts)
    const residue = new Set(residueOf(verdicts))
    const repeats = repeatedCalls(entries)
    const sized = new Map(entries.map(one => [one.index, one]))
    const anchor = entries.slice(-ANCHOR_MESSAGES)
    // A message the rules already found a supersession for needs less of the
    // model's own confidence to be let go.
    const superseded = new Set(repeatedCalls(entries).keys())

    const all = windowsOf(entries, WINDOW_CHARACTERS, WINDOW_OVERLAP)
    // The newest windows, since they are the part still carried in context,
    // and of those only the ones holding something no rule settled.
    const windows = all
      .slice(-WINDOW_LIMIT)
      .filter(window => window.entries.some(one => residue.has(one.index)))
    const sessionChars = entries.reduce((total, entry) => total + entry.chars, 0)
    const schemaPath = `${$.plugin.root}/schemas/finding.schema.json`
    const perLane = new Map<string, LaneResult>()
    const found: Finding[] = []
    let asked = 0
    let redactions = 0

    for (const window of windows) {
      // Replaced once per window rather than once per lane, so every reviewer
      // of one window is sent the same text and the count reported is the
      // count sent.
      const sent = redactWindow(window)

      redactions += sent.redactions

      for (const batch of batches(cleaners, config.maxConcurrency)) {
        for (const lane of batch) {
          inFlight.add(lane.name)
        }

        const answers = await Promise.all(
          batch.map(async lane => {
            const read =
              lane.docs.length > 0 ? await readDocs($, lane.docs) : { docs: [] }
            const ask = (framing: 'own' | 'newest'): Promise<LaneResult> =>
              runLane($, cleaningConfig, lane, schemaPath, {
                purpose,
                diff: '',
                isDiffTruncated: false,
                paths: [],
                docs: fitDocs(read.docs),
                earlier: [],
                window: sent.window,
                redactions: sent.redactions,
                framing,
                anchor: framing === 'newest' ? anchor : [],
              })

            // The window is judged on what it says and against what the
            // session is doing now. Neither framing releases anything alone.
            const [own, newest] = await Promise.all([ask('own'), ask('newest')])

            return agreedResult(own, newest, superseded)
          }),
        )

        for (const lane of batch) {
          inFlight.delete(lane.name)
        }

        for (const answer of answers) {
          // A reviewer names the message it is about; the reference it can be
          // fetched back by is this panel's to stamp, because only the panel
          // knows the text the fingerprint is taken against.
          const stamped = {
            ...answer,
            findings: answer.findings.map(finding => {
              const entry = sized.get(finding.lineStart)

              return entry === undefined
                ? finding
                : { ...finding, reference: rehydrationFor(entry).ref }
            }),
          }

          found.push(...stamped.findings)
          perLane.set(answer.lane, mergedResult(perLane.get(answer.lane), stamped))
        }
      }

      asked += 1

      // A cancelled run stops between windows rather than after all of them,
      // because the windows are the expensive part and `/backseat cancel` is
      // asked for while they are still being spent.
      if (mine !== generation) {
        return
      }
    }

    if (mine !== generation) {
      return
    }

    const results = [...perLane.values()]
    const byRule: Finding[] = []

    for (const [at, first] of repeats) {
      const entry = sized.get(at)

      // A repeat is tiered `repeat`, never `residue`, so filtering these to
      // residue skipped every one of them: the rules found them and then the
      // panel threw them away.
      if (entry === undefined) {
        continue
      }

      const ref = rehydrationFor(entry)

      byRule.push({
        lane: 'rules',
        alsoFrom: [],
        severity: 'low',
        title: `The call at ${at} repeats the one at ${first}`,
        body:
          'The same tool call, with only its numbers differing. The input is' +
          ' carried whole every time it is made, and a session that runs a' +
          ' script many times carries it many times.',
        file: 'this session transcript',
        lineStart: at,
        lineEnd: at,
        confidence: 0.9,
        recommendation: `Say "as at message ${first}" instead of the input again.`,
        reference: ref.ref,
      })
    }

    const rules = ruleResult(byRule)
    const ranked = rank([...results, rules], seen)
    // Counted over the messages named, once each: windows overlap, so a
    // message reported from two of them is one message, not two.
    const reclaimable = claimedChars(
      entries,
      [...new Set(ranked.map(finding => finding.lineStart))],
    )

    lanes = [rules, ...results]
    findings = [
      ...ranked,
      summaryFinding(
        sessionChars,
        reclaimable,
        all.length,
        asked,
        isPartial,
        redactions,
        measured,
      ),
    ]

    for (const finding of findings) {
      seen.add(subjectOf(finding))
    }

    await $.store.set(sessionKey, [...seen].slice(-400)).catch(() => undefined)

    $.ui.invalidate('ui.render')
  } finally {
    // Cleared whatever happened, and whoever won the generation race: a flag
    // left set by a cancelled or failed clean would block every later prompt.
    isCleaning = false

    if (mine === generation) {
      isReviewing = false
      inFlight = new Set()
    }
  }
}

/**
 * The handles a reviewer agrees may go, asked over the live conversation.
 *
 * Only the residue is asked about: the rules settled the rest for nothing, and
 * a provider call costs minutes. The windows are cut over the whole
 * conversation so a reviewer sees each candidate in its place, and each one is
 * judged by both framings, so nothing is released on a single opinion.
 *
 * @param $ the mods API
 * @param config the panel's options
 * @param rows the live conversation
 * @param verdicts what the rules made of it
 * @returns the handles that may be released
 */
async function releasedBy(
  $: EngineInterface,
  config: Config,
  rows: readonly Row[],
  verdicts: readonly Verdict[],
  isWaited: boolean,
): Promise<{ released: Set<string>; demanded: Set<string> }> {
  // Read before anything is started, not after it has failed again: a cleaner
  // inside its refusal wait refuses in the same second, and this runs on every
  // compaction, so asking anyway paid the whole timeout each time.
  const reads = roster.filter(lane => lane.sees.includes('transcript'))
  const cleaners: Lane[] = []
  let waiting = 0

  for (const lane of reads) {
    if (await unaskable($, lane)) {
      waiting += 1
    } else {
      cleaners.push(lane)
    }
  }

  const residue = new Set(residueOf(verdicts))
  const demanded = new Set<string>()

  // A dispatch someone waits behind does not ask. A window is a prompt of
  // hundreds of thousands of characters: measured against this provider, 70k
  // answered in 33s and 190k in 295s, so the bound a waiting session can be
  // held for buys a prompt too small to carry a window and the anchor beside
  // it, and the provider read the whole thing and was cut off with nothing
  // released. What `precompute` released is held in `releasedHandles` and used
  // here instead. An asked-for drop still asks: the person asked for it, and
  // is waiting for it on purpose.
  if (isWaited && drops.length === 0) {
    await note(
      $,
      'nothing was asked: a refinement someone waits behind uses what an ' +
        `earlier dispatch released (${releasedHandles.size} handle(s))`,
    )

    return { released: new Set(), demanded: new Set() }
  }

  if (cleaners.length === 0 && waiting > 0) {
    await note(
      $,
      `every lane that reads the transcript is inside its refusal wait ` +
        `(${waiting} of ${reads.length}), so nothing was asked and nothing ` +
        'could be released',
    )

    return { released: new Set(), demanded: new Set() }
  }

  if (cleaners.length === 0) {
    // Named, not merely reported: a cleaner is missing either because no lane
    // file sets `sees: transcript` or because the directory holding one was
    // not read, and the roster and the directories it was built from are the
    // only way to tell those apart from the log afterwards.
    const held =
      roster.length === 0
        ? 'the roster is empty'
        : `the roster holds ${roster.length}: ${roster
            .map(lane => lane.name)
            .join(', ')}`
    const where = laneDirs
      .map(
        dir =>
          `${dir.scope} ${dir.path} ${
            dir.isPresent ? `(${dir.found} lane file(s))` : '(absent)'
          }`,
      )
      .join('; ')

    await note(
      $,
      `no lane reads the transcript, so nothing could be released — ${held}; ` +
        `looked in: ${where === '' ? 'no lane directory' : where}`,
    )

    return { released: new Set(), demanded: new Set() }
  }

  if (residue.size === 0) {
    await note($, 'the rules left no residue, so there was nothing to ask about')

    return { released: new Set(), demanded: new Set() }
  }

  const byPosition = new Map(rows.map(row => [row.at, row]))
  const entries = entriesOf(rows)
  // A compaction someone is waiting behind cannot take as long as one nothing
  // is waiting behind. `precompute` installs nothing and its answer is kept
  // for later, so it gets the whole budget; a refinement at a full window gets
  // a bounded one, because the alternative is a person watching a progress
  // line for twenty minutes.
  // An asked-for drop reads the whole conversation it can afford, and reads it
  // without the residue filter: what the person named is theirs to name, it
  // need not be something the rules had already given up on, and a window
  // skipped for holding no residue is where an old error would be sitting. The
  // bounded window budget is for the standing clean, which runs unasked on
  // every compaction; this one was asked for.
  const isAsked = drops.length > 0
  const windows = windowsOf(entries, WINDOW_CHARACTERS, WINDOW_OVERLAP)
    .slice(-WINDOW_LIMIT)
    .filter(
      window =>
        isAsked || window.entries.some(one => residue.has(one.index)),
    )
  const schemaPath = `${$.plugin.root}/schemas/finding.schema.json`
  const cleaningConfig: Config = {
    ...config,
    timeoutMs: Math.max(config.timeoutMs, CLEAN_TIMEOUT_MS),
  }
  const anchor = entries.slice(-ANCHOR_MESSAGES)
  const released = new Set<string>()

  await note(
    $,
    `asking ${cleaners.length} lane(s) about ${windows.length} of ` +
      `${Math.ceil(entries.length / 1)} rows' worth of windows; ${residue.size} ` +
      'message(s) are residue',
  )

  for (const window of windows) {
    const sent = redactWindow(window)

    for (const batch of batches(cleaners, config.maxConcurrency)) {
      const answers = await Promise.all(
        batch.map(async lane => {
          // What the person asked for is added to the lane's own subject, and
          // said to outrank the rules it is asked past: an API error and a
          // superseded answer are both things `tidy` is told never to name.
          const asked =
            drops.length === 0
              ? lane
              : {
                  ...lane,
                  question:
                    `${lane.question}\n\nThe person has also asked for these to go, ` +
                    `in their words: ${drops.join('; ')}. Report any message that is ` +
                    'one of them even where the rules above say never to, and say ' +
                    'which of their words it answers.',
                }
          const ask = (framing: 'own' | 'newest'): Promise<LaneResult> =>
            runLane($, cleaningConfig, asked, schemaPath, {
              purpose,
              diff: '',
              isDiffTruncated: false,
              paths: [],
              docs: [],
              earlier: [],
              window: sent.window,
              redactions: sent.redactions,
              framing,
              anchor: framing === 'newest' ? anchor : [],
            })

          const [first, second] = await Promise.all([ask('own'), ask('newest')])

          return agreedResult(first, second, new Set())
        }),
      )

      for (const answer of answers) {
        // Why a window released nothing is the question the floor note cannot
        // answer: a reviewer that failed, one that answered clean, and one
        // whose findings were all rejected look identical from outside.
        await note(
          $,
          `${answer.lane} on messages ${window.fromIndex}-${window.toIndex}: ` +
            `${answer.outcome}, ${answer.findings.length} finding(s)` +
            (answer.detail === '' ? '' : ` — ${answer.detail}`),
        )

        for (const finding of answer.findings) {
          const row = byPosition.get(finding.lineStart)

          // Only a message the rules left unsettled may be released, whatever
          // a reviewer says about one they already settled.
          if (row !== undefined && row.handle !== '' && isAsked) {
            // Named while something was asked for. Recorded as demanded even
            // when the rules had already made it residue, because residue is
            // still held by recency and by its pair's tier, and an asked-for
            // drop is meant to reach past both.
            demanded.add(row.handle)
            released.add(row.handle)
          } else if (
            row !== undefined &&
            row.handle !== '' &&
            residue.has(row.at)
          ) {
            released.add(row.handle)
          } else {
            await note(
              $,
              `${answer.lane} named message ${finding.lineStart}, which the rules had` +
                ' already settled — not released',
            )
          }
        }
      }
    }
  }

  return { released, demanded }
}

/**
 * What a refinement of this conversation would come to, without doing it.
 *
 * The decision a `session.compact` hook makes is otherwise invisible: it
 * either hands back messages or stands aside, and standing aside looks exactly
 * like a plugin that is not loaded. This reports the same arithmetic against
 * the live conversation, so the floor and the rules can be seen working.
 *
 * `$.session.messages()` carries no handles, so this cannot show what a
 * reviewer released — only what the rules settle by themselves, which is the
 * part that runs for nothing and the part that decides whether a refinement
 * clears the floor at all.
 *
 * @param $ the mods API
 * @param config the panel's options
 * @returns the report
 */
async function refinePlan($: EngineInterface, config: Config): Promise<string> {
  // Named first, and before anything that can fail: the build answering is
  // the one fact worth having when a report is otherwise empty.
  const build = await loadedVersion($)
  const header = `backseat ${build === '' ? '(version unknown)' : build} is the build answering.`
  const messages = await $.session.messages().catch(() => undefined)

  if (messages === undefined || messages.length === 0) {
    return `${header}\n\nThis conversation could not be read.`
  }

  const rows = rowsOf(messages as readonly SessionMessage[])
  const verdicts = tiersOf(entriesOf(rows), ANCHOR_MESSAGES)
  const keep = survivorsOf(
    rows,
    verdicts,
    releasedHandles,
    ANCHOR_MESSAGES,
    demandedHandles,
  )
  const measured = measure(entriesOf(rows), verdicts)
  const freedChars = rows
    .filter(row => !keep.has(row.at))
    .reduce((sum, row) => sum + row.chars, 0)
  const share = measured.chars > 0 ? (freedChars / measured.chars) * 100 : 0
  const clears = worthInstalling(rows, keep, REFINE_FLOOR)

  const log = await $.store.get(logKey).catch(() => undefined)
  const lines = Array.isArray(log) ? log.filter(one => typeof one === 'string') : []

  return [
    header,
    '',
    `${messages.length} message(s), ${measured.chars.toLocaleString('en-US')} characters.`,
    '',
    `Rules settled ${measured.settledShare}% of it without a provider;` +
      ` ${measured.residueShare}% is residue, which only a reviewer can release.`,
    `${rows.length - keep.size} message(s) would go, freeing` +
      ` ${freedChars.toLocaleString('en-US')} characters (${share.toFixed(1)}%).`,
    '',
    config.refine === 'off'
      ? 'refine is off, so a compaction summarises as it always has.'
      : clears
        ? 'That clears the floor, so a compaction would install this instead of a summary.'
        : `That is under the ${Math.round(REFINE_FLOOR * 100)}% floor, so a compaction` +
          ' would summarise instead. Run /backseat clean first: what a reviewer' +
          ' releases is what moves residue, and residue is where the mass is.',
    ...(lines.length > 0
      ? ['', 'What this session\'s refinements did:', ...lines.slice(-10).map(one => `  ${one}`)]
      : ['', 'No refinement has been attempted in this session.']),
  ].join('\n')
}

/**
 * Starts a refinement when the context window has filled past the mark.
 *
 * The engine compacts at its own threshold, and a summary is a paraphrase. A
 * refinement started before that point replaces the conversation with the
 * engine's own messages minus what was released, so the session carries on
 * denser rather than restarting from a summary.
 *
 * It asks for a compaction rather than performing one: the `session.compact`
 * hook is what decides, and routing through it means a refinement the person
 * started by hand and one a full window started are the same path.
 *
 * @param $ the mods API
 * @param config the panel's options
 */
async function maybeRefine($: EngineInterface, config: Config): Promise<void> {
  if (config.refine !== 'on') {
    return
  }

  // The mark being off disarms the watcher, not an asked-for drop: `forget`
  // names something to go, and nothing about it depends on how full the
  // context is.
  if (config.refineAtPercent <= 0 && !askedCompact) {
    await note($, 'not armed: refineAtPercent is 0')

    return
  }

  if (isCleaning) {
    await note($, 'held: a clean is running')

    return
  }

  if (drops.length === 0 && (await nothingCanRun($))) {
    await note($, 'held: no provider can be reached or is inside its refusal wait')

    return
  }

  if (drops.length === 0 && (await noCleanerCanRun($))) {
    await note(
      $,
      'held: no lane that reads the transcript can be asked, so a refinement' +
        ' could only summarise',
    )

    return
  }

  let failure = ''
  const usage = await $.session.usage().catch((error: unknown) => {
    failure = messageOf(error)

    return undefined
  })

  if (usage === undefined) {
    await note($, `could not read the context fill: ${failure}`)

    return
  }

  const percent = usage.context?.percent ?? -1

  if (percent < 0) {
    await note($, 'the context fill was not reported')

    return
  }

  // An asked-for drop is not waiting for the mark: the person named something
  // to go, and the mark is about when thinning pays for itself unasked.
  if (percent < config.refineAtPercent && !askedCompact) {
    await note(
      $,
      `${percent.toFixed(1)}% full, under the ${config.refineAtPercent}% mark`,
      false,
    )

    return
  }

  if (askedCompact) {
    askedTries += 1

    if (askedTries > ASK_TRIES) {
      askedCompact = false
  askedTries = 0
      askedTries = 0

      await note(
        $,
        `the asked-for drop was refused ${ASK_TRIES} times and is not being` +
          ' asked for again; /backseat forget asks again',
      )

      return
    }
  }

  if (isSpentWait(Date.now(), compactSpentAt)) {
    await note($, `held: the session's own compaction is spent — ${compactSaid}`)

    return
  }

  // An asked-for drop is not held by this: the person named something to go.
  if (!askedCompact && !precomputeReady) {
    await note(
      $,
      `held at ${percent.toFixed(1)}%: no precomputed refinement is ready, so a ` +
        'compaction asked for now would only summarise',
      false,
    )

    return
  }

  // Documented as rejecting while a turn runs, which is why this is called as
  // one ends — and why the rejection is reported rather than swallowed.
  const done = await $.session.compact().catch((error: unknown) => {
    failure = messageOf(error)

    return undefined
  })

  if (done === undefined) {
    // A turn in flight is transient and is asked again when the next one ends.
    // A spent account is not: it refuses again at once.
    if (isAtLimit(failure)) {
      compactSpentAt = Date.now()
      compactSaid = failure
    }

    await note($, `asked for a refinement at ${percent.toFixed(1)}% and it was refused: ${failure}`)

    return
  }

  if (done.skip !== undefined) {
    await note($, `a refinement at ${percent.toFixed(1)}% was vetoed: ${done.skip}`)

    return
  }

  // This plugin's own hook did not see the compaction it asked for, so it did
  // not clear what the precompute left; installed now, it is spent.
  precomputeReady = false
  compactSpentAt = 0
  compactSaid = ''

  // Cleared here and nowhere earlier: a refusal is the case the ask exists to
  // survive. `a turn is running` arrives whenever this fires inside one, and
  // clearing before the attempt threw the request away on exactly the refusal
  // it should have waited out — the next turn's end retries it.
  askedCompact = false

  // What this call knows is that the engine accepted and compacted, not that a
  // refinement was installed: the reduction is reported by the trigger-prefixed
  // note the hook writes, and when no such note accompanies this line the
  // engine summarised. Claiming the refinement here read as a success on every
  // compaction the hook never saw.
  await note($, `the engine compacted on request at ${percent.toFixed(1)}% full`)
  $.ui.toast(`backseat: compacted the conversation at ${Math.round(percent)}% full`)
}

/**
 * The build that is actually loaded, read from the manifest beside the module.
 *
 * A session loads a plugin's code once, at its start, so a release made since
 * then is installed and not running. Nothing in the panel's own output said
 * which build was answering, which made "did the reload take" unanswerable
 * from inside the session it mattered in.
 *
 * @param $ the mods API
 * @returns the version, or empty when the manifest could not be read
 */
async function loadedVersion($: EngineInterface): Promise<string> {
  const text = await $.fs
    .read(`${$.plugin.root}/.claude-plugin/plugin.json`)
    .catch(() => '')

  const found = /"version"\s*:\s*"([^"]+)"/u.exec(String(text ?? ''))

  return found?.[1] ?? ''
}

/**
 * Records one line about a refinement, where it can be read afterwards.
 *
 * `$.ui.log` is not a debug channel: what it writes is posted into the
 * conversation, so every line here was being read back as context by the model
 * the next turn. A path whose purpose is to reclaim context cannot spend it
 * reporting on itself — a compaction cycle was posting thousands of characters
 * of its own notes — so the line goes to the store, and to the conversation
 * only when `debug` asks for it. The store is also the one place a line
 * survives the session it was written in.
 *
 * The store holds forty lines, and what it is read for is the outcome of a
 * compaction — which trigger ran, what it freed, whether it installed. The
 * watcher writes a line per turn whether or not anything happened, so those
 * lines are kept out of the store (`durable` false) and a line repeating the
 * one before it is not written twice. Without both, a session's outcomes
 * rotated out within minutes of being recorded and the store answered nothing.
 *
 * @param $ the mods API
 * @param line what happened
 * @param durable whether the line is worth one of the forty kept slots
 */
async function note(
  $: EngineInterface,
  line: string,
  durable = true,
): Promise<void> {
  if (loud) {
    $.ui.log(`backseat: ${line}`)
  }

  if (!durable) {
    return
  }

  const at = new Date().toISOString()
  const held = await $.store.get(logKey).catch(() => undefined)
  const kept = Array.isArray(held) ? held.filter(one => typeof one === 'string') : []
  const last = kept.at(-1) ?? ''

  // The timestamp is the only part that always differs, so the comparison is
  // made against what follows it.
  if (last.slice(last.indexOf(' ') + 1) === line) {
    return
  }

  await $.store
    .set(logKey, [...kept, `${at} ${line}`].slice(-40))
    .catch(() => undefined)
}

/**
 * The live conversation as the rules read it.
 *
 * `uses` and `results` carry the tool call ids, which is what keeps a call and
 * its result from being separated when the conversation is rebuilt.
 *
 * @param messages the conversation the compaction was handed
 * @returns the rows, oldest first
 */
function rowsOf(messages: readonly SessionMessage[]): Row[] {
  return messages.map((message, at) => {
    const uses = (message.toolUses ?? []).map(use => use.tool_use_id)
    const results = (message.toolResults ?? []).map(one => one.tool_use_id)
    // A call is written the way the transcript path writes it, `Tool(input)`,
    // so one fingerprint reads both: without the input `callPrint` matched on
    // whatever parenthesis happened to be in a result body, which found
    // repeats that were not repeats.
    const text = [
      message.text ?? '',
      ...(message.toolUses ?? []).map(
        use => `${use.tool ?? ''}(${JSON.stringify(use.input ?? {})})`,
      ),
      ...(message.toolResults ?? []).map(one => one.text ?? ''),
    ].join('\n')

    return {
      at,
      role: message.role,
      text,
      chars: text.length,
      // A user message carrying only tool results is the host answering the
      // assistant, not a person taking a turn.
      opensTurn: message.role === 'user' && results.length === 0,
      uses,
      results,
      handle: message.handle ?? '',
    }
  })
}

/**
 * One row as the tiering and the references read it.
 *
 * @param row the conversation row
 * @returns the entry
 */
function entryOfRow(row: Row): Entry {
  return {
    index: row.at,
    role: row.role,
    text: row.text,
    chars: row.chars,
    opensTurn: row.opensTurn,
  }
}

/**
 * The rows as the tiering reads them.
 *
 * @param rows the conversation
 * @returns one entry per row, in order
 */
function entriesOf(rows: readonly Row[]): Entry[] {
  return rows.map(row => ({
    index: row.at,
    role: row.role,
    text: row.text,
    chars: row.chars,
    opensTurn: row.opensTurn,
  }))
}

/**
 * One reclaimed message, fetched back out of the transcript.
 *
 * A reduction that cannot be undone is a bet that nothing will need what it
 * took. This is the other half of that bet: the message is still in the file,
 * so asking for it again is a lookup. The fingerprint is checked and a
 * mismatch is reported rather than hidden, because a reference that no longer
 * names what it was taken against is worse than no reference.
 *
 * @param $ the mods API
 * @param ref the reference a finding named
 * @returns the message, or a sentence saying why it could not be fetched
 */
async function rehydrate($: EngineInterface, ref: string): Promise<string> {
  const matched = /^m(\d+)\.([0-9a-f]{8})$/u.exec(ref.trim())

  if (matched === null) {
    return `"${ref}" is not a reference. They look like m41.ab12cd34.`
  }

  const wanted = Number.parseInt(matched[1] ?? '', 10)
  const read = await transcriptEntries($)

  if (read.problem !== '') {
    return read.problem
  }

  const entry = read.entries.find(one => one.index === wanted)

  if (entry === undefined) {
    return (
      `Message ${wanted} is not in the part of the transcript that was read.` +
      ' Only the tail is read, so a reference into an older stretch cannot be' +
      ' fetched back from here; the whole of it is still in the session file.'
    )
  }

  const now = printOf(entry.text)
  const warning =
    now === matched[2]
      ? ''
      : `\n\n[the message changed since the reference was taken: ${matched[2]} then, ${now} now]`

  return `Message ${wanted} (${entry.role}, ${entry.chars} characters):\n\n${entry.text}${warning}`
}

/**
 * One window's verdict, out of the two framings that judged it.
 *
 * A message survives unless both framings release it. The scores are read off
 * each framing's answer — a message a framing did not name is needed fully —
 * blended with the recency weight, and checked against the bar the local
 * engine uses, lowered where the rules already found a supersession.
 *
 * What one framing named and the other did not is reported as dissent rather
 * than silently dropped, because the count of disagreements is the only
 * evidence anyone has that asking twice was worth the second call.
 *
 * @param own what the framing holding the window's own content said
 * @param newest what the framing anchored on current work said
 * @param superseded messages the rules already found a supersession for
 * @returns the agreed result
 */
function agreedResult(
  own: LaneResult,
  newest: LaneResult,
  superseded: ReadonlySet<number>,
): LaneResult {
  if (own.outcome === 'failed' || own.outcome === 'skipped') {
    return own
  }

  if (newest.outcome === 'failed' || newest.outcome === 'skipped') {
    return newest
  }

  const scoreOf = (result: LaneResult): Map<number, number> =>
    new Map(result.findings.map(finding => [finding.lineStart, finding.confidence]))
  const ownScores = scoreOf(own)
  const newestScores = scoreOf(newest)
  const agreed: Finding[] = []
  let dissent = 0

  for (const finding of [...own.findings, ...newest.findings]) {
    const at = finding.lineStart

    if (agreed.some(kept => kept.lineStart === at)) {
      continue
    }

    const needed = (named: ReadonlyMap<number, number>): Framing => {
      const value = neededFrom(named, at)

      return { callNeeded: value, resultNeeded: value }
    }

    const released = releases(
      combine(needed(ownScores), needed(newestScores), FRAMING_WEIGHTS),
      FRAMING_WEIGHTS.bar,
      superseded.has(at),
      SUPERSESSION_BIAS,
    )

    if (released) {
      agreed.push(finding)
    } else {
      dissent += 1
    }
  }

  return {
    ...own,
    outcome: agreed.length > 0 ? 'findings' : 'clean',
    findings: agreed,
    latencyMs: own.latencyMs + newest.latencyMs,
    detail:
      dissent > 0
        ? `${dissent} held: one framing named it and the other did not`
        : own.detail,
  }
}

/**
 * What the rules found, as a lane row of its own.
 *
 * The rules are a reviewer that costs nothing and never fails, and the panel
 * has one shape for a reviewer's output, so they report through it rather than
 * beside it.
 *
 * @param found what the rules reported
 * @returns the row
 */
function ruleResult(found: readonly Finding[]): LaneResult {
  return {
    lane: 'rules',
    outcome: found.length > 0 ? 'findings' : 'clean',
    findings: found,
    summary: '',
    detail: 'decided without a provider',
    latencyMs: 0,
    via: '',
    notes: '',
  }
}

/**
 * One lane's results across every window, as a single row.
 *
 * A cleaner is asked once per window, and a session of fifty windows would
 * otherwise print fifty rows for one reviewer. The outcome of the whole is the
 * worst of its parts: a lane that failed on one window did not review the
 * session, whatever it managed elsewhere.
 *
 * @param earlier the lane's result so far, absent on its first window
 * @param next the result just returned
 * @returns the merged row
 */
function mergedResult(
  earlier: LaneResult | undefined,
  next: LaneResult,
): LaneResult {
  if (earlier === undefined) {
    return next
  }

  const worst = earlier.outcome === 'failed' || next.outcome === 'failed'
    ? 'failed'
    : earlier.outcome === 'skipped' || next.outcome === 'skipped'
      ? 'skipped'
      : next.findings.length + earlier.findings.length > 0
        ? 'findings'
        : 'clean'

  return {
    ...earlier,
    outcome: worst,
    findings: [...earlier.findings, ...next.findings],
    latencyMs: earlier.latencyMs + next.latencyMs,
    detail: [earlier.detail, next.detail].filter(part => part !== '').join(' · '),
    notes: [earlier.notes, next.notes].filter(part => part !== '').join(' · '),
  }
}

/**
 * The one card a whole run reports itself with.
 *
 * A per-window finding is actionable and a long session produces many, so the
 * run also says once how much it read and how much of it is claimed. It is a
 * finding like any other so that it travels the same path: drawn above the
 * prompt, handed to the turn as context, dismissed the same way.
 *
 * Its severity is the floor, because knowing the size of the reclaim is worth
 * saying and is never a defect to be held for.
 *
 * @param sessionChars the characters the transcript read holds
 * @param reclaimable the characters the findings name
 * @param windows how many windows the transcript made
 * @param asked how many were answered before the run ended
 * @param isPartial whether only the transcript's tail was read
 * @returns the summary finding
 */
function summaryFinding(
  sessionChars: number,
  reclaimable: number,
  windows: number,
  asked: number,
  isPartial: boolean,
  redactions: number,
  measured: {
    settledShare: number
    residueShare: number
    settledChars: number
    residueChars: number
  },
): Finding {
  const scope = isPartial
    ? ' Only the most recent part of the transcript was read, so the figure covers that part.'
    : ''
  const masked = redactions > 0
    ? ` ${redactions} secret-shaped value(s) were replaced before anything was sent.`
    : ''

  return {
    lane: 'clean',
    alsoFrom: [],
    severity: 'low',
    title: summaryLine(
      sessionChars,
      reclaimable,
      windows,
      asked,
      measured.settledShare,
      measured.residueShare,
    ),
    body:
      'Each finding above names the message it is about and what makes it' +
      ` reclaimable. Nothing has been removed: this is a report.${scope}${masked}` +
      ` The rules settled ${measured.settledShare}% of the transcript without a` +
      ` provider; ${measured.residueShare}% was residue and only that was asked` +
      ' about.',
    file: 'this session transcript',
    lineStart: 0,
    lineEnd: 0,
    confidence: 1,
    recommendation: '',
    reference: 'backseat:clean:summary',
  }
}

/**
 * Runs the lanes over one body of changes and publishes what they found.
 *
 * The waves come from the lanes' own `needs`, and each lane is given the
 * findings of the lanes it names — so the lane that asks which documents a
 * change falsified reads the rewrite another lane found, and reads nothing
 * else.
 *
 * A review whose generation is stale when it finishes publishes nothing,
 * which is how `/backseat cancel` takes effect.
 *
 * @param $ the mods API
 * @param config the limits, the floors and the shared documents
 * @param paths the files to review
 * @param base the ref to diff against, empty for each repository's own
 *   baseline
 * @param only the lanes to run, empty for all of `pool`
 * @param pool the lanes this turn is reviewed by: the whole roster for the
 *   main loop, the subagent-reviewing ones for a subagent's turn
 * @param refs each repository's commit at the turn's first write, so work the
 *   turn committed itself is still reviewed
 */
async function review(
  $: EngineInterface,
  config: Config,
  paths: readonly string[],
  base: string,
  only: readonly string[],
  pool: readonly Lane[],
  refs: ReadonlyMap<string, string> = new Map(),
  loop = '',
): Promise<void> {
  const mine = generation

  isReviewing = true

  try {
    const due =
      only.length > 0
        ? pool.filter(lane => only.includes(lane.name))
        : [...pool]

    // Every reviewer this turn could ask has already said it is out of
    // quota. Taking the diff, reading the documents and building the prompts
    // would all be work done to be refused once per lane, so the review is
    // abandoned here and each lane says which account it is waiting on.
    if (due.length > 0 && due.every(lane => unaskableByLimit(lane))) {
      if (generation === mine) {
        lanes = due.map(lane =>
          resultOf(
            lane.name,
            'skipped',
            [],
            Date.now(),
            atLimit(fallbackOf(lane))
              ? `${lane.provider} and ${fallbackOf(lane)} are both at their usage limit`
              : `${lane.provider} is at its usage limit`,
            '',
            limitSaid(lane.provider) || limitSaid(fallbackOf(lane)),
          ),
        )
      }

      return
    }

    const diff = await collectDiff($, paths, base, refs)

    // No diff means no evidence. Running the lanes anyway spends a provider
    // on each one to be told nothing is wrong, and records a clean review
    // that reviewed nothing — which reads exactly like a panel that is
    // working and has found your code faultless.
    if (diff.text.trim() === '') {
      if (generation === mine) {
        lanes = due.map(lane =>
          resultOf(
            lane.name,
            'skipped',
            [],
            Date.now(),
            'nothing to review: the files changed but no diff could be taken for them',
          ),
        )
      }

      return
    }
    const shared = await readDocs($, [...config.specDocs, ...config.designDocs])
    const activity = await activityOf($, loop)
    const schemaPath = `${$.plugin.root}/schemas/finding.schema.json`
    const results: LaneResult[] = []

    for (const wave of wavesOf(due, config.crossLink)) {
      for (const batch of batches(wave, config.maxConcurrency)) {
        for (const lane of batch) {
          inFlight.add(lane.name)
        }

        const answers = await Promise.all(
          batch.map(async lane => {
            const own =
              lane.docs.length > 0 ? await readDocs($, lane.docs) : { docs: [] }

            return withFallback($, config, lane, schemaPath, {
              purpose,
              activity,
              outside: diff.outside,
              diff: diff.text,
              isDiffTruncated: diff.isTruncated,
              paths,
              docs: fitDocs([...shared.docs, ...own.docs]),
              earlier: inputsFor(lane, results),
            })
          }),
        )

        for (const lane of batch) {
          inFlight.delete(lane.name)
        }

        for (const answer of answers) {
          results.push(answer)
        }
      }
    }

    if (mine !== generation) {
      return
    }

    const ranked = rank(results, seen)

    lanes = results
    findings = ranked

    for (const finding of ranked) {
      seen.add(subjectOf(finding))
    }

    await $.store.set(sessionKey, [...seen].slice(-400)).catch(() => undefined)

    // Only a reviewer's findings are handed over: a cleaner's name messages to
    // release, not code to change. Sent worst-first, once per subject, after
    // the subjects above are recorded. Each submission is its own turn, which
    // is why the count is announced — a panel that silently queued five of
    // them would read as the session acting on its own.
    if (config.autofix === 'on') {
      const sent = ranked.filter(finding => submitFix($, finding)).length

      if (sent > 0) {
        await note($, `autofix: handed ${sent} finding(s) over to be fixed`)
        $.ui.toast(`backseat: sent ${sent} finding(s) to be fixed`)
      }
    }

    $.ui.invalidate('ui.render')
  } finally {
    if (mine === generation) {
      isReviewing = false
      inFlight = new Set()
    }
  }
}

/**
 * Asks one lane its question and reads the answer.
 *
 * A `fork` lane is answered by a fork of this conversation, which needs no
 * second subscription and cannot edit the tree; any other provider is a
 * read-only subprocess, given the answer schema where its CLI enforces one.
 *
 * A lane that throws, times out, or answers in a shape with no findings in
 * it is `failed`, never `clean`: a provider that broke must not read as a
 * reviewer that approved.
 *
 * @param $ the mods API
 * @param config the per-lane timeout
 * @param lane the reviewer to run, with its own model and floors
 * @param schemaPath the answer schema shipped with this plugin
 * @param evidence the change, the documents and the lanes it reads
 * @returns what the lane found, or why it found nothing
 */
async function runLane(
  $: EngineInterface,
  config: Config,
  lane: Lane,
  schemaPath: string,
  evidence: Evidence,
): Promise<LaneResult> {
  const startedAt = Date.now()
  const prompt = promptFor(lane, evidence)

  try {
    let answer = ''

    if (lane.provider === 'claude' || lane.provider === 'fork') {
      // A fork sees the conversation, which is worth having when the reviewer
      // should know what the session was doing — and worth avoiding when the
      // session has already talked itself into a wrong premise, since a fork
      // inherits it. A fork also has nothing to fork from in a session with
      // no transcript yet, so a cold one falls back to a self-contained
      // completion rather than reporting a reviewer that could not look.
      const forked =
        lane.provider === 'fork' ? await $.model.fork({ prompt }) : null
      const isCold =
        forked === null || (!forked.isAnswered && forked.reason === 'nothing-to-fork')

      if (forked !== null && forked.isAnswered) {
        answer = forked.text
      } else if (lane.provider === 'fork' && !isCold) {
        return resultOf(lane.name, 'failed', [], startedAt, forkReason(forked))
      } else {
        const reply = await $.model.complete({
          model: modelFor(lane) !== '' ? modelFor(lane) : config.claudeModel,
          prompt,
          maxTokens: 8000,
        })

        if (!reply.isAnswered) {
          return resultOf(lane.name, 'failed', [], startedAt, forkReason(reply))
        }

        answer = reply.text
      }
    } else if (lane.command !== '' || isSubprocess(lane.provider)) {
      // Asking a provider that has just refused for want of quota collects
      // the same refusal, so the lane is skipped without a process being
      // started and carries what the provider said as its note.
      if (atLimit(lane.provider)) {
        return resultOf(
          lane.name,
          'skipped',
          [],
          startedAt,
          `${lane.provider} is at its usage limit`,
          '',
          limitSaid(lane.provider),
        )
      }

      const invocation =
        lane.command !== ''
          ? invocationFromTemplate(lane.command, prompt, schemaPath, modelFor(lane))
          : invocationFor(lane.provider, prompt, schemaPath, modelFor(lane))

      if (invocation === undefined) {
        return resultOf(
          lane.name,
          'skipped',
          [],
          startedAt,
          'the provider has no adapter',
        )
      }

      const run = await $.process.run(invocation.argv, {
        stdin: invocation.stdin,
        timeoutMs: config.timeoutMs,
      })

      if (run.exitCode !== 0) {
        const reason = reasonOf(run.stderr, run.stdout)

        // A provider out of quota did not break and did not review: it
        // declined to be asked. Recording that is what stops the rest of the
        // turn's lanes, and the next turn's, from each buying the same
        // refusal; reporting it as skipped is what keeps it out of the count
        // of reviewers that failed.
        if (isAtLimit(reason)) {
          // Kept longer than the row's detail: a limit states its reset time
          // at the end of the sentence, which is the one part of it worth
          // reading.
          limited.set(lane.provider, {
            said: reasonOf(run.stderr, run.stdout, 600),
            at: Date.now(),
          })
          recordRun(lane.provider, '')

          await saveLimits($)

          return resultOf(
            lane.name,
            'skipped',
            [],
            startedAt,
            `${lane.provider} is at its usage limit`,
            '',
            limitSaid(lane.provider),
          )
        }

        recordRun(lane.provider, reason)

        return resultOf(
          lane.name,
          'failed',
          [],
          startedAt,
          `${lane.provider} exited ${run.exitCode}: ${reason}`,
        )
      }

      answer = answerFrom(lane.provider, run.stdout)
    } else {
      return resultOf(lane.name, 'skipped', [], startedAt, 'the provider is off')
    }

    const read = parse(lane.name, answer, lane.minConfidence)

    // The answer was in no shape the parser recognised, which is still a
    // reviewer that said something. Keeping its words as the lane's note is
    // what makes that recoverable by hand instead of discarded.
    if (!read.isAnswered) {
      recordRun(lane.provider, read.detail)

      return resultOf(
        lane.name,
        'failed',
        [],
        startedAt,
        read.detail,
        '',
        noteOf(answer),
      )
    }

    const floor = lane.severityFloor
    const kept =
      floor === ''
        ? read.findings
        : read.findings.filter(finding => atOrAbove(finding.severity, floor))

    recordRun(lane.provider, '')

    return resultOf(
      lane.name,
      kept.length > 0 ? 'findings' : 'clean',
      kept,
      startedAt,
      '',
    )
  } catch (error) {
    // The timed-out process lands here, which is the failure that cost the
    // most: a cleaner is asked on every compaction and paid the whole timeout.
    const said = messageOf(error)

    recordRun(lane.provider, said)

    return resultOf(lane.name, 'failed', [], startedAt, said)
  }
}

/**
 * The key the refusals are kept under, shared by every session.
 *
 * Not session-scoped on purpose: an account is out of quota for the account,
 * not for one window, so a refusal collected in one session is what tells the
 * next one not to ask.
 */
const LIMITS_KEY = 'limits'

/**
 * Reads the remembered refusals into `limited`.
 *
 * `limited` is memory, and a session that restarts starts it empty, so the
 * panel forgot every refusal at the moment it most needed one: with nothing
 * remembered, nothing is at a limit, and a compaction is requested for a panel
 * that cannot review. Entries past their wait are dropped on the way in.
 *
 * @param $ the mods API
 */
async function loadLimits($: EngineInterface): Promise<void> {
  const held = await $.store.get(LIMITS_KEY).catch(() => undefined)

  if (held === null || typeof held !== 'object') {
    return
  }

  const now = Date.now()
  let stale = false

  for (const [provider, entry] of Object.entries(held as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object') {
      continue
    }

    const said = String((entry as { said?: unknown }).said ?? '')
    const at = Number((entry as { at?: unknown }).at ?? 0)

    if (Number.isFinite(at) && at > 0 && now - at < waitFrom(said)) {
      limited.set(provider, { said, at })
      continue
    }

    stale = true
  }

  // Written back rather than only skipped: a refusal whose wait has passed is
  // read again at every session start otherwise, and sits in the store for
  // days reading like a provider that is still spent.
  if (stale) {
    await saveLimits($)
  }
}

/**
 * Writes the refusals where the next session will read them.
 *
 * @param $ the mods API
 */
async function saveLimits($: EngineInterface): Promise<void> {
  await $.store
    .set(LIMITS_KEY, Object.fromEntries([...limited]))
    .catch(() => undefined)
}

/**
 * Whether each provider's own binary answered its version flag, for this
 * session.
 *
 * A refusal teaches the panel that a provider is spent, but only once one has
 * been collected: a provider that is not installed, not signed in or simply
 * gone never refuses, because nothing ever ran. Without this the panel could
 * not tell "available" from "never asked", so it requested a compaction at
 * every mark with no reviewer behind it.
 *
 * Probed on demand and kept, so a session that never triggers the panel spawns
 * nothing and one that does spawns one short-lived process per provider.
 */
const reachable = new Map<string, boolean>()

/**
 * When the engine last refused to compact for want of quota, and its words.
 *
 * A compaction is run by the account running the session, not by a reviewer,
 * so it has a limit of its own and reaches this as `$.session.compact: Error
 * during compaction: You've hit your session limit · resets 2am`. Nothing
 * about a lane's provider bears on it.
 *
 * Remembered for the same reason a provider's refusal is: it refuses again
 * immediately, and the watcher asks once per turn above the mark, so a spent
 * account produced a refusal per turn for hours.
 */
let compactSpentAt = 0
let compactSaid = ''

/**
 * How long the engine is left alone after it refuses for want of quota.
 *
 * Its words name a reset time and are kept to be shown, not parsed: a clock
 * time in a named zone is the account's schedule, and this is a wait. Long
 * enough that a spent account is asked twice an hour instead of twice a
 * minute, short enough that a window which has reset is picked up without the
 * session being restarted.
 */

/**
 * Whether a provider's command can be run at all.
 *
 * `claude` and `fork` are answered inside the engine and are always reachable.
 * A lane carrying its own command line is probed on that command's own binary,
 * because that is the one a review would spawn.
 *
 * @param $ the mods API
 * @param provider the provider name
 * @returns whether its version flag answered
 */
async function canReach($: EngineInterface, provider: string): Promise<boolean> {
  if (provider === 'claude' || provider === 'fork') {
    return true
  }

  const held = reachable.get(provider)

  if (held !== undefined) {
    return held
  }

  const templated = roster.find(
    lane => lane.provider === provider && lane.command !== '',
  )
  const argv =
    templated !== undefined
      ? [templated.command.trim().split(/\s+/)[0] ?? '', '--version']
      : probeFor(provider)

  if (argv === undefined || argv[0] === undefined || argv[0] === '') {
    reachable.set(provider, false)

    return false
  }

  const run = await $.process
    .run([...argv], { timeoutMs: 15000 })
    .catch(() => undefined)
  const answered = run !== undefined && run.exitCode === 0

  reachable.set(provider, answered)

  return answered
}

/**
 * Whether a provider cannot be asked right now, for either reason.
 *
 * @param $ the mods API
 * @param provider the provider name
 * @returns whether it is spent or unreachable
 */
async function spent($: EngineInterface, provider: string): Promise<boolean> {
  return atLimit(provider) || isFailing(provider) || !(await canReach($, provider))
}

/**
 * Whether a provider is inside the wait that follows its own refusal.
 *
 * Reading it clears an entry that has aged out, so the next lane asks the
 * provider again rather than the panel staying convinced of a limit that has
 * since reset.
 *
 * @param provider the provider name
 * @returns whether it should not be asked right now
 */
function isFailing(provider: string): boolean {
  const entry = failing.get(provider)

  if (entry === undefined || entry.runs < FAILURES_BEFORE_WAIT) {
    return false
  }

  if (Date.now() - entry.at < FAILING_WAIT_MS) {
    return true
  }

  failing.delete(provider)

  return false
}

/**
 * Records that a provider failed outright, or that it answered.
 *
 * The count is what earns the wait, so an answer clears it: a provider that
 * failed twice and then worked is not failing, and carrying its count forward
 * would retire it on its next single stumble.
 *
 * @param provider the provider that ran
 * @param said what it said when it failed, or '' when it answered
 */
function recordRun(provider: string, said: string): void {
  if (said === '') {
    failing.delete(provider)

    return
  }

  const runs = (failing.get(provider)?.runs ?? 0) + 1

  failing.set(provider, { said, at: Date.now(), runs })
}

function waiting(provider: string): boolean {
  return atLimit(provider) || isFailing(provider)
}

/**
 * Whether a lane has no provider left that is out of its wait.
 *
 * @param lane the lane about to run
 * @returns whether both its provider and its fallback are waiting
 */
function waitingOut(lane: Lane): boolean {
  const other = fallbackOf(lane)

  return waiting(lane.provider) && (other === '' || waiting(other))
}

function atLimit(provider: string): boolean {
  const entry = limited.get(provider)

  if (entry === undefined) {
    return false
  }

  if (Date.now() - entry.at < waitFrom(entry.said)) {
    return true
  }

  limited.delete(provider)

  return false
}

/**
 * What a provider said when it refused, for the note on a skipped lane.
 *
 * @param provider the provider name
 * @returns its words, or empty when it has not refused
 */
function limitSaid(provider: string): string {
  return limited.get(provider)?.said ?? ''
}

/**
 * The fallback a lane can actually be retried with, or empty when it has
 * none that differs from its own provider.
 *
 * @param lane the reviewer
 * @returns the fallback provider name
 */
function fallbackOf(lane: Lane): string {
  return lane.fallback === '' ||
    lane.fallback === 'off' ||
    lane.fallback === lane.provider
    ? ''
    : lane.fallback
}

/**
 * Whether neither of a lane's providers can be asked right now.
 *
 * A lane answered by a fork or by a completion is always askable: the
 * subprocess providers are the only ones whose refusals are recorded, so a
 * lane that does not use one is never held back by this.
 *
 * @param lane the reviewer
 * @returns whether asking it would only collect a refusal
 */
function unaskableByLimit(lane: Lane): boolean {
  if (!atLimit(lane.provider)) {
    return false
  }

  const second = fallbackOf(lane)

  return second === '' || atLimit(second)
}

/**
 * Whether neither of a lane's providers can be asked right now, counting a
 * provider that cannot be reached as well as one that is spent.
 *
 * This one may spawn a version probe, so it is used where a probe is cheaper
 * than the alternative — deciding whether to request a compaction — and not on
 * the turn path, where a review that fails is itself the evidence.
 *
 * @param $ the mods API
 * @param lane the reviewer
 * @returns whether asking it would only collect a refusal
 */
async function unaskable($: EngineInterface, lane: Lane): Promise<boolean> {
  if (!(await spent($, lane.provider))) {
    return false
  }

  const second = fallbackOf(lane)

  return second === '' || (await spent($, second))
}

/**
 * Whether every one of these lanes is unaskable.
 *
 * Stops at the first lane that can be asked, so the usual case probes one
 * provider rather than all of them.
 *
 * @param $ the mods API
 * @param lanes the lanes to test
 * @returns whether none of them can be asked
 */
async function allUnaskable(
  $: EngineInterface,
  lanes: readonly Lane[],
): Promise<boolean> {
  for (const lane of lanes) {
    if (!(await unaskable($, lane))) {
      return false
    }
  }

  return true
}

/**
 * Whether no lane on the roster can be asked anything right now.
 *
 * A lane answered by a fork or a completion is never recorded as refusing, so
 * `unaskable` is false for it and a roster holding one is never shut down by
 * this. An empty roster is not shut down either: there is nothing to stand
 * down from.
 *
 * When it is true the panel starts no process and requests no compaction. A
 * review would collect one refusal per lane and report a roster of broken
 * reviewers where there is one exhausted account, and a refinement would
 * spend the compaction that summarises to free what the rules alone cannot:
 * without a reviewer releasing handles, the rules reach about 1% of a window
 * against a 10% floor, so the engine summarises either way. Standing aside
 * leaves the turn's evidence unconsumed for whichever turn runs once a
 * provider is answering again.
 *
 * @returns whether asking anything would only collect a refusal
 */
async function nothingCanRun($: EngineInterface): Promise<boolean> {
  return roster.length > 0 && (await allUnaskable($, roster))
}

/**
 * Whether no lane that reads the transcript can be asked right now.
 *
 * A requested refinement is worth the asking only while a cleaner can answer.
 * `survivorsOf` frees a residue row only when a cleaner released its handle,
 * and measured against a live transcript the rules by themselves free nothing
 * at the sizes a compaction sees — so with every cleaner spent the compaction
 * that follows can only be the engine's summary, which is the one outcome
 * refinement exists to avoid. Asking anyway spends the conversation to no end.
 *
 * Separate from `nothingCanRun` because a reviewer and a cleaner are not
 * interchangeable here: a reachable reviewer says nothing about whether a
 * refinement can release anything, and the whole roster being askable was
 * letting a spent cleaner through.
 *
 * An empty roster is not an answer: the lanes load after the session starts,
 * so `cleaners.length` of zero is read as "not known yet" rather than as
 * nothing to ask, exactly as `nothingCanRun` reads an empty roster.
 *
 * @param $ the engine interface
 * @returns whether every cleaner is unreachable or inside its refusal wait
 */
async function noCleanerCanRun($: EngineInterface): Promise<boolean> {
  const cleaners = roster.filter(lane => lane.sees.includes('transcript'))

  // An empty roster is the strongest case of no cleaner that can be asked,
  // not an exemption from the question. Requiring one to exist first made
  // this answer `false` when none did, and the gate reading it then forced a
  // compaction that could only summarise.
  return cleaners.length === 0 || (await allUnaskable($, cleaners))
}

/**
 * A reviewer's own words at a length a panel row can hold.
 *
 * @param text what the reviewer said
 * @returns the note
 */
function noteOf(text: string): string {
  const body = String(text ?? '').trim()

  return body.length > 1200 ? `${body.slice(0, 1199)}…` : body
}

/**
 * One lane's result, asking its fallback provider when its own fails.
 *
 * Only a failed lane is retried. A lane that answered clean has reviewed the
 * change and found nothing, which is a complete review and not a reason to
 * spend a second provider on it; a lane that found something has already
 * answered. Failure is the case worth retrying because its causes are
 * mundane and temporary — a spent usage limit, an expired sign-in, a binary
 * that is not installed, a timeout — and each of them silences a reviewer
 * without saying so.
 *
 * There is one retry, never a chain: if the fallback fails too, that is
 * reported rather than passed on to a third provider.
 *
 * @param $ the mods API
 * @param config the limits and the floors
 * @param lane the reviewer to run
 * @param schemaPath the answer schema shipped with this plugin
 * @param evidence the change, the documents and the lanes it reads
 * @returns the result, carrying `via` when the fallback is what answered
 */
async function withFallback(
  $: EngineInterface,
  config: Config,
  lane: Lane,
  schemaPath: string,
  evidence: Evidence,
): Promise<LaneResult> {
  const startedAt = Date.now()

  // Read before either process is started. A provider inside a wait refuses
  // again in the same second, so a lane whose own provider and whose fallback
  // are both waiting is skipped rather than spawned twice to be told so: a
  // provider that cannot run at all was otherwise spawned on every review for
  // as long as it stayed broken.
  //
  // The wait alone decides it, not `unaskable`: that also counts a provider
  // its version probe could not reach, and an unreachable provider is the
  // case the fallback exists to answer.
  if (waitingOut(lane)) {
    const other = fallbackOf(lane)

    return resultOf(
      lane.name,
      'skipped',
      [],
      startedAt,
      other === ''
        ? `${lane.provider} cannot be asked right now`
        : `${lane.provider} and ${other} cannot be asked right now`,
      '',
      [limitSaid(lane.provider), limitSaid(other)]
        .filter(said => said !== '')
        .join(' · '),
    )
  }

  const first = await runLane($, config, lane, schemaPath, evidence)
  const other = fallbackOf(lane)

  // A lane turned away for quota is retried like a failure, because its
  // fallback is a different account and may well answer.
  const isDeclined = first.outcome === 'skipped' && isAtLimit(first.detail)

  if ((first.outcome !== 'failed' && !isDeclined) || other === '') {
    return first
  }

  // Both accounts are spent, so there is no second provider to spend either.
  if (atLimit(other)) {
    return resultOf(
      lane.name,
      'skipped',
      [],
      startedAt,
      `${lane.provider} and ${other} are both at their usage limit`,
      '',
      [limitSaid(lane.provider), limitSaid(other)]
        .filter(said => said !== '')
        .join(' · '),
    )
  }

  const second = await runLane(
    $,
    config,
    {
      ...lane,
      provider: other,
      command: lane.fallbackCommand,
      model: '',
    },
    schemaPath,
    evidence,
  )

  // Neither could be asked. That is a reviewer nobody ran, not a reviewer
  // that ran and approved, and not one that broke.
  if (isDeclined && second.outcome === 'skipped' && isAtLimit(second.detail)) {
    return resultOf(
      lane.name,
      'skipped',
      [],
      startedAt,
      `${lane.provider} and ${other} are both at their usage limit`,
      '',
      [first.notes, second.notes].filter(note => note !== '').join(' · '),
    )
  }

  if (second.outcome === 'failed' || second.outcome === 'skipped') {
    return resultOf(
      lane.name,
      second.outcome,
      [],
      startedAt,
      `${lane.provider}: ${first.detail} · ${other}: ${second.detail}`,
      '',
      [first.notes, second.notes].filter(note => note !== '').join(' · '),
    )
  }

  return { ...second, via: other }
}

/**
 * The lanes as they finally resolve, from all four tiers: the configured
 * ones, the machine-wide files, this repository's files, and the ones added
 * by `/backseat lane` this session. A name in more than one tier is kept
 * once, by the most specific that defines it.
 *
 * A lane file is itself the declaration that a lane should run, so a
 * file-defined lane is reviewed whether or not the `lanes` option names it;
 * `enabled: false` in the file is how one is parked. `/backseat setup`
 * prints the roster this produced, which is the only reliable answer to what
 * is actually on.
 *
 * @param $ the mods API
 * @param config the configured lanes and both lane directories
 * @returns the lanes to run, what was wrong with the directories, and where
 *   those directories are
 */
async function loadLanes(
  $: EngineInterface,
  config: Config,
): Promise<{ lanes: Lane[]; problems: string[]; dirs: LaneDirReport[] }> {
  const problems: string[] = []
  const dirs: LaneDirReport[] = []
  const tiers: {
    scope: LaneScope
    lanes: Lane[]
    parked: string[]
  }[] = [{ scope: 'config', lanes: [...config.lanes], parked: [] }]

  const home = await homeDir($)
  const cwd = await $.session.cwd().catch(() => '')
  const wanted: { scope: LaneScope; path: string }[] = [
    { scope: 'user', path: userLaneDir(config, home) },
  ]

  // Outermost first, so a lane nearer the work replaces one written for the
  // whole tree. A tree of repositories keeps its shared reviewers beside the
  // tree rather than copied into every repository in it.
  for (const path of laneDirsFor(
    typeof cwd === 'string' ? cwd : '',
    home,
    config.laneDir,
  )) {
    wanted.push({ scope: 'project', path })
  }

  for (const tier of wanted) {
    const read = await readLaneDir($, config, tier.path, tier.scope)

    tiers.push({
      scope: tier.scope,
      lanes: read.lanes,
      parked: read.parked,
    })
    dirs.push({
      scope: tier.scope,
      path: tier.path,
      found: read.lanes.length,
      isPresent: read.isPresent,
    })

    for (const problem of read.problems) {
      problems.push(problem)
    }
  }

  tiers.push({
    scope: 'session',
    parked: [],
    lanes: [...sessionLanes.entries()].map(([name, held]) =>
      sessionLaneOf(name, held.question, held.onAgents, {
        provider: config.lanes[0]?.provider ?? 'claude',
        confidence: config.minConfidence,
        fallback: config.fallback,
      }),
    ),
  })

  const merged = mergeLanes(tiers)
  const byName = new Map<string, Lane>()

  // A lane naming several reviewers becomes one lane per reviewer, so the
  // whole run path — waves, concurrency, parsing, the cross-lane merge —
  // treats them as what they are: separate reviewers of one question, whose
  // agreement the merge can then report.
  for (const lane of merged.lanes) {
    const reviewers = [
      ...new Set(
        lane.reviewers.filter(name => name !== '' && name !== 'off'),
      ),
    ]

    if (reviewers.length < 2) {
      byName.set(lane.name, {
        ...lane,
        provider: reviewers[0] ?? lane.provider,
        reviewers: [],
      })
      continue
    }

    for (const provider of reviewers) {
      const name = `${lane.name}:${provider}`

      byName.set(name, {
        ...lane,
        name,
        group: lane.group,
        provider,
        command: '',
        reviewers: [],
      })
    }
  }

  for (const note of merged.notes) {
    problems.push(note)
  }

  // A provider with no shipped adapter is served by a `providers` template,
  // which is what keeps adding one a template rather than a code change. A
  // lane naming neither is dropped rather than left looking enabled.
  const named = templatesFrom(config.providers)

  for (const problem of named.problems) {
    problems.push(problem)
  }

  for (const lane of [...byName.values()]) {
    let resolved = lane

    // A fallback is resolved the same way the provider is, and a fallback
    // nobody can run is dropped rather than left looking like cover: a lane
    // that reports a failure is honest, one that silently has no second
    // provider while naming one is not.
    if (lane.fallback !== '' && lane.fallback !== 'off') {
      if (lane.fallback === lane.provider) {
        problems.push(
          `${lane.name}: fallback "${lane.fallback}" is its own provider, so there is nothing to fall back to`,
        )
        resolved = { ...resolved, fallback: '' }
      } else if (!PROVIDERS.includes(lane.fallback)) {
        const second = named.templates.get(lane.fallback)

        if (second === undefined) {
          problems.push(
            `${lane.name}: fallback "${lane.fallback}" has no adapter and no providers template`,
          )
          resolved = { ...resolved, fallback: '' }
        } else {
          resolved = { ...resolved, fallbackCommand: second }
        }
      }
    }

    if (resolved.command !== '' || PROVIDERS.includes(resolved.provider)) {
      byName.set(resolved.name, resolved)
      continue
    }

    const template = named.templates.get(resolved.provider)

    if (template === undefined) {
      problems.push(
        `${resolved.name}: provider "${resolved.provider}" has no adapter and no providers template`,
      )
      byName.delete(resolved.name)
      continue
    }

    byName.set(resolved.name, { ...resolved, command: template })
  }

  return { lanes: [...byName.values()], problems, dirs }
}

/**
 * Re-reads every tier into the roster.
 *
 * Called after a command changes what the roster should be, so the next
 * review and the next report both see the change without a reload.
 *
 * @param $ the mods API
 * @param config the configured lanes and both lane directories
 */
async function reload($: EngineInterface, config: Config): Promise<void> {
  const loaded = await loadLanes($, config)

  roster = loaded.lanes
  laneProblems = loaded.problems
  laneDirs = loaded.dirs
}

/**
 * The lanes in one directory, and whether the directory is there at all.
 *
 * A missing directory is not a problem to report: the machine-wide one does
 * not exist until someone writes a lane into it, and saying so every session
 * would train people to ignore the report. An unreadable *file* is reported,
 * because someone meant that one to be a reviewer.
 *
 * @param $ the mods API
 * @param config read for the fallback provider and confidence floor
 * @param dir the directory to read, which may not exist
 * @param scope the tier this directory serves
 * @returns its lanes, the names it parks, its complaints, and whether it is
 *   there
 */
async function readLaneDir(
  $: EngineInterface,
  config: Config,
  dir: string,
  scope: LaneScope,
): Promise<{
  lanes: Lane[]
  parked: string[]
  problems: string[]
  isPresent: boolean
}> {
  const lanes: Lane[] = []
  const parked: string[] = []
  const problems: string[] = []

  if (dir === '') {
    return { lanes, parked, problems, isPresent: false }
  }

  const entries = await $.fs.list(dir).catch(() => undefined)

  if (entries === undefined) {
    return { lanes, parked, problems, isPresent: false }
  }

  for (const entry of entries) {
    if (entry.kind !== 'file' || !isLaneFile(entry.name)) {
      continue
    }

    const text = await $.fs.read(`${dir}/${entry.name}`).catch(() => '')

    if (typeof text !== 'string' || text.trim() === '') {
      problems.push(`${entry.name}: could not be read`)
      continue
    }

    const read = laneFrom(nameOf(entry.name), text, {
      provider: config.lanes[0]?.provider ?? 'claude',
      confidence: config.minConfidence,
      scope,
      fallback: config.fallback,
    })

    for (const problem of read.problems) {
      problems.push(problem)
    }

    if (read.lane !== undefined) {
      // A lane's documents belong to the tree the lane was written for, which
      // is the directory holding its lane directory — not the session's.
      const root = laneRootOf(dir, config.laneDir)

      lanes.push({
        ...read.lane,
        docs: read.lane.docs.map(doc =>
          doc.startsWith('/') ? doc : `${root}/${doc}`,
        ),
      })
    }

    if (read.parked !== '') {
      parked.push(read.parked)
    }
  }

  return { lanes, parked, problems, isPresent: true }
}

/**
 * Where the machine-wide lanes live: the configured path, or the default
 * beside the user's other Claude configuration.
 *
 * The default cannot be a manifest default because the manifest cannot spell
 * a home directory, and `$.fs` takes `~` as a literal name rather than
 * resolving it. A machine with no HOME simply has no machine-wide tier.
 *
 * @param $ the mods API
 * @param config read for an explicit `userLaneDir`
 * @returns the directory, empty when there is none
 */
function userLaneDir(config: Config, home: string): string {
  if (config.userLaneDir !== '') {
    return config.userLaneDir
  }

  return home === '' ? '' : `${home}/.claude/backseat/lanes`
}

/**
 * The person's home directory, which bounds the walk for lane directories
 * and gives the machine-wide tier its default place.
 *
 * @param $ the mods API
 * @returns the directory, empty when the environment names none
 */
async function homeDir($: EngineInterface): Promise<string> {
  const home = await $.env.get('HOME').catch(() => undefined)

  return typeof home === 'string' ? home : ''
}

/**
 * The model a lane asks: its own override, the panel-wide one, then the
 * lane's own field.
 *
 * `/backseat model` writes the overrides and this is the only place they are
 * read, so the roster a person is shown and the model a lane actually asks
 * can never disagree.
 *
 * @param lane the lane about to run
 * @returns the model to ask for, empty for the provider's own default
 */
function modelFor(lane: Lane): string {
  return models.get(lane.name) ?? models.get('*') ?? lane.model
}

/**
 * The roster as the reports print it, with every override already applied.
 *
 * @returns one row per lane, grouped into the waves they run in
 */
function laneRows(): LaneRow[][] {
  return wavesOf(roster, true).map(wave =>
    wave.map(lane => ({
      name: lane.name,
      provider: lane.command !== '' ? `${lane.provider} (command)` : lane.provider,
      model: modelFor(lane),
      needs: lane.needs,
      docs: lane.docs,
      instructions: lane.instructions !== '',
      minConfidence: lane.minConfidence,
      severityFloor: lane.severityFloor,
      scope: lane.scope,
      onAgents: lane.onAgents,
      fallback: lane.fallback,
      sees: lane.sees,
      on: lane.on,
    })),
  )
}

/**
 * Reads the purpose, the model overrides and the session lanes this session
 * saved.
 *
 * Read before the roster is built, because the session lanes are one of the
 * tiers the roster is built from.
 *
 * @param $ the mods API
 * @param key this session's own state key
 */
async function loadState($: EngineInterface, key: string): Promise<void> {
  const raw = await $.store.get(key).catch(() => undefined)

  if (typeof raw !== 'object' || raw === null) {
    return
  }

  const held = raw as {
    purpose?: unknown
    drops?: unknown
    models?: unknown
    sessionLanes?: unknown
  }

  if (Array.isArray(held.drops)) {
    drops = held.drops.filter(one => typeof one === 'string' && one !== '')
  }

  if (typeof held.purpose === 'string') {
    purpose = held.purpose
  }

  if (typeof held.models === 'object' && held.models !== null) {
    for (const [name, model] of Object.entries(held.models)) {
      if (typeof model === 'string' && model !== '') {
        models.set(name, model)
      }
    }
  }

  if (typeof held.sessionLanes === 'object' && held.sessionLanes !== null) {
    for (const [name, value] of Object.entries(held.sessionLanes)) {
      if (typeof value !== 'object' || value === null) {
        continue
      }

      const lane = value as { question?: unknown; onAgents?: unknown }

      if (typeof lane.question === 'string' && lane.question !== '') {
        sessionLanes.set(name, {
          question: lane.question,
          onAgents: lane.onAgents === true,
        })
      }
    }
  }
}

/**
 * Saves the purpose, the model overrides and the session lanes under this
 * session's key.
 *
 * @param $ the mods API
 * @param key this session's own state key
 */
async function saveState($: EngineInterface, key: string): Promise<void> {
  await $.store
    .set(key, {
      purpose,
      drops,
      models: Object.fromEntries(models),
      sessionLanes: Object.fromEntries(sessionLanes),
    })
    .catch(() => undefined)
}

/**
 * What `/backseat setup` reports: whether each provider a lane names can be
 * reached, and the roster, run order and documents as they resolved.
 *
 * The lane directory is read again here rather than trusted from
 * `session.start`, so that a lane file written during the session is
 * reflected without a reload.
 *
 * @param $ the mods API
 * @param config the lanes, both lane directories and the shared documents
 * @returns the command's text
 */
async function setup($: EngineInterface, config: Config): Promise<string> {
  const loaded = await loadLanes($, config)

  roster = loaded.lanes
  laneProblems = loaded.problems
  laneDirs = loaded.dirs

  const probes: Probe[] = []

  for (const provider of [...new Set(roster.map(lane => lane.provider))]) {
    if (provider === 'claude' || provider === 'fork') {
      probes.push({
        provider,
        isReady: true,
        detail:
          provider === 'fork'
            ? 'a fork of this conversation; nothing to install'
            : `$.model.complete, model ${config.claudeModel}; nothing to install`,
      })
      continue
    }

    const templated = roster.find(
      lane => lane.provider === provider && lane.command !== '',
    )
    const argv =
      templated !== undefined
        ? [templated.command.trim().split(/\s+/)[0] ?? '', '--version']
        : probeFor(provider)

    if (argv === undefined || argv[0] === '') {
      probes.push({ provider, isReady: false, detail: 'no adapter and no template' })
      continue
    }

    const run = await $.process
      .run(argv, { timeoutMs: 15000 })
      .catch(() => undefined)

    if (run === undefined || run.exitCode !== 0) {
      probes.push({
        provider,
        isReady: false,
        detail:
          run === undefined
            ? `${argv[0]} could not be run — not installed, or not on PATH`
            : `${argv.join(' ')} exited ${run.exitCode}: ${reasonOf(run.stderr, run.stdout)}`,
      })
      continue
    }

    probes.push({ provider, isReady: true, detail: firstLine(run.stdout) })
  }

  const wanted = [...config.specDocs, ...config.designDocs]
  const docs = await readDocs($, wanted)
  const found = docs.docs.map(doc => doc.path)

  return setupReport(
    probes,
    laneRows(),
    laneDirs,
    { found, missing: wanted.filter(path => !found.includes(path)) },
    laneProblems,
    purpose,
  )
}

/**
 * The files that differ from a ref, for a review nobody's turn triggered.
 *
 * `git diff --name-only` against the ref covers tracked changes, and
 * `ls-files --others` the files the repository has never seen, so a review
 * asked for by hand sees what a turn-triggered one would.
 *
 * @param $ the mods API
 * @param base the ref to compare against, empty for `HEAD`
 * @returns the changed paths, empty when nothing differs
 */
async function changedPaths(
  $: EngineInterface,
  base: string,
): Promise<{ paths: string[]; isRepo: boolean }> {
  const ref = base !== '' ? base : 'HEAD'
  const out: string[] = []

  const inside = await $.process
    .run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: 15000 })
    .catch(() => undefined)

  if (inside === undefined || inside.exitCode !== 0) {
    return { paths: [], isRepo: false }
  }

  const tracked = await $.process
    .run(['git', 'diff', '--name-only', ref], { timeoutMs: 30000 })
    .catch(() => undefined)

  if (tracked !== undefined && tracked.exitCode === 0) {
    for (const path of tracked.stdout.split(/\r?\n/)) {
      out.push(path.trim())
    }
  }

  const untracked = await $.process
    .run(['git', 'ls-files', '--others', '--exclude-standard'], {
      timeoutMs: 30000,
    })
    .catch(() => undefined)

  if (untracked !== undefined && untracked.exitCode === 0) {
    for (const path of untracked.stdout.split(/\r?\n/)) {
      out.push(path.trim())
    }
  }

  return { paths: distinctPaths(out), isRepo: true }
}

/**
 * The diff of the files under review, cut to what a lane is given.
 *
 * Tracked changes come from `git diff` against the ref; a file the
 * repository has never seen is read and its hunk written by `newFileDiff`.
 * Nothing here writes to the index: that is the person's staging area, and a
 * reviewer that changed it would have edited the work it was asked to judge.
 * Paths go after `--`, as argv, no shell.
 *
 * A repository that cannot answer yields an empty diff, which is why the
 * prompt says the file list is complete and the diff may not be.
 *
 * @param $ the mods API
 * @param paths the files to diff
 * @param base the ref to diff against, empty for `HEAD`
 * @returns the diff a lane is given, and whether it was cut
 */
async function collectDiff(
  $: EngineInterface,
  paths: readonly string[],
  base: string,
  refs: ReadonlyMap<string, string> = new Map(),
): Promise<{ text: string; isTruncated: boolean; outside: string[] }> {
  const parts: string[] = []
  const outside: string[] = []
  const cwd = await $.session.cwd().catch(() => '')
  const here = typeof cwd === 'string' ? cwd : ''
  const absolutes = paths.map(path => absolute(here, path))

  const grouped = byRepo(await repoRoots($, absolutes), absolutes)
  const covered = new Set<string>()

  for (const [root, inside] of grouped) {
    for (const path of inside) {
      covered.add(path)
    }

    // The commit this repository was on when the turn started writing, so
    // work the turn committed itself is still part of the change under
    // review. An explicit base wins, and HEAD is the fallback.
    const ref = base !== '' ? base : (refs.get(root) ?? 'HEAD')

    const tracked = await $.process
      .run(['git', '-C', root, 'diff', ref, '--unified=3', '--', ...inside], {
        timeoutMs: 30000,
      })
      .catch(() => undefined)

    if (
      tracked !== undefined &&
      tracked.exitCode === 0 &&
      tracked.stdout.trim() !== ''
    ) {
      parts.push(tracked.stdout)
    }

    const untracked = await $.process
      .run(
        [
          'git',
          '-C',
          root,
          'ls-files',
          '--others',
          '--exclude-standard',
          '--',
          ...inside,
        ],
        { timeoutMs: 30000 },
      )
      .catch(() => undefined)

    if (untracked === undefined || untracked.exitCode !== 0) {
      continue
    }

    for (const path of untracked.stdout.split(/\r?\n/)) {
      const name = path.trim()

      if (name === '') {
        continue
      }

      const text = await $.fs.read(`${root}/${name}`).catch(() => '')

      if (typeof text === 'string' && text !== '') {
        parts.push(newFileDiff(name, text))
      }
    }
  }

  // A path no repository holds is diffed against the before-image that
  // `tool.call` took. This is the only base such a path has: `git diff`
  // groups by repository root, so without this a turn that worked in a tree
  // outside version control yields an empty diff and the review is abandoned
  // before a lane is asked.
  for (const path of absolutes) {
    if (covered.has(path)) {
      continue
    }

    const was = beforeText.get(path)

    beforeText.delete(path)

    // A file too long to hold a before-image of is left out rather than
    // shown as wholly new: `fitDiff` would cut it anyway, and a diff that
    // claims every line is added reads as a file nobody wrote before.
    if (was === undefined || !was.isWhole) {
      continue
    }

    const now = await $.fs.read(path).catch(() => undefined)
    const name = path.startsWith(`${here}/`)
      ? path.slice(here.length + 1)
      : path
    const one = unifiedDiff(name, was.text, typeof now === 'string' ? now : '')

    if (one !== '') {
      parts.push(one)
      outside.push(name)
    }
  }

  return { ...fitDiff(parts.join('\n')), outside }
}

/**
 * How much of the turn's own activity a lane is shown.
 *
 * `activityOf` stops at these, because the activity is context for the diff
 * and not the evidence itself: a turn of two hundred commands would otherwise
 * crowd out the change the lane was asked to judge.
 */
const ACTIVITY_LINES = 40
const ACTIVITY_WIDTH = 300

/**
 * The commands the turn ran, oldest first.
 *
 * `review` hands these to every lane as `Evidence.activity`. They come from
 * the session's own messages rather than from the `tool.call` hook, so a lane
 * sees what the turn did even where no file changed: a command that moves
 * data or reaches outside the tree leaves no diff, and judging it needs the
 * command itself.
 *
 * Only the messages after the turn's last request are read, because the
 * activity being judged is this turn's and the session holds many.
 *
 * @param $ the mods API
 * @param loop the agent whose messages to read, empty for the main loop
 * @returns the commands, each cut to `ACTIVITY_WIDTH`
 */
async function activityOf(
  $: EngineInterface,
  loop: string,
): Promise<string[]> {
  const found = await (loop === ''
    ? $.session.messages()
    : $.session.messages({ agentId: loop })
  ).catch(() => undefined)

  if (found === undefined || 'deny' in found) {
    return []
  }

  const messages: readonly SessionMessage[] = found
  // The turn is what follows the newest request: a lane judging this turn's
  // work is not helped by the commands of the one before it.
  //
  // A tool's result is carried by a message in the person's own role, so the
  // newest message in that role is usually the answer to the turn's last
  // call. Taking it as the boundary left every command behind it and the
  // section was dropped as empty; the request is the one carrying no results.
  let from = 0

  for (const [at, message] of messages.entries()) {
    if (message.role === 'user' && (message.toolResults ?? []).length === 0) {
      from = at
    }
  }

  const out: string[] = []

  for (const message of messages.slice(from)) {
    for (const use of message.toolUses ?? []) {
      if (use.tool !== 'Bash') {
        continue
      }

      const input = (use.input ?? {}) as Readonly<Record<string, unknown>>
      const command =
        typeof input.command === 'string' ? input.command.trim() : ''

      if (command === '') {
        continue
      }

      const one = command.replace(/\s+/g, ' ')

      out.push(
        one.length > ACTIVITY_WIDTH
          ? `$ ${one.slice(0, ACTIVITY_WIDTH)}…`
          : `$ ${one}`,
      )
    }
  }

  return out.slice(-ACTIVITY_LINES)
}

/**
 * The paths and directories one call is watched on.
 *
 * An edit tool names its file, so that file is watched. A shell command is
 * read for the paths it names (`writeTargetsOf`) and watched on the
 * directories around them as well, because a command that builds its own
 * filename never spells it: the listing is what sees that write.
 *
 * Any other tool is watched on nothing. Reading and searching change no file,
 * and watching them would pay the cost of a stat on every call of a turn.
 *
 * @param tool the call's tool name
 * @param input the call, as plain data, for the tool's own arguments
 * @param cwd the session's working directory, for resolving a relative name
 * @returns the absolute files to stat and directories to list
 */
function watchedOf(
  tool: string,
  input: Readonly<Record<string, unknown>>,
  cwd: string,
): { files: string[]; dirs: string[] } {
  if (isEditTool(tool)) {
    const path = pathOf(input)

    return path === ''
      ? { files: [], dirs: [] }
      : { files: [absolute(cwd, path)], dirs: [] }
  }

  if (tool !== 'Bash') {
    return { files: [], dirs: [] }
  }

  const command = typeof input.command === 'string' ? input.command : ''
  const named = writeTargetsOf(command).map(path => absolute(cwd, path))
  const files = [...new Set(named)].slice(0, WATCH_FILES)
  // The directory a command runs in, and any it changes into, are where a
  // path it computes for itself lands.
  const entered = [...command.matchAll(/\bcd\s+([^\s|;&]+)/g)].map(found =>
    absolute(cwd, (found[1] ?? '').replace(/^["']|["']$/g, '')),
  )
  const around = [...files.map(path => dirOf(path)), cwd, ...entered]

  return { files, dirs: [...new Set(around)].slice(0, WATCH_DIRS) }
}

/**
 * The before-image of each watched path.
 *
 * `tool.call` takes this before the call runs, because the content a diff
 * needs is gone once the call has written. A path over `SNAPSHOT_LIMIT` is
 * recorded without a body: it is still reported as changed, and the lane is
 * told the body was not held rather than shown a part of it as the whole.
 *
 * @param $ the mods API
 * @param paths the absolute paths to hold
 * @returns the before-images, by path
 */
async function snapshotAll(
  $: EngineInterface,
  paths: readonly string[],
): Promise<Map<string, Snapshot>> {
  const out = new Map<string, Snapshot>()

  for (const path of paths) {
    const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)

    if (stat === undefined) {
      out.set(path, {
        exists: false,
        size: 0,
        mtimeMs: 0,
        text: '',
        isWhole: true,
      })

      continue
    }

    const size = typeof stat.size === 'number' ? stat.size : 0
    const mtimeMs = typeof stat.mtimeMs === 'number' ? stat.mtimeMs : 0
    const held =
      size <= SNAPSHOT_LIMIT
        ? await $.fs.read(path).catch(() => undefined)
        : undefined

    out.set(path, {
      exists: true,
      size,
      mtimeMs,
      text: typeof held === 'string' ? held : '',
      isWhole: typeof held === 'string',
    })
  }

  return out
}

/**
 * The state each watched path is in now.
 *
 * `tool.call` takes this after the call and hands both halves to
 * `changedPaths`, which is what decides the call wrote.
 *
 * @param $ the mods API
 * @param paths the absolute paths to stat
 * @returns the state, by path
 */
async function statAll(
  $: EngineInterface,
  paths: readonly string[],
): Promise<Map<string, { exists: boolean; size: number; mtimeMs: number }>> {
  const out = new Map<
    string,
    { exists: boolean; size: number; mtimeMs: number }
  >()

  for (const path of paths) {
    const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)

    out.set(path, {
      exists: stat !== undefined,
      size: typeof stat?.size === 'number' ? stat.size : 0,
      mtimeMs: typeof stat?.mtimeMs === 'number' ? stat.mtimeMs : 0,
    })
  }

  return out
}

/**
 * The names each watched directory holds, one level deep.
 *
 * `appearedIn` compares two of these to find a file whose path the command
 * never named. The listing is one level because the directories under a
 * session's tree can hold a million files, and a walk of them would cost
 * more on every call than the review it feeds.
 *
 * @param $ the mods API
 * @param dirs the absolute directories to list
 * @returns the entry names, by directory
 */
async function listAll(
  $: EngineInterface,
  dirs: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()

  for (const dir of dirs) {
    const entries = await $.fs.list(dir).catch(() => undefined)

    if (entries !== undefined) {
      out.set(
        dir,
        entries
          .filter(entry => entry.kind === 'file')
          .map(entry => entry.name),
      )
    }
  }

  return out
}

/**
 * Records the commit a repository is on, the first time a turn writes into it.
 *
 * One git call answers both the root and the commit, and it runs only when
 * this loop has not already asked about this directory, so a turn that edits
 * twenty files in one repository pays for it once. A directory in no
 * repository is remembered as such, so it is not asked about again.
 *
 * @param $ the mods API
 * @param loop the `agentId` of the loop that wrote, empty for the main loop
 * @param path the absolute path that was written
 */
async function remember(
  $: EngineInterface,
  loop: string,
  path: string,
): Promise<void> {
  const dir = dirOf(path)
  const key = `${loop}\u0000${dir}`

  if (baselines.has(key)) {
    return
  }

  baselines.set(key, { root: '', sha: '' })

  const found = await $.process
    .run(['git', '-C', dir, 'rev-parse', '--show-toplevel', 'HEAD'], {
      timeoutMs: 15000,
    })
    .catch(() => undefined)

  if (found === undefined || found.exitCode !== 0) {
    return
  }

  const lines = found.stdout.trim().split(/\r?\n/)
  const root = (lines[0] ?? '').trim()
  const sha = (lines[1] ?? '').trim()

  if (root !== '' && sha !== '') {
    baselines.set(key, { root, sha })
  }
}

/**
 * The commit to diff each repository against, for one loop's turn.
 *
 * @param loop the `agentId` of the loop whose turn ended, empty for the main
 * @returns each repository root mapped to the commit it was on
 */
function refsFor(loop: string): Map<string, string> {
  const refs = new Map<string, string>()

  for (const [key, held] of baselines) {
    if (key.startsWith(`${loop}\u0000`) && held.root !== '' && held.sha !== '') {
      refs.set(held.root, held.sha)
    }
  }

  return refs
}

/**
 * Each changed file's directory mapped to the repository that holds it.
 *
 * One question per directory, not per file: a change usually touches a few
 * directories and `rev-parse` is a process each time. A directory git reports
 * no repository for is left out, so a file outside every repository
 * contributes no evidence rather than a diff of the wrong tree.
 *
 * @param $ the mods API
 * @param paths the absolute paths that changed
 * @returns the directory-to-root map `byRepo` reads
 */
async function repoRoots(
  $: EngineInterface,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const roots = new Map<string, string>()

  for (const dir of [...new Set(paths.map(path => dirOf(path)))]) {
    const found = await $.process
      .run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], {
        timeoutMs: 15000,
      })
      .catch(() => undefined)

    if (found !== undefined && found.exitCode === 0) {
      // The first line only: git is asked for one thing here, but a root read
      // from a multi-line answer would be a path that names no directory, and
      // every diff taken in it would fail silently.
      roots.set(dir, (found.stdout.trim().split(/\r?\n/)[0] ?? '').trim())
    }
  }

  return roots
}

/**
 * The documents at the given paths that could be read.
 *
 * A configured path that does not exist is skipped, because a repository is
 * entitled to have no design directory. The empty case is not skipped: the
 * prompt names it, so a reviewer knows it is judging without a document
 * rather than against one it failed to find.
 *
 * @param $ the mods API
 * @param paths the document paths to read, in the order they were configured
 * @returns the documents that could be read
 */
async function readDocs(
  $: EngineInterface,
  paths: readonly string[],
): Promise<{ docs: { path: string; text: string }[] }> {
  const docs: { path: string; text: string }[] = []

  for (const path of paths) {
    const isThere = await $.fs.exists(path).catch(() => false)

    if (!isThere) {
      continue
    }

    const text = await $.fs.read(path).catch(() => '')

    if (typeof text === 'string' && text.trim() !== '') {
      docs.push({ path, text })
    }
  }

  return { docs }
}

/**
 * The card for one finding, with the three things a press can do: fix
 * submits it into the conversation as the person's own instruction, explain
 * forks for a plain-language reading and redraws when it lands, and dismiss
 * drops it and remembers its subject so the same reviewer cannot raise it
 * again this session.
 *
 * @param $ the mods API, as the `ui.render` hook holds it
 * @param config the severity floor a blocking card is marked by
 * @param finding the finding to draw
 * @returns the card the panel draws
 */
function cardFor(
  $: EngineInterface,
  config: Config,
  finding: Finding,
): Card {
  const subject = subjectOf(finding)

  return {
    finding,
    explanation: explained.get(subject) ?? '',
    isExplaining: explaining.has(subject),
    isBlocking: isBlocking(config, finding.severity),
    onFix: () => {
      submitFix($, finding)
    },
    onExplain: () => {
      if (explaining.has(subject) || explained.has(subject)) {
        return
      }

      explaining.add(subject)
      $.ui.invalidate('ui.render')

      void $.model
        .fork({ prompt: explainPrompt(finding) })
        .then(reply => {
          explained.set(
            subject,
            reply !== null && reply.isAnswered
              ? reply.text.trim()
              : 'no explanation came back',
          )
        })
        .catch(() => {
          explained.set(subject, 'no explanation came back')
        })
        .finally(() => {
          explaining.delete(subject)
          $.ui.invalidate('ui.render')
        })
    },
    onDismiss: () => {
      drop(subject)
      $.ui.invalidate('ui.render')
    },
  }
}

/**
 * A list of subjects the store holds under one key.
 *
 * Serves both the ranked-once record and the handed-over record, which are
 * separate keys with the same shape.
 *
 * @param $ the mods API
 * @param key this session's own store key
 * @returns the subjects, empty when the key holds none
 */
async function storedSubjects(
  $: EngineInterface,
  key: string,
): Promise<string[]> {
  const raw = await $.store.get(key).catch(() => undefined)

  return Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string')
    : []
}

/**
 * Drops a finding from the panel and remembers it was answered.
 *
 * @param subject the finding's subject, from `subjectOf`
 */
/**
 * Hands one finding to the model as the person's own instruction.
 *
 * Shared by the card's fix action and the `autofix` option, so a finding sent
 * by either is dropped from the panel and recorded against its subject once:
 * the same instruction submitted twice is two turns spent on one finding, and
 * a card left standing after its fix was sent invites exactly that.
 *
 * @param $ the mods API
 * @param finding the finding to hand over
 * @returns whether it was sent, false when its subject was already sent
 */
function submitFix($: EngineInterface, finding: Finding): boolean {
  const subject = subjectOf(finding)

  if (fixedAlready.has(subject)) {
    return false
  }

  fixedAlready.add(subject)
  drop(subject)
  void $.prompt
    .submit({ text: fixPrompt(finding), asUser: true })
    .catch(() => undefined)

  return true
}

function drop(subject: string): void {
  findings = findings.filter(finding => subjectOf(finding) !== subject)
  seen.add(subject)
}
