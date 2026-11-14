/**
 * Taking a reclaimed message back, and keeping enough of one to say what it
 * was.
 *
 * A reduction that cannot be undone is a bet that nothing will need what it
 * took. These are the other half of that bet: a reference the transcript can
 * be searched by, and a head kept in place of a message too large to drop
 * whole. Consumed by the compaction hook in `register.ts`.
 */

import type { Entry } from '../../cleaner'

/**
 * A fingerprint of some text, for noticing that it changed.
 *
 * FNV-1a, not a cryptographic digest: it answers "is this still the text the
 * reference was taken against", which is what rehydration needs, and it
 * answers it without an async call in a pure function.
 *
 * @param text the text to fingerprint
 * @returns the fingerprint, in hex
 */
export function printOf(text: string): string {
  let hash = 0x811c9dc5

  for (const character of String(text ?? '')) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return hash.toString(16).padStart(8, '0')
}

/** Where a reclaimed message can be fetched back from. */
export type Rehydration = {
  ref: string
  index: number
  chars: number
  print: string
}

/**
 * The note that lets a reclaimed message be fetched back.
 *
 * A reduction that cannot be undone is a bet that nothing will need what it
 * took. A reference turns that bet into a cache miss: the message is named,
 * fingerprinted and still in the transcript file, so asking for it again is a
 * lookup rather than a loss. This is what makes refining safe enough to do
 * often.
 *
 * @param entry the message being reclaimed
 * @returns its reference
 */
export function rehydrationFor(entry: Entry): Rehydration {
  return {
    ref: `m${entry.index}.${printOf(entry.text)}`,
    index: entry.index,
    chars: entry.chars,
    print: printOf(entry.text),
  }
}

/**
 * How much of a reclaimed message's own head is kept.
 *
 * Measured on a real conversation: 87 messages of 2,645 hold half of it. For
 * those, dropping the whole message loses the command and the first lines that
 * say what the output was, and keeping the whole message frees nothing. A head
 * of its own keeps what it was and frees the rest.
 */
export const KEPT_HEAD = 2_000

/**
 * What a reclaimed message keeps of its end.
 *
 * `tidy` is asked for outputs whose middle is boilerplate, and for most of
 * them — a build log, a test run, an install — the line that says how it
 * turned out is the last one. Keeping only the opening dropped exactly that,
 * so the rules had to refuse every output ending in its own answer, which is
 * most of the long ones worth reclaiming at all.
 */
export const KEPT_TAIL = 1_000

/**
 * What a reclaimed message keeps of both ends, and the note that says what
 * went from between them.
 *
 * The middle is what goes: the opening says what the output was, the end says
 * how it turned out, and a session returns to both. Below twice what is kept
 * there is nothing to win, because the note would cost most of what the cut
 * saves, so the message is kept whole and nothing is claimed for it.
 *
 * A slice can land between the halves of a surrogate pair, which would leave
 * an unpaired code unit at the join, so each end is trimmed by one unit when
 * it does.
 *
 * @param text the message's text
 * @param ref the reference it can be fetched back by
 * @returns the shortened text, or undefined when shortening it is not worth it
 */
export function shortened(text: string, ref: string): string | undefined {
  const body = String(text ?? '')

  if (body.length <= KEPT_HEAD * 2 + KEPT_TAIL) {
    return undefined
  }

  let head = body.slice(0, KEPT_HEAD)

  if (/[\ud800-\udbff]$/u.test(head)) {
    head = head.slice(0, -1)
  }

  let tail = body.slice(-KEPT_TAIL)

  if (/^[\udc00-\udfff]/u.test(tail)) {
    tail = tail.slice(1)
  }

  const note =
    `\n[backseat kept the first ${head.length} and last ${tail.length}` +
    ` characters of this message and released ${
      body.length - head.length - tail.length
    } from between them; the whole of it is in the session file, and` +
    ` /backseat rehydrate ${ref} fetches it back]\n`

  return head + note + tail
}
