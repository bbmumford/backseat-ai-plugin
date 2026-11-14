/**
 * The cheap evidence the tiering rests on: which names the current work still
 * points at, which calls repeat an earlier one, and which words still mark a
 * message as having settled something.
 *
 * Everything here is a pure function over the messages `cleaner` produced and
 * is consumed by `tiersOf` in the module above. It is separated because it is
 * the half that reads text, while the half above only arranges verdicts.
 */

import type { Entry } from '../../cleaner'

/**
 * How much of a transcript a name may appear in and still single a message
 * out.
 *
 * Measured on a real session of 2,660 messages: matching on any shared name
 * marked 68.9% of it as reached, which left almost nothing to examine and
 * starved the question. At this share it marks about half, and the material
 * that moves does not move to removal — it moves to being asked about, which
 * is the safe direction to be wrong in.
 */
const COMMON_SHARE = 0.05

/**
 * Below this many messages, how often a name appears says nothing.
 *
 * A name in two messages out of three is not common, it is the subject. The
 * rarity rule needs enough documents for its frequency to mean something, and
 * under that it is not applied at all.
 */
const SPREAD_FLOOR = 50

/**
 * How large a message may be and still be characterised by a word in it.
 *
 * A short message saying a command failed is an error. A sixty-kilobyte build
 * log that mentions the word once is an output that happens to contain it, and
 * protecting it forever on that basis is what made 63% of a measured
 * conversation permanently unreclaimable. Above this size the markers prove
 * nothing and the message is judged like any other.
 */
export const MARKER_SCAN = 4_000

/**
 * Above this, a message is worth asking about whatever else the rules think.
 *
 * Reach is a cheap guess that the current work still needs something, and it
 * is right often enough to settle small messages for nothing. On a measured
 * conversation it settled 73% — and left only 5% to examine, because the
 * large outputs where the mass actually sits all shared some name with the
 * work going on.
 *
 * A large message is exactly the one whose reclaim pays for the question, so
 * size overrides reach: the rules keep their economy on the small material
 * and hand the expensive material to a reviewer.
 */
export const ASK_ABOVE = 10_000

/**
 * The words a session uses when it settles something.
 *
 * Held as words rather than one expression because which of them still carry
 * evidence is decided per transcript by `settlingMarkers`.
 */
const MARKERS = [
  'measured',
  'benchmark',
  'decided',
  'ruling',
  'chose',
  'concluded',
  'verified',
  'confirmed',
] as const

/**
 * A figure with a unit: a measurement by its shape rather than its wording.
 *
 * This arm is not rarity-tested, because a word is evidence that a message
 * settled something while a number with a unit is the settlement itself, and
 * that reads the same whether a transcript holds one of them or a thousand.
 */
const SETTLED_UNITS = /\b\d[\d,]*\s*(?:ms|s|MB|GB|KB|%|tokens|chars|bytes)\b/i

/**
 * Which settling words still single a message out in this transcript.
 *
 * A fixed list of words fails on exactly the transcripts it matters most on: a
 * session whose subject is rulings and measurements says `ruling` and
 * `measured` in ordinary narration, so the marker stops marking anything and
 * holds the conversation unreclaimable instead. Measured on a 1,786-row
 * window, the fixed list held 197 rows — 23.3% of its characters — on the
 * strength of `ruling` appearing 841 times.
 *
 * A word is therefore kept only while it stays as rare as `reachedBy` demands
 * of a name, which is the same test answering the same problem.
 *
 * @param entries the transcript's messages, in order
 * @returns the words that still carry evidence here
 */
export function settlingMarkers(entries: readonly Entry[]): Set<string> {
  const spread = new Map<string, number>()

  for (const entry of entries) {
    for (const marker of MARKERS) {
      if (wordIn(marker).test(entry.text)) {
        spread.set(marker, (spread.get(marker) ?? 0) + 1)
      }
    }
  }

  const everywhere =
    entries.length < SPREAD_FLOOR
      ? entries.length
      : Math.max(1, Math.floor(entries.length * COMMON_SHARE))

  return new Set(MARKERS.filter(marker => (spread.get(marker) ?? 0) <= everywhere))
}

/** Cached so the spread count does not rebuild one expression per message. */
const WORD_TESTS = new Map<string, RegExp>()

/**
 * A whole-word test for one marker.
 *
 * Counting with a substring test would let `chosen` stand for `chose`, which
 * inflates the spread and disqualifies a word that is still rare.
 *
 * @param marker the word
 * @returns the expression matching it as a whole word
 */
function wordIn(marker: string): RegExp {
  const held = WORD_TESTS.get(marker)

  if (held !== undefined) {
    return held
  }

  const made = new RegExp(`\\b${marker}\\b`, 'i')

  WORD_TESTS.set(marker, made)

  return made
}

/**
 * Whether a message settled something, given the words that still count here.
 *
 * @param text the message's text
 * @param markers the words `settlingMarkers` kept for this transcript
 * @returns whether it reads as a measurement or a decision
 */
export function settledBy(text: string, markers: ReadonlySet<string>): boolean {
  if (SETTLED_UNITS.test(text)) {
    return true
  }

  for (const marker of markers) {
    if (wordIn(marker).test(text)) {
      return true
    }
  }

  return false
}

/**
 * The identifiers a message mentions, for deciding what later work reaches.
 *
 * Paths, dotted names and long bare words are kept; short words are not,
 * because a transcript shares its ordinary English with every other message
 * and matching on it would make everything reachable from everything.
 *
 * @param text one message's text
 * @returns the identifiers it mentions, lowercased
 */
export function namesIn(text: string): Set<string> {
  const names = new Set<string>()

  for (const [word] of String(text ?? '').matchAll(
    /[A-Za-z0-9_./-]{6,}|[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_.]*/gu,
  )) {
    const name = word.toLowerCase().replace(/^[./-]+|[./-]+$/gu, '')

    // A bare number is not a name, and a word with no letter in it cannot be
    // an identifier a later message is pointing back at.
    if (name.length >= 6 && /[a-z]/u.test(name)) {
      names.add(name)
    }
  }

  return names
}

/**
 * The messages the newest work still points at.
 *
 * This is the deterministic half of the two framings: rather than ask a model
 * whether the session has moved past a message, the names the newest messages
 * use are collected and every earlier message that carries one is marked as
 * reached. It is cheap, it is explainable, and it is wrong only in the safe
 * direction — a message is kept because something might still point at it.
 *
 * @param entries the transcript's messages, in order
 * @param anchor how many of the newest messages count as the current work
 * @returns the indices the current work reaches
 */
export function reachedBy(
  entries: readonly Entry[],
  anchor: number,
): Set<number> {
  const spoken = entries.map(entry => namesIn(entry.text))
  const spread = new Map<string, number>()

  for (const names of spoken) {
    for (const name of names) {
      spread.set(name, (spread.get(name) ?? 0) + 1)
    }
  }

  const everywhere =
    entries.length < SPREAD_FLOOR
      ? entries.length
      : Math.max(1, Math.floor(entries.length * COMMON_SHARE))
  const recent = spoken.slice(-Math.max(1, anchor))
  const wanted = new Set<string>()

  for (const names of recent) {
    for (const name of names) {
      // A name the whole transcript uses says nothing about which message the
      // current work is pointing at. Only a name that is rare enough to single
      // a message out is evidence of reach.
      if ((spread.get(name) ?? 0) <= everywhere) {
        wanted.add(name)
      }
    }
  }

  const reached = new Set<number>()

  entries.forEach((entry, at) => {
    for (const name of spoken[at]!) {
      if (wanted.has(name)) {
        reached.add(entry.index)
        break
      }
    }
  })

  return reached
}

/**
 * The fingerprint of a tool call's input, for finding the same call again.
 *
 * Whitespace and digits are flattened, so a script run twice with a different
 * count fingerprints the same and is reported as a repeat with a difference
 * rather than as two unrelated calls. The first line is kept whole because it
 * names the tool and the target, which is what makes a repeat legible.
 *
 * @param text one message's text
 * @returns the fingerprint, empty when the message holds no call
 */
export function callPrint(text: string): string {
  const body = String(text ?? '')
  const open = body.indexOf('(')

  if (open <= 0) {
    return ''
  }

  return `${body.slice(0, open)}:${body
    .slice(open)
    .replace(/\d+/gu, '#')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 400)}`
}

/**
 * Calls whose input repeats one already in the transcript.
 *
 * Tool inputs are the mass nothing else touches: a result can be shortened and
 * a duplicate read can be dropped, but the command that produced them is
 * carried whole every time, and a session that runs the same script forty
 * times carries it forty times. A repeat can say "the call at 412, with the
 * numbers changed" instead.
 *
 * @param entries the transcript's messages, in order
 * @returns each repeat's index, mapped to the index it repeats
 */
export function repeatedCalls(entries: readonly Entry[]): Map<number, number> {
  const first = new Map<string, number>()
  const repeats = new Map<number, number>()

  for (const entry of entries) {
    const print = callPrint(entry.text)

    if (print === '') {
      continue
    }

    const seen = first.get(print)

    if (seen === undefined) {
      first.set(print, entry.index)
      continue
    }

    repeats.set(entry.index, seen)
  }

  return repeats
}
