/**
 * The tools whose use means the turn changed code.
 *
 * A turn that used none of them is never reviewed, however long it ran: a
 * status report, a search, or a plan has nothing for a reviewer to judge,
 * and reviewing it trains a person to dismiss the cards. The `tool.call`
 * hook in `register.ts` tests each call against this set.
 */
const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit']

/**
 * How much diff a lane is given.
 *
 * A provider's context is finite and a reviewer handed a diff longer than it
 * can hold reports on the part it saw as though it were the whole. Cutting
 * it here, and saying so in the prompt, is what keeps a partial read from
 * becoming a confident finding about an unread file.
 */
const DIFF_LIMIT = 120000

/**
 * How much of one governing document a lane is given, and how many.
 *
 * The documents compete with the diff for the same context, so a lane that
 * was pointed at a directory of specifications reads the first few rather
 * than all of them, and each is cut.
 */
const DOC_LIMIT = 40000
const DOC_COUNT = 6

/**
 * Whether a tool call changes code.
 *
 * @param tool the `tool` field of a `tool.call` event
 * @returns whether the call means this turn has something to review
 */
export function isEditTool(tool: string): boolean {
  return EDIT_TOOLS.includes(tool)
}

/**
 * The file a tool call writes to, or empty when the call names none.
 *
 * Both spellings are read because the notebook tool names its target
 * differently from the file tools, and a hook that knew only one would
 * record a notebook edit as a turn that changed nothing.
 *
 * @param input the `tool.call` event, as plain data
 * @returns the path the call writes, relative or absolute as given
 */
export function pathOf(input: Readonly<Record<string, unknown>>): string {
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const value = input[key]

    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim()
    }
  }

  return ''
}

/**
 * A diff cut to the length a lane is given, and whether it was cut.
 *
 * The cut falls on a line boundary so the last hunk a reviewer sees is a
 * whole line rather than half of one, which would otherwise read as a
 * truncated identifier and get reported as a syntax error.
 *
 * @param diff the diff as the repository produced it
 * @returns the diff a lane is given, and whether anything was dropped
 */
export function fitDiff(diff: string): { text: string; isTruncated: boolean } {
  const body = String(diff ?? '')

  if (body.length <= DIFF_LIMIT) {
    return { text: body, isTruncated: false }
  }

  const cut = body.slice(0, DIFF_LIMIT)
  const lastBreak = cut.lastIndexOf('\n')

  return {
    text: lastBreak > 0 ? cut.slice(0, lastBreak) : cut,
    isTruncated: true,
  }
}

/**
 * The documents a lane is given, out of the ones it was configured to read:
 * the first `DOC_COUNT` that were found, each cut to `DOC_LIMIT`.
 *
 * Consumed by `promptFor`, which prints them under
 * `<governing_documents>`. A document that was configured and not found is
 * absent here, and the prompt's wording accounts for the empty case.
 *
 * @param loaded every configured document that could be read
 * @returns the documents, in configured order, cut to fit
 */
export function fitDocs(
  loaded: readonly { path: string; text: string }[],
): { path: string; text: string }[] {
  return loaded.slice(0, DOC_COUNT).map(doc => ({
    path: doc.path,
    text:
      doc.text.length > DOC_LIMIT
        ? `${doc.text.slice(0, DOC_LIMIT)}\n[document cut at its size limit]`
        : doc.text,
  }))
}

/**
 * A unified diff for a file the repository has never seen, written from the
 * file's own text.
 *
 * A new file has no diff against `HEAD`, and the git commands that would
 * show one — `add --intent-to-add`, `add -N` — write to the index, which is
 * the person's staging area and not this plugin's to touch. Writing the
 * hunk here keeps a reviewer able to see new files while leaving the index
 * exactly as the turn left it, on every platform.
 *
 * @param path the file's path, as the turn named it
 * @param text the file's whole content
 * @returns the diff a lane reads for a new file
 */
export function newFileDiff(path: string, text: string): string {
  const lines = String(text ?? '').split(/\r?\n/)
  const body = lines.at(-1) === '' ? lines.slice(0, -1) : lines

  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${body.length} @@`,
    ...body.map(line => `+${line}`),
  ].join('\n')
}

/**
 * The paths worth asking the repository for a diff of: the ones this turn
 * wrote, deduplicated, in the order they were first written.
 *
 * Order is kept because it is the order the work happened in, which is the
 * order a reviewer reads most naturally.
 *
 * @param written every path the turn's edit tools named, with repeats
 * @returns the distinct paths, first-written first
 */
export function distinctPaths(written: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  for (const path of written) {
    if (path !== '' && !seen.has(path)) {
      seen.add(path)
      out.push(path)
    }
  }

  return out
}

/**
 * The directory part of a path, or `.` when the path names no directory.
 *
 * Used to ask git which repository a changed file belongs to, one question
 * per directory rather than one per file.
 *
 * @param path a file's path
 * @returns the directory holding it
 */
export function dirOf(path: string): string {
  const cut = path.lastIndexOf('/')

  return cut <= 0 ? (cut === 0 ? '/' : '.') : path.slice(0, cut)
}

/**
 * A path made absolute against the working directory.
 *
 * An edit tool may report either form, and a path handed to git with `-C`
 * means a different file than the same path handed to git in the session's
 * own directory. Resolving first is what makes the two agree.
 *
 * @param cwd the session's working directory, absolute
 * @param path the path as a tool reported it
 * @returns the absolute path
 */
export function absolute(cwd: string, path: string): string {
  if (path.startsWith('/')) {
    return path
  }

  const trimmed = path.startsWith('./') ? path.slice(2) : path

  return cwd === '' ? trimmed : `${cwd.replace(/\/+$/, '')}/${trimmed}`
}

/**
 * The changed paths grouped by the repository that holds them.
 *
 * A directory tree may hold many repositories rather than one — a fleet of
 * them side by side, with no repository at the root — and a working
 * directory need not be a repository at all. A diff taken in the session's
 * own directory then sees nothing and the reviewers are handed no evidence,
 * which is worse than reviewing nothing because the lanes still run. Grouping
 * by the repository each file actually belongs to is what makes the evidence
 * real in both layouts.
 *
 * @param roots each file's directory mapped to its repository root, absent
 *   for a directory git reports no repository for
 * @param paths the absolute paths that changed
 * @returns the repository roots, each with the paths inside it
 */
export function byRepo(
  roots: ReadonlyMap<string, string>,
  paths: readonly string[],
): Map<string, string[]> {
  const grouped = new Map<string, string[]>()

  for (const path of paths) {
    const root = roots.get(dirOf(path))

    if (root === undefined || root === '') {
      continue
    }

    grouped.set(root, [...(grouped.get(root) ?? []), path])
  }

  return grouped
}

/**
 * The directories to look for lane files in, nearest last.
 *
 * A reviewer written for a whole tree of repositories belongs beside the
 * tree, not copied into each repository in it, so the lane directory is
 * inherited: every directory from `stop` down to `cwd` may hold one, and the
 * nearest wins. The walk stops at `stop` so a lane directory outside the
 * person's own tree is never read.
 *
 * @param cwd the session's working directory, absolute
 * @param stop the highest directory to look in, absolute
 * @param laneDir the lane directory's name, relative
 * @returns the lane directories, outermost first, at most eight
 */
export function laneDirsFor(
  cwd: string,
  stop: string,
  laneDir: string,
): string[] {
  if (laneDir === '') {
    return []
  }

  // An absolute lane directory names itself, and an unknown working directory
  // leaves the relative one to resolve as the engine's own process does:
  // losing the walk must not lose the lane directory with it.
  if (cwd === '' || laneDir.startsWith('/')) {
    return [laneDir]
  }

  const here = cwd.replace(/\/+$/, '')
  const top = stop.replace(/\/+$/, '')
  const out: string[] = []
  let at = here

  while (at !== '' && at !== '/') {
    out.push(`${at}/${laneDir}`)

    if (at === top) {
      break
    }

    const cut = at.lastIndexOf('/')

    if (cut <= 0) {
      break
    }

    at = at.slice(0, cut)
  }

  return out.slice(0, 8).reverse()
}

/**
 * The directory a lane file's own paths are relative to.
 *
 * A lane inherited from a directory above the session names its documents
 * relative to the tree it was written for, not to wherever the session
 * happens to be: `platform/design` in a lane beside a tree of repositories
 * means that tree's design folder, and resolving it against the session's own
 * directory would silently find nothing in every repository but one.
 *
 * @param dir the lane directory the file was read from
 * @param laneDir the configured lane directory, relative
 * @returns the directory to resolve the lane's own paths against
 */
export function laneRootOf(dir: string, laneDir: string): string {
  const suffix = `/${laneDir}`

  return laneDir !== '' && dir.endsWith(suffix)
    ? dir.slice(0, dir.length - suffix.length)
    : dir
}
