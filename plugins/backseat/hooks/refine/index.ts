/**
 * Deciding what in a transcript still earns its place, and what a reviewer
 * never needs to be asked about.
 *
 * Everything here is a pure function over the messages `cleaner` produced, so
 * the rules can be tested without a session, a provider or a quota. The point
 * of the module is economy: a provider call costs minutes, and most of a
 * transcript can be judged by rules that cost nothing. What the rules cannot
 * settle is the residue, and only the residue is worth asking about.
 *
 * The survival rule is the one the local engine uses: a candidate is judged
 * twice, once on what it says and once against what the session is doing now,
 * and it is only let go when both judgements agree. A single framing is never
 * enough, because a call that merely looks finished and a call the work has
 * moved past are the same thing seen from one side.
 */

import type { Entry } from '../cleaner'

/**
 * What a message is worth keeping for, and therefore what may be done to it.
 *
 * `never` is material a session returns to: the words of the person whose
 * session it is, an error nothing has resolved, a measurement. `reached` is
 * material the current work still points at. `repeat` and `superseded` are
 * what the rules settled without asking anyone. `residue` is what the rules
 * could not settle, which is the only tier a provider is spent on.
 */
export type Tier = 'never' | 'reached' | 'repeat' | 'superseded' | 'residue'

/** One message's verdict, and the evidence the rule rested on. */
export type Verdict = {
  index: number
  tier: Tier
  because: string
  /** The message that supersedes or first carried this one, where there is one. */
  from: number
}

import {
  ASK_ABOVE,
  MARKER_SCAN,
  reachedBy,
  repeatedCalls,
  settledBy,
  settlingMarkers,
} from './signals'

export { callPrint, namesIn, reachedBy, repeatedCalls } from './signals'
export { KEPT_HEAD, KEPT_TAIL, printOf, rehydrationFor, shortened } from './reclaim'
export type { Rehydration } from './reclaim'


/**
 * Every message's tier, settled by rules alone.
 *
 * The order is the order of certainty. What a session returns to is never
 * reclaimable whatever else is true of it, so that is decided first; then what
 * the current work reaches; then what the rules can show is a repeat. What is
 * left is the residue, and it is the only tier worth spending a provider on.
 *
 * @param entries the transcript's messages, in order
 * @param anchor how many of the newest messages count as the current work
 * @returns one verdict per message, in transcript order
 */
export function tiersOf(
  entries: readonly Entry[],
  anchor: number,
): readonly Verdict[] {
  const reached = reachedBy(entries, anchor)
  const repeats = repeatedCalls(entries)
  const newest = new Set(entries.slice(-Math.max(1, anchor)).map(one => one.index))
  const settling = settlingMarkers(entries)

  return entries.map(entry => {
    const at = entry.index

    if (newest.has(at)) {
      return { index: at, tier: 'never' as const, because: 'current work', from: -1 }
    }

    if (entry.role === 'user' && entry.opensTurn) {
      return { index: at, tier: 'never' as const, because: 'the person said it', from: -1 }
    }

    // A failure is not protected by being a failure. Most of them did not
    // matter, and one that still does is in the newest messages, which are
    // never released anyway — so protecting old ones bought nothing and kept
    // the terminal output that is the best thing to reclaim.
    //
    // A measurement is different: it is the authority for a claim made later,
    // and a session cites one long after it was taken.
    if (entry.chars <= MARKER_SCAN && settledBy(entry.text, settling)) {
      return {
        index: at,
        tier: 'never' as const,
        because: 'a measurement or a decision',
        from: -1,
      }
    }

    const repeated = repeats.get(at)

    if (repeated !== undefined) {
      return { index: at, tier: 'repeat' as const, because: 'the same call', from: repeated }
    }

    // Reach settles the small material for nothing. It does not get to settle
    // the large material: that is where a reclaim is worth a question.
    if (reached.has(at) && entry.chars <= ASK_ABOVE) {
      return { index: at, tier: 'reached' as const, because: 'the current work points at it', from: -1 }
    }

    return { index: at, tier: 'residue' as const, because: 'no rule settled it', from: -1 }
  })
}

/**
 * The messages a provider is asked about.
 *
 * A provider call costs minutes and a transcript is mostly decidable without
 * one, so only the residue is sent. This is the whole economy of the thing:
 * the rules do the bulk for nothing, and the model is spent on the part that
 * actually needs judgement.
 *
 * @param verdicts every message's verdict
 * @returns the indices worth asking about
 */
export function residueOf(verdicts: readonly Verdict[]): readonly number[] {
  return verdicts.filter(one => one.tier === 'residue').map(one => one.index)
}

/**
 * What one framing said about each message, as a score.
 *
 * A reviewer answers with findings, not with probabilities, so the score is
 * read off the answer: a message a framing named as reclaimable is needed as
 * little as that framing was confident, and a message it did not name is
 * needed fully. That is the honest reading — a reviewer that said nothing
 * about a message did not say it could go.
 *
 * @param named the confidence of the finding each message was named by
 * @param index the message to score
 * @returns how much that framing says the message is needed
 */
export function neededFrom(
  named: ReadonlyMap<number, number>,
  index: number,
): number {
  const confidence = named.get(index)

  return confidence === undefined ? 1 : Math.max(0, Math.min(1, 1 - confidence))
}

/** How one framing scored a candidate. */
export type Framing = { callNeeded: number; resultNeeded: number }

/** What the two framings came to together. */
export type Combination = {
  callNeeded: number
  resultNeeded: number
  agreed: boolean
}

/**
 * The two framings of one candidate, combined.
 *
 * A candidate is judged once on what it says and once against what the session
 * is doing now. The blend is recency-weighted, and both framings must fall
 * under the ceiling independently: a single framing can never let a message go,
 * because a call that merely looks finished and a call the work has moved past
 * are the same thing seen from one side.
 *
 * `dissent` is how far the two may differ and still be read as agreeing.
 *
 * @param own what the framing holding its own content scored it
 * @param newest what the framing anchored on current work scored it
 * @param weights the recency weight, the dissent margin and the bar
 * @returns the combination, or undefined when a framing is missing
 */
export function combine(
  own: Framing | undefined,
  newest: Framing | undefined,
  weights: { recencyWeight: number; dissent: number; bar: number },
): Combination | undefined {
  if (own === undefined || newest === undefined) {
    return undefined
  }

  const weight = weights.recencyWeight
  const ceiling = weights.bar + weights.dissent

  return {
    callNeeded: weight * newest.callNeeded + (1 - weight) * own.callNeeded,
    resultNeeded: weight * newest.resultNeeded + (1 - weight) * own.resultNeeded,
    agreed:
      own.callNeeded <= ceiling &&
      newest.callNeeded <= ceiling &&
      own.resultNeeded <= ceiling &&
      newest.resultNeeded <= ceiling,
  }
}

/**
 * Whether the two framings let a candidate go.
 *
 * The bar is lowered by `supersessionBias` when the rules already found what
 * supersedes it, because a judgement that agrees with the evidence needs less
 * of itself than one that stands alone.
 *
 * @param combined what the framings came to
 * @param bar the bar to clear
 * @param isSuperseded whether a rule found what supersedes it
 * @param supersessionBias how far the bar moves when one did
 * @returns whether it may be let go
 */
export function releases(
  combined: Combination | undefined,
  bar: number,
  isSuperseded: boolean,
  supersessionBias: number,
): boolean {
  if (combined === undefined) {
    return false
  }

  const against = bar + (isSuperseded ? supersessionBias : 0)

  return combined.agreed && combined.callNeeded <= against && combined.resultNeeded <= against
}


/**
 * How dense the context is, and how much of it the rules alone could settle.
 *
 * Without a figure this is a feeling. `settled` is the share the rules decided
 * for nothing, which is what says whether the economy is working; `reclaimable`
 * is the share that could go; `kept` names why the rest stayed, which is what
 * makes a disappointing number explainable rather than just disappointing.
 *
 * @param entries the transcript's messages
 * @param verdicts their verdicts
 * @returns the measurements, as whole numbers
 */
export function measure(
  entries: readonly Entry[],
  verdicts: readonly Verdict[],
): {
  chars: number
  settledChars: number
  residueChars: number
  neverChars: number
  settledShare: number
  residueShare: number
} {
  const sized = new Map(entries.map(one => [one.index, one.chars]))
  const total = entries.reduce((sum, one) => sum + one.chars, 0)
  let settled = 0
  let residue = 0
  let never = 0

  for (const verdict of verdicts) {
    const chars = sized.get(verdict.index) ?? 0

    if (verdict.tier === 'residue') {
      residue += chars
    } else if (verdict.tier === 'never') {
      never += chars
    } else {
      settled += chars
    }
  }

  const share = (part: number): number =>
    total > 0 ? Math.round((part / total) * 100) : 0

  return {
    chars: total,
    settledChars: settled,
    residueChars: residue,
    neverChars: never,
    settledShare: share(settled),
    residueShare: share(residue),
  }
}

/**
 * One message of the live conversation, reduced to what the rules read plus
 * what pairs it to another message.
 *
 * `uses` and `results` are the tool call ids the message carries. They are the
 * whole reason this type exists: a call and its result are one exchange in two
 * messages, and dropping half of one leaves the conversation in a shape the
 * API will not accept.
 */
export type Row = {
  at: number
  role: string
  text: string
  chars: number
  opensTurn: boolean
  uses: readonly string[]
  results: readonly string[]
  handle: string
}

/**
 * Which messages of the live conversation survive a refinement.
 *
 * Three things decide it, in order of authority. The newest messages always
 * stay, because they are the work going on. What a session returns to stays,
 * because that is what `never` means. What is left may go, and only what a
 * reviewer released may go beyond what the rules settled themselves.
 *
 * A call and its result move together, because a result whose call is gone is
 * a message the engine cannot replay. They move together in both directions:
 * holding a pair whenever either half was merely `reached` is what made the
 * rules free nothing. Reach is a cheap guess that the newest messages still
 * point at something, and inside a pair whose other half a reviewer released
 * it does not outrank that release. Measured on two 1,200,000-character
 * windows: 58% and 60% of everything released came back this way, which put
 * the best reachable reduction at 6.4% and 6.7% against a 10% floor, so no
 * refinement could install on any path.
 *
 * An assistant message carrying several calls goes only when every one of
 * them is droppable, so a call that survives never loses the message that
 * issued it.
 *
 * @param rows the conversation, oldest first
 * @param verdicts what the rules made of each row
 * @param released the handles a reviewer agreed could go
 * @param keepNewest how many of the newest rows are never dropped
 * @returns the positions to keep
 */
/** The shortest ask taken as text to match rather than as a description. */
export const MATCH_FLOOR = 8

/**
 * The handles of messages whose text contains one of the asks, word for word.
 *
 * A cleaner is asked to interpret a description — "the API errors" — and that
 * costs a provider and a window scan. Most of what a person wants gone they
 * can quote instead, and a quoted string needs no model at all: the match is
 * made here, which is why `/backseat forget` still works with every provider
 * unreachable.
 *
 * An ask shorter than `MATCH_FLOOR` is treated as a description and left to a
 * cleaner, because a few characters match most of a conversation.
 *
 * @param rows the live conversation
 * @param asks what the person asked to have dropped, in their words
 * @returns the handles whose text contains one of them
 */
export function matchedBy(
  rows: readonly Row[],
  asks: readonly string[],
): Set<string> {
  const wanted = asks
    .map(ask => ask.trim().toLowerCase())
    .filter(ask => ask.length >= MATCH_FLOOR)
  const found = new Set<string>()

  if (wanted.length === 0) {
    return found
  }

  for (const row of rows) {
    if (row.handle === '') {
      continue
    }

    const text = row.text.toLowerCase()

    if (wanted.some(ask => text.includes(ask))) {
      found.add(row.handle)
    }
  }

  return found
}

export function survivorsOf(
  rows: readonly Row[],
  verdicts: readonly Verdict[],
  released: ReadonlySet<string>,
  keepNewest: number,
  demanded: ReadonlySet<string> = new Set(),
): Set<number> {
  const tier = new Map(verdicts.map(one => [one.index, one.tier]))
  const newest = Math.max(0, rows.length - Math.max(0, keepNewest))
  const byPosition = new Map(rows.map(row => [row.at, row]))

  // A named message is held by nothing. A request to drop particular context is
  // not a request to drop it only where it happens to be old, and the thing
  // asked about — an API error, an answer since found wrong — is usually among
  // the newest. Recency and the rule-given `never` are both overruled; what
  // still holds is pairing, below, and the session file, which keeps every
  // released message for `/backseat rehydrate`.
  const named = (at: number): boolean => {
    const row = byPosition.get(at)

    return row !== undefined && demanded.has(row.handle)
  }

  const held = (at: number): boolean =>
    !named(at) && (at >= newest || tier.get(at) === 'never')

  const loose = (at: number): boolean => {
    const row = byPosition.get(at)

    if (row === undefined || held(at)) {
      return false
    }

    const verdict = tier.get(at)

    // Named by the person, and past `held` above, so recency has already had
    // its say: this is the tier being overruled, which is what the command is
    // for — an API error and a superseded answer are both things the rules keep.
    if (demanded.has(row.handle)) {
      return true
    }

    return verdict === 'repeat' || (verdict === 'residue' && released.has(row.handle))
  }

  // Rows joined by a shared call id are one exchange, and a message carrying
  // several calls joins all of them into it. The whole exchange moves or none
  // of it does: dropping a result while the message that issued its call
  // stays would leave a call the engine has no answer for, which is as
  // unreplayable as the reverse.
  const root = new Map<number, number>(rows.map(row => [row.at, row.at]))

  const find = (at: number): number => {
    let here = at

    while (root.get(here) !== here) {
      here = root.get(here) ?? here
    }

    return here
  }

  const holder = new Map<string, number[]>()

  for (const row of rows) {
    for (const id of [...row.uses, ...row.results]) {
      holder.set(id, [...(holder.get(id) ?? []), row.at])
    }
  }

  for (const sides of holder.values()) {
    for (const at of sides) {
      const a = find(sides[0] ?? at)
      const b = find(at)

      if (a !== b) {
        root.set(b, a)
      }
    }
  }

  const members = new Map<number, number[]>()

  for (const row of rows) {
    const at = find(row.at)

    members.set(at, [...(members.get(at) ?? []), row.at])
  }

  const keep = new Set<number>()

  for (const row of rows) {
    const pack = members.get(find(row.at)) ?? [row.at]

    // A named message takes its pair with it, whatever the pair's own tier or
    // age. The alternative is not keeping it safe: releasing a result while the
    // call that produced it stays leaves a call with no result, which is not a
    // conversation the engine can be handed back — and an error is the result
    // half of exactly such a pair, so this is the common case, not the corner.
    const goes =
      pack.some(at => named(at)) ||
      (pack.some(at => loose(at)) && !pack.some(at => held(at)))

    if (!goes) {
      keep.add(row.at)
    }
  }

  return keep
}


/**
 * Whether a refinement is worth installing.
 *
 * Replacing the conversation costs the engine's own compaction, which would
 * otherwise have produced a summary. A refinement that frees almost nothing
 * has spent that for nothing, so below the floor the engine is left to do what
 * it would have done.
 *
 * @param rows the conversation
 * @param keep the positions surviving
 * @param floor the least share of characters worth freeing, 0 to 1
 * @returns whether to install it
 */
export function worthInstalling(
  rows: readonly Row[],
  keep: ReadonlySet<number>,
  floor: number,
): boolean {
  const total = rows.reduce((sum, row) => sum + row.chars, 0)

  if (total === 0) {
    return false
  }

  const freed = rows
    .filter(row => !keep.has(row.at))
    .reduce((sum, row) => sum + row.chars, 0)

  return freed / total >= floor
}
