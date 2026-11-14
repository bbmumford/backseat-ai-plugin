/**
 * What `/backseat` was asked to do.
 *
 * `list` is the bare command. `review` runs the lanes now instead of waiting
 * for the next turn that changes code. `setup` probes the providers and
 * prints the resolved roster. `lanes` prints the roster without probing.
 * `purpose` sets what the current work is for, which every lane is then told.
 * `model` changes the model a lane asks, or all of them. `lane` adds one
 * reviewer for this session alone. `clean` asks the cleaner lanes what in
 * this session's own transcript no longer needs to stay. `rehydrate` fetches
 * a reclaimed message back by the reference a finding named. `cancel` stops the
 * panel waiting on a review in flight.
 */
export type Sub =
  | 'list'
  | 'review'
  | 'setup'
  | 'lanes'
  | 'purpose'
  | 'model'
  | 'lane'
  | 'clean'
  | 'rehydrate'
  | 'refine'
  | 'forget'
  | 'cancel'
  | 'help'

/**
 * The parsed command line.
 *
 * `base` is the ref an on-demand review diffs against, empty for the working
 * tree. `only` narrows the run to the named lanes. `words` holds the
 * positional arguments, and `rest` the whole of them as one string, which is
 * what `purpose` takes. `isClear` is the `--clear` flag.
 *
 * `problems` holds what could not be read; the command prints them and runs
 * nothing, because a review that silently ignored a misspelled flag would be
 * a review of the wrong thing.
 */
export type Args = {
  sub: Sub
  base: string
  only: readonly string[]
  words: readonly string[]
  rest: string
  isClear: boolean
  isAgents: boolean
  problems: readonly string[]
}

/**
 * The flags each subcommand takes, and how many positional arguments.
 *
 * A flag offered to a subcommand that does not take it is a problem rather
 * than a no-op, which is the failure both upstream plugins have: a
 * `--background` parsed and then never read.
 *
 * `words` is the most positionals the subcommand accepts; `purpose` takes
 * free text, so it is unbounded.
 */
const TAKES: Readonly<
  Record<Sub, { flags: readonly string[]; words: number }>
> = {
  list: { flags: [], words: 0 },
  review: { flags: ['--base', '--lanes'], words: 0 },
  setup: { flags: [], words: 0 },
  lanes: { flags: [], words: 0 },
  purpose: { flags: ['--clear'], words: Number.POSITIVE_INFINITY },
  model: { flags: [], words: 2 },
  lane: {
    flags: ['--clear', '--agents'],
    words: Number.POSITIVE_INFINITY,
  },
  clean: { flags: ['--lanes'], words: 0 },
  rehydrate: { flags: [], words: 1 },
  refine: { flags: [], words: 0 },
  forget: { flags: ['--clear'], words: Number.POSITIVE_INFINITY },
  cancel: { flags: [], words: 0 },
  help: { flags: [], words: 0 },
}

/**
 * The flags that are a flag on their own rather than a flag and a value.
 */
const BARE: readonly string[] = ['--clear', '--agents']

/**
 * Every subcommand the parser accepts.
 *
 * Exported so a test can assert that each one parses: the names are printed by
 * `help` from a separate list, and a name printed but not parsed is the defect
 * this guards.
 */
export const SUBCOMMANDS: readonly Sub[] = Object.keys(TAKES) as Sub[]

/**
 * Reads the text after `/backseat`.
 *
 * @param args the `args` field of the `command.run` event
 * @returns the subcommand, its arguments, and anything that could not be read
 */
export function parseArgs(args: string): Args {
  const tokens = String(args ?? '')
    .trim()
    .split(/\s+/)
    .filter(token => token !== '')

  const empty = {
    base: '',
    only: [] as string[],
    words: [] as string[],
    rest: '',
    isClear: false,
    isAgents: false,
  }

  if (tokens.length === 0) {
    return { sub: 'list', ...empty, problems: [] }
  }

  const head = (tokens[0] ?? '').toLowerCase()
  const sub = subOf(head)

  if (sub === undefined) {
    return {
      sub: 'help',
      ...empty,
      problems: [`"${head}" is not a backseat subcommand`],
    }
  }

  const takes = TAKES[sub]
  const problems: string[] = []
  const words: string[] = []
  let base = ''
  let only: string[] = []
  let isClear = false
  let isAgents = false

  for (let at = 1; at < tokens.length; at += 1) {
    const token = tokens[at] ?? ''

    if (!token.startsWith('--')) {
      if (words.length >= takes.words) {
        problems.push(
          takes.words === 0
            ? `${sub} takes no arguments, so "${token}" is not read`
            : `${sub} takes at most ${takes.words} argument(s), so "${token}" is not read`,
        )
        continue
      }

      words.push(token)
      continue
    }

    if (!takes.flags.includes(token)) {
      problems.push(`${sub} does not take ${token}`)
      continue
    }

    if (BARE.includes(token)) {
      isClear = isClear || token === '--clear'
      isAgents = isAgents || token === '--agents'
      continue
    }

    const value = tokens[at + 1] ?? ''

    if (value === '' || value.startsWith('--')) {
      problems.push(`${token} needs a value`)
      continue
    }

    at += 1

    if (token === '--base') {
      base = value
    } else {
      only = value
        .split(',')
        .map(entry => entry.trim())
        .filter(entry => entry !== '')
    }
  }

  return {
    sub,
    base,
    only,
    words,
    rest: words.join(' '),
    isClear,
    isAgents,
    problems,
  }
}

/**
 * The subcommand a word names, or `undefined` when it names none.
 *
 * @param head the first token after the command
 * @returns the subcommand
 */
function subOf(head: string): Sub | undefined {
  // Read off `TAKES` rather than listed again. `TAKES` is a `Record<Sub, …>`,
  // so a name added to `Sub` has to be added there or this file does not
  // compile — where a second list of the same names drifts in silence, which
  // is how a subcommand came to be printed by `help` and refused by the
  // parser in the same breath.
  return (Object.keys(TAKES) as Sub[]).find(entry => entry === head)
}
