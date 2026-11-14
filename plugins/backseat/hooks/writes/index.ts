/**
 * Finding what a turn wrote when it did not use an edit tool, and diffing a
 * file no repository holds.
 *
 * `register.ts` snapshots the candidate paths a call names before the call
 * runs and compares them after, so a turn that writes through the shell is
 * reviewed on the same evidence as one that writes through an edit tool.
 */

import { newFileDiff } from '../evidence'

/**
 * The sinks a redirect names that are not files on the tree.
 *
 * `writeTargetsOf` drops them, because snapshotting and re-stating them once
 * per command would report a turn that only silenced output as a turn that
 * wrote.
 */
const NOT_FILES: readonly string[] = [
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/tty',
  '/dev/zero',
]

/**
 * How much of a file is held as a before-image.
 *
 * `snapshotOf` in `register.ts` reads this much of each candidate before a
 * call runs, so the cap bounds what one turn copies into the plugin's
 * environment however many files a command touches. A file over the cap is
 * still reported as changed, without a body.
 */
export const SNAPSHOT_LIMIT = 262144

/**
 * The words of a shell command, with one level of quoting removed.
 *
 * `writeTargetsOf` reads the words to find redirect targets and the
 * destination arguments of the copying commands. Quoting is honoured because
 * a path with a space in it is written quoted, and a splitter that ignored
 * quotes would hand back two words that name nothing.
 *
 * @param text the command as the call carries it
 * @returns the words, in order, unquoted
 */
export function shellTokens(text: string): string[] {
  const out: string[] = []
  let word = ''
  let quote = ''
  let has = false

  for (const ch of String(text ?? '')) {
    if (quote !== '') {
      if (ch === quote) {
        quote = ''
      } else {
        word += ch
      }

      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      has = true

      continue
    }

    if (/\s/.test(ch)) {
      if (word !== '' || has) {
        out.push(word)
      }

      word = ''
      has = false

      continue
    }

    word += ch
  }

  if (word !== '' || has) {
    out.push(word)
  }

  return out
}

/**
 * A command with its here-document bodies lifted out.
 *
 * `writeTargetsOf` parses the command text for redirects, and a body holds
 * lines of another language: a `>` inside a Python snippet is a comparison,
 * and reading it as a redirect names a file that was never written. The
 * bodies are returned rather than dropped because the snippet itself says
 * which files it opens for writing.
 *
 * @param command the command as the call carries it
 * @returns the command without the bodies, and the bodies
 */
export function withoutHeredocs(command: string): {
  text: string
  bodies: string[]
} {
  const lines = String(command ?? '').split(/\r?\n/)
  const kept: string[] = []
  const bodies: string[] = []
  let tag = ''
  let body: string[] = []

  for (const line of lines) {
    if (tag !== '') {
      if (line.trim() === tag) {
        bodies.push(body.join('\n'))
        body = []
        tag = ''
      } else {
        body.push(line)
      }

      continue
    }

    const opened = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)

    if (opened !== null) {
      tag = opened[2] ?? ''
    }

    kept.push(line)
  }

  if (body.length > 0) {
    bodies.push(body.join('\n'))
  }

  return { text: kept.join('\n'), bodies }
}

/**
 * The paths a Python snippet opens for writing.
 *
 * `writeTargetsOf` reads the here-document bodies through this, because a
 * turn that writes by piping a snippet into an interpreter names its files in
 * the snippet and nowhere else: without this the write is invisible and the
 * turn is reviewed as though it changed nothing.
 *
 * @param body the snippet, as the here-document carried it
 * @returns the paths it opens for writing
 */
export function pythonWriteTargets(body: string): string[] {
  const out: string[] = []
  const text = String(body ?? '')
  const opens = /\bopen\s*\(\s*(['"])([^'"]+)\1\s*,\s*(['"])([rwaxbt+]+)\3/g

  for (const found of text.matchAll(opens)) {
    const path = found[2] ?? ''
    const mode = found[4] ?? ''

    if (path !== '' && /[wax]/.test(mode)) {
      out.push(path)
    }
  }

  const writers =
    /\b(?:write_text|write_bytes|to_csv|to_json|to_parquet|savefig|savez|save)\s*\(\s*(['"])([^'"]+)\1/g

  for (const found of text.matchAll(writers)) {
    const path = found[2] ?? ''

    if (path !== '') {
      out.push(path)
    }
  }

  return out
}

/**
 * The paths a shell command names as somewhere to write.
 *
 * `collectWrites` in `register.ts` snapshots these before the call runs and
 * re-stats them after, which is how a turn that writes through the shell
 * rather than an edit tool is still reviewed. Only names the command itself
 * carries are returned; a path the command computes while it runs is found by
 * the directory listing instead.
 *
 * A redirect into a device is dropped by `NOT_FILES`, and `>&2` is not a
 * path, so neither reaches the snapshot.
 *
 * @param command the command as the call carries it
 * @returns the paths, deduplicated, in the order the command names them
 */
export function writeTargetsOf(command: string): string[] {
  const { text, bodies } = withoutHeredocs(command)
  const out: string[] = []
  const add = (path: string): void => {
    const name = path.trim()

    if (
      name !== '' &&
      !name.startsWith('-') &&
      !name.startsWith('&') &&
      !name.startsWith('/dev/fd/') &&
      !NOT_FILES.includes(name) &&
      !out.includes(name)
    ) {
      out.push(name)
    }
  }

  // The target may be quoted, because a path with a space in it is written
  // that way and an unquoted match would hand back only its first word.
  const redirects =
    /(?:^|[^0-9&>])[0-9]?>>?\s*("[^"]*"|'[^']*'|[^\s|;&<>()]+)/g

  for (const found of text.matchAll(redirects)) {
    add((found[1] ?? '').replace(/^["']|["']$/g, ''))
  }

  const words = shellTokens(text)

  for (const [at, word] of words.entries()) {
    if (word === '-o' || word === '--output') {
      add(words[at + 1] ?? '')
    }

    if (word.startsWith('--output=')) {
      add(word.slice('--output='.length))
    }

    if (word === 'tee') {
      for (const rest of words.slice(at + 1)) {
        if (rest.startsWith('-')) {
          continue
        }

        add(rest)

        break
      }
    }

    if (word === 'touch') {
      for (const rest of words.slice(at + 1)) {
        add(rest)
      }
    }
  }

  // An in-place editor rewrites the files it is given, which are its trailing
  // arguments; the flag itself may carry a backup suffix.
  const inPlace = words.findIndex(
    word => word === '-i' || word.startsWith('-i.') || word === '--in-place',
  )

  if (inPlace >= 0) {
    const takesValue = ['-e', '--expression', '-f', '--file']
    const rest = words.slice(inPlace + 1)

    for (const [at, word] of rest.entries()) {
      // A substitution carries the same slashes a path does, so a token that
      // opens like one is the editor's script and not a file it rewrites.
      if (
        word.startsWith('-') ||
        /^[sy][/,|#!]/.test(word) ||
        takesValue.includes(rest[at - 1] ?? '') ||
        !/[./]/.test(word)
      ) {
        continue
      }

      add(word)
    }
  }

  // The copying commands write their last argument. Requiring more than one
  // remaining word keeps `cp a` from being read as a write to `a`.
  for (const name of ['cp', 'mv', 'install', 'rsync']) {
    const at = words.indexOf(name)

    if (at < 0) {
      continue
    }

    const rest = words.slice(at + 1).filter(word => !word.startsWith('-'))
    const last = rest.at(-1)

    if (last !== undefined && rest.length > 1) {
      add(last)
    }
  }

  for (const body of bodies) {
    for (const path of pythonWriteTargets(body)) {
      add(path)
    }
  }

  return out
}

/**
 * What a path looked like before a call ran.
 *
 * `collectWrites` in `register.ts` holds one of these per candidate path and
 * compares it with the path's state after the call: `size` and `mtimeMs`
 * decide whether it was written, and `text` is the before-image the diff is
 * built from. A path that did not exist is held with `exists` false, so a
 * file the call creates is reported as new rather than as unchanged.
 */
export type Snapshot = {
  exists: boolean
  size: number
  mtimeMs: number
  text: string
  isWhole: boolean
}

/**
 * The state a path is in, as a listing or a stat reports it.
 *
 * `changedPaths` compares this with the before-image; it carries no body
 * because deciding that a path was written needs only its length and its
 * modified time.
 */
export type Stat = {
  exists: boolean
  size: number
  mtimeMs: number
}

/**
 * The paths a call changed.
 *
 * `collectWrites` in `register.ts` compares the before-images with the state
 * after the call. A path is changed when it has appeared, or when its size or
 * its modified time has moved: a rewrite that preserves the length still
 * moves the time, and a write that preserves the time still moves the length.
 *
 * @param before the before-images, by absolute path
 * @param after the state after the call, by absolute path
 * @returns the changed paths, in the order they were snapshotted
 */
export function changedPaths(
  before: ReadonlyMap<string, Snapshot>,
  after: ReadonlyMap<string, Stat>,
): string[] {
  const out: string[] = []

  for (const [path, was] of before) {
    const now = after.get(path)

    if (now === undefined || !now.exists) {
      continue
    }

    if (!was.exists || now.size !== was.size || now.mtimeMs !== was.mtimeMs) {
      out.push(path)
    }
  }

  return out
}

/**
 * The names a directory gained while a call ran.
 *
 * `collectWrites` in `register.ts` lists each directory a call named before
 * the call and again after it. This is what finds a file whose path the
 * command never spelled, which is the only way a write from a snippet that
 * builds its own filename is seen at all.
 *
 * @param before the entry names the directory held, by directory
 * @param after the entry names it holds now, by directory
 * @returns the new paths, directory and name joined
 */
export function appearedIn(
  before: ReadonlyMap<string, readonly string[]>,
  after: ReadonlyMap<string, readonly string[]>,
): string[] {
  const out: string[] = []

  for (const [dir, was] of before) {
    const now = after.get(dir)

    if (now === undefined) {
      continue
    }

    const had = new Set(was)

    for (const name of now) {
      if (!had.has(name)) {
        out.push(dir === '/' ? `/${name}` : `${dir}/${name}`)
      }
    }
  }

  return out
}

/**
 * A unified diff of one file, built without a repository.
 *
 * `collectDiff` in `register.ts` falls back to this for a path no repository
 * holds, which is the only evidence available for a tree that is not version
 * controlled: without it such a turn yields an empty diff and the review is
 * abandoned before a lane is asked.
 *
 * The changed lines are reported as one hunk between the common first and
 * last lines. A single hunk is coarser than a repository's own diff, which is
 * why this is the fallback rather than the path taken when a repository can
 * answer.
 *
 * @param path the file's name, as the diff should carry it
 * @param before the file's text before the turn, empty when it is new
 * @param after the file's text now
 * @returns the diff, empty when the text did not change
 */
export function unifiedDiff(
  path: string,
  before: string,
  after: string,
): string {
  const was = String(before ?? '')
  const now = String(after ?? '')

  if (was === now) {
    return ''
  }

  if (was === '') {
    return newFileDiff(path, now)
  }

  const cut = (text: string): string[] => {
    const lines = text.split(/\r?\n/)

    return lines.at(-1) === '' ? lines.slice(0, -1) : lines
  }

  const a = cut(was)
  const b = cut(now)
  let head = 0

  while (head < a.length && head < b.length && a[head] === b[head]) {
    head += 1
  }

  let tail = 0

  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1
  }

  const gone = a.slice(head, a.length - tail)
  const came = b.slice(head, b.length - tail)

  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${head + 1},${gone.length} +${head + 1},${came.length} @@`,
    ...gone.map(line => `-${line}`),
    ...came.map(line => `+${line}`),
  ].join('\n')
}

/**
 * The directories whose contents no commit can ever carry.
 *
 * `isEphemeral` matches a path against these. The system temp directories
 * hold each session's scratchpad, and the engine's own state directory holds
 * a session's transcripts, tool results and tasks: a turn that wrote into
 * either changed nothing a reviewer can ask about.
 */
const EPHEMERAL: readonly string[] = [
  '/tmp/',
  '/private/tmp/',
  '/var/tmp/',
  '/private/var/tmp/',
  '/var/folders/',
  '/private/var/folders/',
]

/**
 * Whether a path is somewhere a change cannot be kept.
 *
 * `keep` in `register.ts` drops these before they join the turn, so a turn
 * whose only writes were scratch files is not reviewed and a scratch file is
 * never shown to a lane as part of the change. Without it the
 * no-repository fallback diffs a subagent's scratchpad and a reviewer reports
 * on a file that exists to be thrown away.
 *
 * A path inside the session's own working tree is kept whatever directory
 * that tree sits in, because a project worked on under a temp directory is
 * still the work: it is only the scratch and state directories outside that
 * tree which are ephemeral.
 *
 * @param path the absolute path the turn wrote
 * @param home the home directory, for the engine's state directory
 * @param cwd the session's working directory, whose tree is never ephemeral
 * @returns whether the path is outside anything a commit could carry
 */
export function isEphemeral(path: string, home: string, cwd: string): boolean {
  const name = String(path ?? '')

  if (name === '') {
    return false
  }

  const here = String(cwd ?? '').replace(/\/+$/, '')

  if (here !== '' && (name === here || name.startsWith(`${here}/`))) {
    return false
  }

  const root = String(home ?? '').replace(/\/+$/, '')

  if (root !== '' && name.startsWith(`${root}/.claude/`)) {
    return true
  }

  return EPHEMERAL.some(dir => name.startsWith(dir))
}
