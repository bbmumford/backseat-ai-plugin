# backseat: architecture

The design the code answers to. The `docs` lane exists to notice when an
implementation has made a document like this one untrue, so this file is held to its
own standard: it describes the modules and seams that exist, and nothing else.

## The decision that shapes everything

The brief asked for the "let-you-know pipeline" to carry review results. That pipeline
is not a hook and not a CLI: it is the mods API, and the built-in `you-should-know`
mod is its only worked example. `turn.step` decides a check is due, `$.model.fork`
runs the observer on a fork of the live conversation, `ui.render` on `AbovePrompt`
draws the result as a card, and the card's buttons call `prompt.fill` and
`prompt.submit` to turn a suggestion into work.

So this is a **mod**, not a plugin that shells out. Everything else follows:

- A reviewer can run in-process, which costs no second subscription, needs no setup,
  and cannot edit the tree. `$.model.complete` is the default rather than
  `$.model.fork`: the review prompt already carries the diff, the documents and the
  lane's instructions, so it needs no conversation — and a fork both inherits a wrong
  premise the session has accepted and has nothing to fork from in a session with no
  transcript yet. `fork` stays available for when the reviewer should know what the
  session was doing, and falls back to a completion when the transcript is cold.
- An external provider is reached with `$.process.run`, which is the same seam a
  CLI-wrapper plugin would use, but it is one option rather than the architecture.
- Delivery is a drawing with buttons, not text printed by a hook.

## Module boundaries

The mods static analyser allows `$` to be passed only to a top-level function in the
hooks module's own file, and `hooks.json` names exactly one hooks module per plugin.
That constraint decides the layout, and it is a good one: everything that does not
touch `$` is pushed out into a module that can be tested without the engine, and
`register.ts` keeps only the I/O. It is the one file over the 500-line limit, and the
engine is why.

| File | Holds | Touches `$` |
| :- | :- | :-: |
| `hooks/register.ts` | every hook, and the helpers that reach outside: `review`, `runLane`, `collectDiff`, `readDocs`, `cardFor`, `storedSeen`, `drop`, `loadLanes`, `readLaneDir`, `userLaneDir`, `reload` | yes |
| `hooks/config/index.ts` | `userConfig` → `Config`; lane resolution, clamping, list parsing, `atOrAbove`, `isBlocking` | no |
| `hooks/lanes/index.ts` | the prompts — `promptFor`, `explainPrompt`, `fixPrompt` — the output contract, and the wave scheduling — `wavesOf`, `inputsFor`, `batches` | no |
| `hooks/providers/index.ts` | provider descriptors and templates; `invocationFor`, `invocationFromTemplate`, `templatesFrom`, `answerFrom`, `probeFor`, and the failure readers `forkReason`, `messageOf`, `firstLine` | no |
| `hooks/verdict/index.ts` | `Finding`, `LaneResult`; `parse`, `subjectOf`, `rank` with its cross-lane merge, `resultOf` | no |
| `hooks/evidence/index.ts` | what counts as an edit; `fitDiff`, `fitDocs`, `newFileDiff`, `distinctPaths` | no |
| `hooks/deliver/index.tsx` | the card trees, from the element table the render hook resolves | no |
| `hooks/report/index.ts` | the text the panel speaks in: `holdReason`, `context`, `listing`, `setupReport`, `lanesReport`, `cancelReport`, `helpText` | no |
| `hooks/args/index.ts` | `/backseat`'s own command line: `parseArgs`, with per-subcommand flags and positionals | no |
| `hooks/lanefile/index.ts` | where a lane comes from outside the code: `laneFrom`, `isLaneFile`, `nameOf`, and the tiering — `mergeLanes`, `lanesForTurn`, `sessionLaneOf` | no |

Every pure module is unit-testable without the harness, and `register.ts` is the only
file that has to be reasoned about with the engine in mind.

## The seven hooks

| Event | Why this event |
| :- | :- |
| `session.start` | register `/backseat`, read the stored subjects, report the lane roster under `debug` |
| `tool.call` | record which files the turn wrote, **after** `next` resolves, and only when the call neither denied nor errored — a refused edit is not work to review |
| `turn.complete` | the turn's work is finished and reviewable. The review is started and **not awaited**, so the panel never delays the turn — at the cost that `classic.Stop` usually runs first and hands the model nothing until the next turn |
| `ui.render{AbovePrompt}` | the delivery surface; returns `next(e)` when there is nothing to draw, so a session with no findings has no band |
| `command.run{command:'backseat'}` | one command with subcommands — `review`, `setup`, `lanes`, `purpose`, `model`, `lane`, `cancel`, `help` — because a panel needs a way to answer "why did nothing happen", and `argumentHint` makes them discoverable without a registration each |
| `classic.Stop` | hands the findings to the model as `additionalContext`, or holds the turn under `severity`/`block`. Has a `.catch` that **fails open** |
| `session.end` | drop this session's store key and in-memory state |

`turn.complete` rather than `turn.step`: the built-in mod wants to interrupt work in
progress, and this panel wants to judge work that is finished.

### Which loop a turn belongs to

Every hook sees a subagent's turn as well as the main loop's, and both `tool.call` and
`turn.complete` carry an `agentId` that is absent on the main loop. So what a turn
wrote is keyed by that id. One shared list was a defect: whichever turn ended first
carried the other's evidence off, and since a subagent finishes *inside* the turn that
spawned it, a delegated edit would routinely consume the files the main turn was about
to be reviewed on.

Two rules follow from keying it:

- A subagent's turn is reviewed only by the lanes that asked for subagents
  (`lanesForTurn`). Otherwise delegating work would put the whole panel on every step
  of it, which is both expensive and noisy — a subagent's turn ends mid-task, and most
  reviewers are about the work the person asked for, not a step toward it.
- What a subagent wrote **rolls up** into the delegating loop's list, so the whole
  roster reviews it when that turn ends. Dropping it instead would mean a turn that
  delegated all its editing was reviewed by nobody. `seen` keeps the roll-up from
  drawing a finding an agent lane already drew.

## State

| What | Where | Why there |
| :- | :- | :- |
| open findings, lane results, explanations | the `register` closure | this session's drawing; it does not outlive the session and nothing else may read it |
| what each loop wrote, and how many of its turns changed code | the closure, keyed by `agentId` | one shared list lets whichever turn ends first carry off another loop's evidence |
| subjects already shown or dismissed | `$.store`, under `seen:<sessionId>` | must survive a reload, and a **per-session key** is what keeps two sessions on one machine from losing each other's writes in a read-modify-write of a shared collection |

The shared-collection race is a real defect in the mod this design learned the channel
from, and the per-session key is the fix rather than a hope.

## The verdict contract

Three things about the contract are decided by how CLIs really behave rather than by
how the contract reads. A provider that narrates quotes the change in a fence before
answering, so `fromJson` tries every fenced block newest first and the whole body last;
taking the first fence parses the quotation and reports a real finding as no answer.
`CLEAN` is matched as a line of its own within the first three and last five non-empty
lines, with a bullet or quote marker stripped, because a banner precedes the answer and
a session id follows it — and a clean review misread as a non-answer is reported as a
provider that could not look, which is the inversion most worth avoiding. A declared
`{"verdict":"clean"}` carrying no list is an answer, not an empty shape.

The lane's question is framed as a subject the standing instructions may extend, not as
the only thing the reviewer may answer. A reviewer held to the question's wording
declines defects its own instructions name — it reports nothing and explains that the
defect was out of scope — which makes instructions dead text unless the question
enumerates them.


One canonical `Finding`, merged from the structured schema of one source and the
line-oriented report shape of another:

```
lane  severity  title  body  file  lineStart  lineEnd  confidence  recommendation  reference
```

`schemas/finding.schema.json` is the same shape as JSON Schema, and is handed to any
provider whose CLI can enforce an output shape. `parse` accepts four answers — a JSON
object, a fenced JSON block, a one-line `severity | file:line | title | fix` form, and
the bare word `CLEAN` — and distinguishes three silences that a single boolean would
collapse:

| Outcome | Meaning |
| :- | :- |
| `findings` | the lane found something |
| `clean` | the lane looked and found nothing |
| `skipped` | the lane never ran |
| `failed` | the lane's provider broke, timed out, or answered in a shape with no findings in it |

The `failed`/`clean` split is the load-bearing one. A panel that reported a broken
provider as a clean review would be worse than no panel, because it would certify work
nobody looked at.

## Identity, and why it is not the sentence

`subjectOf` keys a finding on `file + normalize(reference || title)`. Three things are
deliberately absent:

- **The line number**, because an edit above a finding moves it without changing it.
- **The wording**, because a reviewer rewords a standing finding on every turn.
- **The lane**, because two reviewers asking different questions reach the same
  duplicated function from different directions, and drawing that twice makes the
  panel look like it found two problems.

So `rank` merges a subject several lanes agree on into one finding whose `alsoFrom`
names the rest, and the card reads `backseat · spec + reuse`. The merge keeps the
worst severity and the highest confidence, because agreement between reviewers is
evidence and the panel should not round it down, and it fills a field the leading
finding left empty from the follower, so a terse reviewer and a thorough one about one
subject produce one complete finding rather than the terse one winning.

Keying on the subject is also what lets `seen` suppress a repeat: a finding dismissed
once stays dismissed whichever lane raises it next. A reviewer that leaves `reference`
empty falls back to its title, and then two wordings are two subjects — the cost of
the empty field, and the reason the schema requires it.

## Cross-linking, and where a lane comes from

A lane declares `needs`: the lanes whose findings it is given under
`<what_other_reviewers_found>`, with the instruction to use them as evidence and not
repeat them. `wavesOf` topologically sorts the graph, because a lane cannot read
findings that do not exist yet, and `inputsFor` hands each lane **only** the lanes it
named. A broadcast of every earlier finding would spend a reviewer's context on
findings it was never asked to reason about, and would make the link unconfigurable.

The shipped direction is `docs` needing `spec` and `reuse`, and it is not arbitrary:
whether a change falsified a design document depends on what the change actually did,
and a duplication another lane found is exactly the kind of thing a document will have
described as happening once.

Three degenerate cases are decided rather than left to chance. A lane that needs a
lane which is not enabled is treated as having that need met, so turning one lane off
cannot strand an unrelated one. A `needs` cycle cannot be ordered, so the lanes still
unplaced are emitted together as a final wave: they run, and they see none of each
other's findings, which is the most that can be honoured of a `needs` that contradicts
itself. `crossLink: false` flattens everything into one wave and gives every lane
nothing.

### A lane as a file

A lane's question fits in a setting; the standing instructions that make a reviewer
useful on one repository do not. `laneDir` holds a Markdown file per lane: frontmatter
for `provider`, `command`, `model`, `question`, `docs`, `needs`, `severity`,
`confidence`, `agents` and `enabled`, and the body as the reviewer's instructions,
placed above the output contract so it outranks the general guidance everywhere but
the answer shape.

The frontmatter is `key: value` lines with comma-separated lists, deliberately not
YAML: a hooks module may import nothing but `claude-code` and its own files, and a
predictable subset is worth more here than the parts of YAML nobody would use. An
unknown field, an unreadable severity and a non-numeric confidence are reported, never
ignored — a silently dropped `sevrity` reads as a lane with no floor, which is a lane
that reports more than it was asked to. For the same reason an unset `confidence` must
not read as `Number('')`, which is `0`, a floor that keeps every guess.

A lane file replaces a lane of its name from a less specific tier and adds one of any
other, and writing it is what turns the lane on. `/backseat setup` prints the roster
that resulted, which is the only reliable answer to what is actually enabled.

### Four tiers, and why location is the scope

A reviewer has two useful reaches: this codebase, and all of them. Expressing that as
a field inside the file would mean a machine-wide reviewer could be declared by a file
sitting in one repository, which is a lie about where it applies. So **where the file
sits is its reach**, and there are four tiers, least specific first:

| Tier | Source | Reach |
| :- | :- | :- |
| `config` | the `lanes` option | the shipped questions |
| `user` | `userLaneDir`, `~/.claude/backseat/lanes` by default | every repository on the machine |
| `project` | `laneDir` in each directory from the home directory down to the session's own | everything under that directory |
| `session` | `/backseat lane <name> <question>` | until the session ends |

The `project` tier is not one directory but the chain of them: `laneDirsFor` walks from
the session's working directory up to the person's home directory, and each
`.backseat/lanes` on the way is its own tier entry, outermost first, so a lane nearer
the work replaces one written for the whole tree. The walk is bounded by the home
directory and by a depth of eight, so a lane directory outside the person's own tree is
never read. Inheritance is what lets a reviewer for a tree of repositories live beside
the tree instead of being copied into every repository in it; without it the only
honest options were duplication or putting a tree's reviewer on the whole machine.

A lane's own relative paths are resolved by `laneRootOf` against the directory holding
its lane directory, not against the session's working directory. An inherited lane
names the documents of the tree it was written beside; resolving those against the
session would make a lane correct in one directory and silently empty in every other,
which is the failure mode hardest to notice because the roster still lists the lane.

### The baseline a turn is reviewed against

`collectDiff` diffs each repository against the commit it was on when the turn first
wrote into it, recorded by `remember` in the `tool.call` hook and looked up by
`refsFor`. The capture has to happen there because it must precede the commit, and it
runs once per repository per turn.

Diffing against the current `HEAD` is the obvious implementation and it is wrong for
any session that commits its own work: the change is in `HEAD`, the diff is empty, and
every such turn is reported as having nothing to review. The panel then looks like it
is working — lanes resolve, the roster prints, the store is written — while reviewing
nothing at all. That failure is silent in both directions, which is what makes it worth
this much machinery.

Two consequences follow. An empty diff is `skipped`, not reviewed: running the lanes
would spend a provider each to be told nothing is wrong and would record a clean review
of nothing. And `turn.complete` consumes a loop's written paths only once it has decided
to review them — when a review is already in flight the paths stay, because taking them
and reviewing nothing loses the turn's work outright.

### The evidence comes from each file's own repository

`collectDiff` resolves every changed path against the working directory, asks git for
the repository holding each distinct directory (`repoRoots`, one `rev-parse` per
directory rather than per file), groups the paths by that answer (`byRepo`) and diffs
each group with `git -C <root>`.

The session's own directory is not assumed to be a repository, because a tree can hold
many repositories side by side with none at its root. A diff taken at such a root
returns nothing, and nothing is the dangerous answer: the lanes still run, on an empty
diff, and report against evidence they never saw. Grouping by the repository that
actually holds each file is what makes the evidence real; a path git places in no
repository is dropped rather than diffed against a neighbouring tree.

`mergeLanes` resolves them in that order and a name defined twice is kept **once**, by
the more specific tier, **whole**. Not blended field by field: a lane that inherited
one tier's instructions and another's question is a reviewer nobody wrote and nobody
can predict. Replacing is also what makes the tiers usable — a repository retunes a
machine-wide lane by writing its own file of that name, and parks one with
`enabled: false`, without editing a file shared by every other repository. Each
replacement is reported, and `/backseat lanes` prints every lane's tier, because "why
is this reviewer running here" must be answerable without reading two directories.

The default for `userLaneDir` cannot live in the manifest: a manifest cannot spell a
home directory, and `$.fs` takes `~` as a literal name rather than resolving it. So
`register` resolves it from `$.env.get('HOME')` — the one environment read in the
module, which `claude plugin validate` lists. A machine with no `HOME` simply has no
machine-wide tier. A missing directory is not reported as a problem: the machine-wide
one does not exist until someone writes a lane into it, and complaining every session
would train people to ignore the report. An unreadable *file* is reported, because
someone meant that one to be a reviewer.

The session tier exists because a lane file answers only half the question. A file is
for the reviewers a repository always wants; `/backseat lane sql Did this add a query
inside a loop?` is for the one a person wants while doing this particular piece of
work, and asking them to write a file and pick a provider for it would be asking the
wrong question. A session lane takes the panel's own provider and confidence floor,
and lives in the same per-session store key as the purpose and the model overrides.

## What the person sets at runtime

Three things are neither configuration nor code, because they change while the work
changes: what the work is *for*, which model to ask, and which reviewer this
particular piece of work wants.

| Set by | Held in | Read by |
| :- | :- | :- |
| `/backseat purpose <text>` | `$.store`, under `state:<sessionId>` | `promptFor`, as a `<purpose_of_this_work>` block in every lane's prompt |
| `/backseat model [<lane>] <model>` | the same key, as `models` keyed by lane name or `*` | `modelFor`, the one place an override is read |
| `/backseat lane <name> <question>` | the same key, as `sessionLanes` | `loadLanes`, as the most specific tier of the roster |

The purpose exists because a diff shows what changed and never what it was supposed
to achieve. Without it the spec lane has to infer intent and then reports its own
inference as drift; with it, the prompt can say that a change serving the stated
purpose is not drift merely for being unexpected.

`modelFor` is deliberately the single reader of `models`, consulted by both `runLane`
and the roster the reports print, so the model a lane is shown to use and the model it
actually asks cannot drift apart.

A session lane is a tier rather than a special case: it goes through `mergeLanes` like
a file does, so it can replace a configured or machine-wide lane of the same name and
the roster reports it as `this session only`. A command that changes the roster calls
`reload`, so the next review and the next report are built from the same read.

## Providers, and what "agnostic" has to mean

`DESCRIPTORS` holds the two CLIs whose flags were read from their own `--help` and
tested. That is not agnosticism — it is two more hard-wired providers. The seam that
makes the claim true is `invocationFromTemplate`: a command line with `{prompt}`,
`{model}` and `{schema}` placeholders, split on whitespace into argv so no shell is
involved and nothing a prompt contains can become a flag. A template with no
`{prompt}` sends it on standard input, and a `{model}` flag whose lane names no model
drops the flag with it rather than handing a CLI `-m ""`.

A template arrives either from the `providers` option, keyed by provider name, or from
one lane's own `command` field. Validation belongs to the lane loader and nowhere
else: only it has read the templates, so only it can tell a template-defined provider
from a typo — and `laneOf` must therefore *not* pre-judge a provider name, or a lane
that a `providers` entry defines perfectly well is dropped before the entry is read.

## Several reviewers of one question

`reviewers` on a lane is expanded by the loader into one lane per reviewer, named
`<lane>:<provider>`, sharing the question, the instructions, the documents and the
`needs`. Expansion rather than a loop inside the run path is what makes the rest of the
engine work unchanged: the waves schedule them, the concurrency limit bounds them, the
parser reads each answer, and `rank` merges what two of them agree on into one finding
carrying both names.

`group` holds the name the expansions share, and it is what `needs` resolves against —
both in `wavesOf`, where a group counts as placed only once every reviewer in it has
been placed, and in `inputsFor`, which matches a result named `<lane>:<provider>`
against an edge naming `<lane>`. Without the group, an edge would reach one arbitrary
reviewer and a reader could run before the slowest of them had answered.

The distinction from `fallback` is the point: reviewers are asked together so their
answers can corroborate each other, and a fallback is a substitute asked only after a
failure. A lane may have both.

## Failover, and what counts as a failure

`withFallback` wraps `runLane`: on a `failed` outcome it runs the lane again with its
`fallback` provider and the `fallbackCommand` the loader resolved, then stamps `via` on
the result.

What counts as failure is the whole design. A lane that answered **clean** has reviewed
the change and found nothing — a complete review, and retrying it would double the cost
of the quiet case, which is the common one. A lane that found something has answered.
Only failure is retried, because its causes are mundane, temporary and silent: a spent
usage limit, an expired sign-in, a binary that is not on the path, a timeout. Each of
those turns a configured reviewer into no reviewer while the roster still lists it.

One retry, never a chain: a second failure is reported with both providers' details
rather than passed to a third. The fallback is resolved and validated at load time like
the provider is, and a fallback naming the lane's own provider, or one with neither an
adapter nor a template, is reported and cleared — a lane that reports a failure is
honest, and one that names cover it does not have is not.

`via` is carried on the result and printed, because a finding produced by the fallback
was judged by a different model than the roster names. Hiding that would make the
roster a claim about what reviewed the code rather than a record of it.

## Bounds

Every bound exists because an unbounded version has a failure that reads as a clean
review or a stalled session:

| Bound | Where | What it prevents |
| :- | :- | :- |
| `maxConcurrency` (1–8, default 2) | `batches` in `review` | a fan-out wider than the provider's rate limit, which turns findings into errors |
| `timeoutMs` (1s–10min, default 120s) | `$.process.run` | a lane that never answers holding the panel open |
| `maxTokens` 8000 | the `claude` provider | the default of 1024 cuts a verdict off mid-finding |
| `DIFF_LIMIT` (120,000 chars) | `fitDiff` | a reviewer reading part of a diff and reporting on it as though it were the whole; the prompt says so when the cut happened |
| `DOC_LIMIT` / `DOC_COUNT` | `fitDocs` | the documents crowding out the diff they are meant to judge |
| `minConfidence` (default 0.6) | `parse` | a guess drawn as a finding |
| `maxCards` (1–4, default 3) | the render hook | a panel taller than the band, with the rest counted rather than lost |
| `everyTurns` | `turn.complete` | a review on every keystroke-sized turn |
| `seen` capped at 400 subjects | `review` | unbounded growth inside the store's 4 MiB budget |

## What the reviewer must not touch

The panel judges the work; it does not join it.

- **The index is never written.** `collectDiff` uses `git diff HEAD` for tracked
  changes and `git ls-files --others` plus `newFileDiff` for new files. The obvious
  alternative, `git add --intent-to-add`, stages paths into the person's staging area,
  and a reviewer that stages a path has edited the work it was asked to judge. A test
  asserts no git call in the review path is a write.
- **Every git call is an argv**, with paths after `--`, so no shell is involved and a
  path that looks like a flag cannot become one.
- **`codex` lanes are pinned to `--sandbox read-only --ephemeral`**; the default `fork`
  provider cannot write at all.
- **The Stop hook fails open.** Its `.catch` returns context, never a hold: a session
  a person cannot finish for a reason the panel could not state is the worse failure.

## Delivery, and both audiences

Under `deliver`, one review reaches two audiences:

- the **person**, as cards above the prompt, with `Fix it` (submits the finding as the
  person's own instruction), `Explain` (a second fork, in plain language), and
  `Dismiss` (drops it and remembers the subject);
- the **model**, as `additionalContext` at the Stop hook, phrased as advisory and
  telling it to verify each finding against the code before acting.

Both carry the instruction that a reviewer can be wrong. A panel whose findings were
obeyed rather than checked would turn three advisory reviewers into three unreviewed
authors.

The two halves are not simultaneous. `classic.Stop` usually fires before the lanes
have answered, and a Stop with nothing to hand over hands over nothing and holds
nothing; those findings reach the model at the next Stop, and the person as soon as
the cards redraw. The alternative — awaiting the lanes inside `turn.complete` — would
hold every turn for the length of a review, which is what `deliver` exists not to do.
A test fires Stop while a lane is still thinking and asserts both that the turn is
free and that no partial verdict is delivered.
