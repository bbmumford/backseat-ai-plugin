# backseat-ai-plugin

A panel of backseat reviewers for Claude Code. After every turn that changes code, a
set of configurable lanes reviews the change and delivers what it found above the
prompt — with buttons that hand a finding to Claude as work, explain it, or dismiss it.

A reviewer can be scoped to one repository, to every repository on the machine, or to
the session you are in right now, and can be put on your subagents' work as well as
your own.

It is a **mod**: a TypeScript hooks module that runs inside Claude Code, not a CLI
wrapper. The findings ride the same delivery channel the built-in "You should know"
mod uses, and carry compliance verdicts instead of trivia.

## What the lanes ask

| Lane | The one question it reviews |
| :- | :- |
| `spec` | Does this change do what the documents that govern it say, and only that? |
| `reuse` | Does this change rewrite behaviour the repository already has somewhere else? |
| `docs` | Which design documents does this change make untrue, and what is the correcting edit? |

Add your own in any of three ways, in rising order of how much you can say:

```
customLanes:  perf|kimi|Did this change add work to a hot path?
a lane file:  .backseat/lanes/perf.md        (frontmatter + standing instructions)
a command:    /backseat lane perf Did this change add work to a hot path?
```

`customLanes` entries are `name|provider|question`, separated by semicolons. A lane
file says everything a lane can say; a command adds one for this session only.

Lanes **cross-link**. With `crossLink` on (the default) they run in two waves: `spec`
and `reuse` first, then `docs` with the earlier findings as evidence — so a rewrite
`reuse` found becomes a document `docs` knows to go and check.

## Providers

Every lane names who answers it. The adapter is a data descriptor, so adding a
provider is an entry in a table, not a branch at the call site.

| Provider | How it runs | Needs |
| :- | :- | :- |
| `claude` (default) | `$.model.complete`, the review as a self-contained prompt | nothing; no second subscription, cannot edit the tree |
| `fork` | `$.model.fork` — a fork of the live conversation | nothing, but see below |
| `kimi` | `kimi -m <model> --output-format text -p <prompt>` | the Kimi CLI installed and signed in |
| `codex` | `codex exec --sandbox read-only --ephemeral --skip-git-repo-check --color never -`, prompt on stdin, with `--output-schema` | the Codex CLI installed and signed in |
| `off` | the lane is configured but never runs | — |

Set one for all lanes with `provider`, per lane with `specProvider`,
`reuseProvider`, `docsProvider`, or per lane in its lane file.

**`claude` vs `fork`.** A fork sees the conversation, which is worth having when the
reviewer should know what the session was *doing*. It also inherits whatever the
session has already talked itself into, which is a real hazard for "does this obey the
spec?", and it has nothing to fork from in a session with no transcript yet — a bare
`/backseat review` in a fresh session fails every fork lane. So `claude` is the
default: the review prompt already carries the diff, the documents and the lane's
instructions, so it needs no conversation at all. A `fork` lane falls back to a
completion when the transcript is cold rather than reporting a reviewer that could not
look.

`codex` is given the answer schema and enforces it itself; the others rely on the
tolerant parser, which reads JSON, a fenced JSON block, a one-line
`severity | file:line | title | fix` form, or the bare word `CLEAN`.

**The answer shape is asked for last.** A provider reads the contract, then a diff and
documents many times its length, and answers against what it read most recently — so a
contract in the middle of the prompt competes with the evidence. A short restatement
closes every prompt.

**Tolerant means tolerant of how a CLI actually answers.** A provider that reasons
aloud quotes the diff in a fence of its own before it answers, so every fenced block is
tried, newest first — taking the first one parses the quotation and reads a real finding
as no answer. `CLEAN` is accepted as a line of its own among the first and last few
lines, since a CLI prints a version banner before the answer and a session or resume
hint after it; a `CLEAN` behind a banner read as a non-answer would be reported as a
broken provider. A bullet or quote marker in front of the JSON is stripped — one
provider answers `• {"verdict":…}`, and insisting the brace comes first reports a
correct finding as an answer with nothing in it. A declared `{"verdict":"clean"}` with
no list is an answer too.

When parsing does fail, the lane's detail **quotes the provider's own last words**,
because without them there is no way to tell a refusal from a sign-in prompt from a
finding in the wrong shape.

`/backseat setup` says a provider is **installed**, not ready: running `--version`
proves the command exists, and nothing more. An expired sign-in or a spent usage limit
appears only when a lane actually runs.

### Any other CLI, without a code change

A provider nobody wrote an adapter for is a template, not a patch. Put it in the
`providers` option as `name = command` entries separated by semicolons, or give one
lane its own `command:` field:

```
gemini = gemini -m {model} -p {prompt}
ollama = ollama run {model}
```

The template is split on whitespace into an argv, so **no shell is involved** and
nothing a prompt contains can become a flag. `{prompt}` becomes the whole prompt as
one argument; `{model}` the lane's model, with the flag dropped when the lane names
none (so no CLI is handed `-m ""`); `{schema}` the answer schema's path. A template
with no `{prompt}` gets the prompt on standard input.

A provider name that is neither a shipped adapter nor a template is reported by
`/backseat setup`, not silently dropped.

## A lane is its question *and* its instructions

The prompt frames the question as the reviewer's **subject**, and says the standing
instructions settle what that subject covers. This is not a nicety. Told to judge a
change "only against that question", a reviewer that spots a defect its instructions
describe but the question's wording misses will reason its way out of reporting it —
and say so while reporting nothing. Every sentence of a lane's instructions is then
dead text unless the question happens to enumerate it.

## Several reviewers, one question

`reviewers` asks the same question of more than one provider **at once**:

```markdown
question: Does this change weaken the confinement contract?
reviewers: codex, kimi
```

The lane becomes one lane per reviewer — `seq:codex`, `seq:kimi` — which run concurrently
in the same wave, and a subject both report is merged into **one** finding naming both,
keeping the worse severity and the better fix. Agreement between two reviewers is
evidence, so it reads as one corroborated card rather than the same problem drawn twice.

A `needs` edge naming the lane reaches every reviewer it expanded into, and a lane that
reads it waits for all of them rather than the first to answer.

This is a different thing from `fallback`, and the two compose. Reviewers are asked
together to corroborate each other; a fallback is a substitute asked only when a
provider failed. Reviewers cost one call each, every turn.

## Failover

A lane can name a `fallback` provider, asked only when its own provider **fails** —
could not be run, exited non-zero, timed out, or answered with no verdict in it. A
spent usage limit, an expired sign-in and a CLI that is not installed all look like
that, and each one silences a reviewer without saying so.

```markdown
provider: codex
fallback: kimi
```

Three rules keep it honest. A **clean** review is a complete answer and is never
retried, so a quiet lane costs one provider, not two. There is **one** retry, never a
chain — if the fallback fails too, both failures are reported together. And the panel
**says which provider answered**: `answered by kimi, its fallback`, because a finding
judged by a different model than the roster names is worth knowing about.

Set it per lane in a lane file, or panel-wide with the `fallback` option. A fallback
that names the lane's own provider, or one with no adapter and no template, is reported
by `/backseat setup` and dropped — a lane that reports a failure is honest, one that
names cover it does not have is not.

### A spent usage limit is not a failure

An account out of quota refuses in the same second it is asked. So that one refusal is
**remembered**, and for the next 15 minutes no lane starts a process for that provider:
it is `skipped`, not `failed`, with the provider's own words — including its reset time —
kept as the lane's note. A lane whose provider *and* fallback are both spent is skipped
once, without either being asked.

When **every** reviewer a turn could ask is spent, the review is abandoned before the
diff is even taken: no git call, no documents read, no prompts built. The panel reports
which account each lane is waiting on and nothing else happens.

```
far-sequence: skipped, 0 finding(s), 0ms — codex and kimi are both at their usage limit
      ERROR: You've hit your usage limit. Try again at 4:42 PM.
```

`skipped` matters here: a reviewer nobody could ask has not approved the change. Reading
it as clean would be the panel vouching for work no reviewer ever saw. After 15 minutes
one lane asks again, and its answer either clears the provider or renews the wait.

### Notes: what a reviewer said that was not a finding

A reviewer that answers in prose, or in a shape the parser does not read, has still said
something. Its words are kept as the lane's **notes** and printed under its row, so an
answer that missed the format is recoverable by hand instead of discarded. A skipped
lane's note is the provider's own explanation.

## What a lane is shown, and when it runs

Two fields, independent of each other and of the question:

```markdown
sees: transcript        # diff (the default) | transcript | both
on:   ask               # turn (the default) | ask
```

`sees: diff` is the change a turn made, which is what every reviewer gets unless
it says otherwise. `sees: transcript` is the session's own history, for a lane
asking what no longer needs to stay in it. Naming both gives one reviewer whose
subject covers the conversation as well as the code — a standing-rules lane can
catch a rule broken in the chat, not just in a file.

`on` is the trigger. A lane that reads the transcript defaults to `ask`, because
its evidence is the whole session rather than the turn: running it every turn
would cost more than the work being reviewed. Set `on: turn` if you want to pay
for that.

A "context cleaner" is therefore not a kind of thing — it's a lane pointed at
different evidence:

```markdown
---
provider: kimi
fallback: off
sees: transcript
on: ask
question: What in this session's transcript no longer needs to stay in it?
---
```

### `/backseat clean`

Asks the transcript-reading lanes now. The transcript is cut into windows that
each fit one question, cut at turn boundaries so no window ever separates a tool
call from its result. Every lane is asked about every window, and is asked of
the provider it names and no other — `runLane` is called directly rather than
through the fallback, because a second opinion from a different model about
which of your own words are disposable is not a substitute for the first.

Each finding names the message index it is about and what supersedes it, and the
run reports itself once:

```
tidy: findings, 3 finding(s), 213726ms
  [tidy/medium] transcript:540  base64 screenshot superseded by its own summary at 542
  [tidy/low]    transcript:349  partial read superseded by the complete read at 358
  [tidy/low]    transcript:11   listing repeated verbatim by the refresh at 30
  [clean/low]   111,457 of 649,958 characters (17%) look reclaimable, across 1 window(s)
```

### What leaves the machine, and what does not

A transcript window goes to the lane's provider, which for `kimi` means a remote
API. A transcript is uncurated — it holds whatever a tool printed, including the
contents of a `.env` a command happened to read. Two controls bound that.

**Secret-shaped values are replaced before anything is sent.** Private key
blocks, JWTs, bearer tokens, AWS/GitHub/Slack/provider keys, credentials inside
a URL, and `api_key:`/`password=`-style assignments become `[redacted]`, with the
name kept beside the value so the line still reads as what it was. The count is
stated in the prompt and on the summary card. The patterns are deliberately
narrow: one that matched ordinary code would hide the evidence the question is
about, which is the worse failure.

**A lane can name the projects it may run in.** Any lane, not just a
transcript-reading one:

```markdown
projects: ~/acme, /opt/work
```

It then runs only when the session's working directory is under one of them.
A lane naming no project runs anywhere, so every lane written before this field
existed behaves exactly as it did. When a lane is held back, `/backseat clean`
says so by name rather than reporting nothing — a reviewer silent for a reason
reads exactly like one that is broken.

Neither control is a guarantee about a remote provider. They bound what is sent;
what to send at all is the choice `projects:` exists to let you make.

### How much one run reads

A transcript of tens of millions of characters makes tens of windows, and each
window is a provider call of minutes. One run asks about the **newest 8 windows**
— the part the session still carries in context — and the summary says how many
of the total that was (`across 4 of 17 window(s)`). Only the tail of a file is
read at all, since sessions reach a gigabyte.

**Nothing is edited.** The cards say what looks reclaimable and where; what to do
about it stays with you. The reclaim figure is counted from the messages the
findings name, not from any total a reviewer states about its own work.

Only the tail of a transcript is read — sessions reach a gigabyte, and reading
one whole would end the session it is trying to help. When that limit is hit the
summary card says so.

## What a finding does

The default is `enforcement: deliver`: findings are **drawn, never blocking**. They
reach two audiences at once — the person sees a card above the prompt, and the model
sees the same findings as `additionalContext` at the Stop hook, so a finding can be
acted on without anyone pressing a button.

Set `enforcement` to `severity` (holds the turn at or above `blockFrom`) or `block`
(any finding holds the turn) to get the hard gate instead.

Silence is the expected answer. Every lane is told so in its prompt, a finding below
`minConfidence` is dropped, a lane that cannot name a file in the diff is dropped, and
a provider that broke is reported as **failed, never as clean** — a reviewer that
could not look must never read as a reviewer that approved.

## Install

```bash
claude plugin marketplace add /path/to/backseat-ai-plugin
claude plugin install backseat@backseat-ai
```

Or load it for one session without installing:

```bash
claude --plugin-dir /path/to/backseat-ai-plugin/plugins/backseat
```

Function hooks are opt-in: a session loads this mod only when
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` is in the **engine process's own** environment.
Enabled in settings with the variable unset, the plugin is registered and never
loaded — no hooks fire and `/backseat` does not resolve. An `env` block in settings
does not supply it, so an editor launched before the variable was set has to be
restarted, not just its session.

### Making a change travel

`claude plugin install` from a directory marketplace **copies** the tree to
`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, and that copy is what
every session runs. Editing the source tree changes nothing, and
`claude plugin update` answers *"already at the latest version"* while the version
string is unchanged — so the running copy can sit frozen while the suite passes
against the tree. To release a change, bump `version` in both
`plugins/backseat/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`,
then:

```bash
claude plugin marketplace update backseat-ai
claude plugin update backseat@backseat-ai
```

`installPath` in `~/.claude/plugins/installed_plugins.json` names the copy actually
loaded; diff that against the tree to see what a session is running. Sessions pick up
a new copy on restart, or with `/reload-plugins`. `--plugin-dir` skips the copy
entirely, which is why it is the right way to test a change before releasing it.

Configure it in `/config`, or in settings under `pluginConfigs`:

```json
{
  "pluginConfigs": {
    "backseat@backseat-ai": {
      "lanes": "spec, reuse, docs",
      "provider": "fork",
      "specDocs": "docs/spec.md, CLAUDE.md",
      "designDocs": "docs/design, ARCHITECTURE.md",
      "enforcement": "deliver",
      "maxConcurrency": 2
    }
  }
}
```

A mod loaded with `--plugin-dir` is keyed `backseat@inline` instead.

Once installed, `claude plugin configure backseat` lists every option and which are
still unset, and `claude plugin configure backseat --values-stdin` saves values from a
JSON object on standard input.

`pluginConfigs` is read from **user or managed settings** only. Passing it through
`--settings` has no effect, so configure the panel with `/config`,
`claude plugin configure`, or `~/.claude/settings.json`. (Plugin *enablement* is
different: `enabledPlugins` in `--settings` does apply, so a single session can turn a
plugin on or off without saving anything.) Lane files need no settings at all, which
is the shortest path to a configured lane — and a machine-wide lane file needs none
either, which is the shortest path to a reviewer that follows you between repos.

## Options

| Option | Default | What it does |
| :- | :- | :- |
| `lanes` | `spec, reuse, docs` | which lanes review a turn |
| `provider` | `claude` | who answers a lane that names nobody |
| `fallback` | *(empty)* | who to ask when a lane's provider fails; a lane file's `fallback` overrides it |
| `claudeModel` | `sonnet` | the model a `claude` lane asks; a lane file's `model` and `/backseat model` override it |
| `providers` | *(empty)* | extra CLIs as `name = command` templates, semicolon separated |
| `specProvider` / `reuseProvider` / `docsProvider` | `default` | per-lane override |
| `enforcement` | `deliver` | `deliver`, `severity`, or `block` |
| `blockFrom` | `high` | under `severity`, the lowest severity that holds a turn |
| `specDocs` | *(empty)* | documents the `spec` lane reads before judging |
| `designDocs` | `docs/design, docs, DESIGN.md, ARCHITECTURE.md` | documents the `docs` lane keeps true |
| `customLanes` | *(empty)* | quick lanes, `name\|provider\|question`, semicolon separated; a lane file is the fuller form |
| `laneDir` | `.backseat/lanes` | where this repository's lane files live |
| `userLaneDir` | *(empty → `~/.claude/backseat/lanes`)* | where the lane files that apply to every repository live, absolute |
| `crossLink` | `true` | honour `needs`, so a lane reads the lanes it names |
| `everyTurns` | `1` | review at most once every N code-changing turns |
| `maxConcurrency` | `2` | lanes in flight together |
| `maxCards` | `3` | findings drawn at once; the rest are counted |
| `timeoutMs` | `300000` | how long a lane may take before it is abandoned; a reviewing CLI is slow and variable, and the panel never holds a turn |
| `minConfidence` | `0.6` | findings below this are dropped |
| `debug` | `false` | draw a row per lane with its outcome, latency and detail |

## Commands

| Command | What it does |
| :- | :- |
| `/backseat` | Every lane's outcome from the last review, and the findings still open |
| `/backseat review [--base <ref>] [--lanes a,b]` | Review now instead of waiting for the next turn that changes code. `--base` diffs against a ref rather than the working tree; `--lanes` narrows the run. Runs in the foreground and prints the findings |
| `/backseat setup` | Whether each provider a lane names can actually be reached, the lane roster as it resolved, the order the lanes will run in, which documents were found, and anything wrong with a lane file. This is the answer to "why did nothing happen" |
| `/backseat lanes` | The roster and the purpose, without probing a provider — the cheap, frequent question "what is configured" |
| `/backseat purpose <text>` | What this work is for. Every lane is told it from here on. `/backseat purpose` reads it back, `--clear` forgets it |
| `/backseat model <model>` | Change the model every lane asks |
| `/backseat model <lane> <model>` | Change one lane's model; `default` undoes it |
| `/backseat lane <name> <question> [--agents]` | Add a reviewer for this session alone. `--agents` also puts it on every subagent's turn |
| `/backseat lane <name> --clear` | Remove it. `/backseat lane --clear` removes them all; `/backseat lane` lists them |
| `/backseat cancel` | Stop the panel waiting on a review in flight and discard its answers. A provider subprocess already started runs to its own timeout — this cancels the panel, not the child |
| `/backseat help` | The above |

The purpose, the model overrides and the session lanes are kept in the store under a
key of the session's own, so they survive a reload and never collide with another
session.

## Purpose: what the work is for

A diff shows what changed. It never shows what the change was *supposed* to
achieve — so a reviewer without that guesses at intent and reports its guess as
drift. Tell it:

```
/backseat purpose Add caching to /ask without changing its response shape
```

Every lane then gets a `<purpose_of_this_work>` block, with the instruction that a
change serving that purpose is not drift merely because it is not what the reviewer
would have done, and a change that quietly does something else is. This is the
cheapest way to stop the `spec` lane inventing a specification when the repository
has no document for the work in hand.

## Merging: one problem, one card

Two lanes asking different questions reach the same duplicated function from
different directions. Drawing that twice makes the panel look like it found two
problems, so findings about the same **subject** — the file plus the `reference`
they name — merge into one card headed `backseat · spec + reuse`.

A merge keeps the worst severity and the highest confidence (agreement between
reviewers is evidence, and the panel should not round it down), and fills a field
the leading finding left empty from the other, so a terse reviewer and a thorough
one about the same subject produce one complete finding. A reviewer that leaves
`reference` empty falls back to its title, and two different wordings are then two
subjects — which is the cost of the empty field, and why the answer schema requires
it.

A flag a subcommand does not take is reported, never silently ignored.

## Lane files: giving a reviewer instructions

A lane's *question* fits in a setting. The standing instructions that make a reviewer
useful on **your** repository — which directories are generated, what your team counts
as a duplicate, which paths are hot — do not. Those go in a lane file, under `laneDir`
(`.backseat/lanes` by default), beside the code they are about:

```markdown
---
provider: kimi
model: kimi-k2-thinking
question: Did this change add work to a hot path?
docs: docs/perf-budget.md
needs: reuse
severity: high
confidence: 0.8
enabled: true
---
Treat anything under `src/render/` as a hot path. A finding needs a named caller
and an argument about how often it runs. Generated files under `gen/` are not
yours to judge.
```

The body is the reviewer's standing instructions, and it is placed above the output
contract in the prompt, so it outranks the general guidance everywhere except the
answer shape.

| Field | Effect |
| :- | :- |
| `name` | the lane's name; defaults to the filename |
| `provider`, `model` | who answers this lane, and with which model |
| `command` | a command template for a CLI with no adapter, instead of naming a `providers` entry |
| `question` | the one thing it reviews. **Required** — without it the file defines no lane |
| `docs` | documents this lane reads on top of the shared ones |
| `needs` | the lanes whose findings it is given as evidence, which also orders the run |
| `severity` | drop this lane's findings below this severity |
| `confidence` | this lane's own confidence floor |
| `agents` | `true` also reviews each subagent's own turn; the default is the main loop only |
| `fallback` | the provider to ask when this lane's own provider **fails** |
| `enabled` | `false` parks the lane without deleting the file — and parks a lane of the same name from a less specific tier |

A lane file **replaces** a lane of the same name from a less specific tier and **adds**
one of any other name. Writing the file is what turns the lane on, so a file-defined
lane runs whether or not `lanes` names it; `enabled: false` is how you park one.
Unknown fields, a bad severity, a non-numeric confidence and an `agents` that is
neither `true` nor `false` are all reported by `/backseat setup` rather than silently
ignored — a misspelled `sevrity` would otherwise read as a lane with no floor.

## How far a reviewer reaches

A reviewer has two useful reaches, and **where the file sits is which one it has**.

| Tier | Where | Reaches |
| :- | :- | :- |
| options | `/config`, user settings | the lanes named in `lanes`, with the shipped questions |
| machine-wide | `userLaneDir`, `~/.claude/backseat/lanes` by default | every repository on this machine |
| the tree | `laneDir` in any directory **above** the session, up to your home directory | everything under that directory |
| this repository | `laneDir`, `.backseat/lanes` by default | this codebase only |
| this session | `/backseat lane <name> <question>` | until the session ends |

**Lane directories are inherited.** Every directory from your home directory down to
the session's own may hold a `.backseat/lanes`, and all of them are read, nearest last.
A reviewer written for a whole tree of repositories therefore lives beside the tree
instead of being copied into each repository in it. `/backseat setup` prints every
directory it looked in and how many lanes came out of each.

A lane's `docs` are resolved against **the tree the lane was written for** — the
directory holding its lane directory — not against the session. So `docs: platform/design`
in a lane beside a tree means that tree's design folder, and still means it when the
session is three repositories down. Resolved against the session instead, an inherited
lane would silently find nothing everywhere but one directory.

The order is the precedence. A name defined in two tiers is kept **once**, by the more
specific one, **whole** — not blended field by field, because a half-overridden
reviewer is one nobody wrote. That is how a repository retunes a machine-wide lane,
and `enabled: false` in a project file is how it parks one without editing the
machine-wide file. `/backseat lanes` prints each lane's tier, so "why is this reviewer
running here" always has an answer.

Reviewers about *how you write code* belong in the machine-wide tier, since they are
not about any one codebase:

```markdown
---
question: Does this change follow the patterns this codebase is already written in?
agents: true
---
Name the file and line that establishes the pattern you are measuring against. A
pattern held by one call site is not a pattern. Judge the shape of the code, not the
problem it solves — another lane has that question.
```

Save that as `~/.claude/backseat/lanes/patterns.md` and it reviews every repository
you open.

## Agents' work

`agents: true` in a lane file, or `--agents` on a session lane, puts a reviewer on
**each subagent's own turn** as well as the main loop's. It is off by default, because
most reviewers are about the work you asked for and a subagent's turn ends mid-task —
but a coding-pattern reviewer is exactly the case for turning it on, since a pattern
is as wrong in delegated work as in the main loop's.

What a subagent wrote also **rolls up**: it is reviewed again at the end of the turn
that delegated it, by the whole roster. So a turn that delegates all its editing is
still reviewed, and `seen` keeps the roll-up from drawing a finding an agent lane
already drew.

This replaced a defect. Every hook sees a subagent's turn, and the panel kept one
shared list of what a turn wrote — so whichever turn ended first carried off the
other's evidence, and a subagent finishing mid-task would consume the files the main
turn was about to be reviewed on. What each loop wrote is now keyed by its `agentId`.

## Cross-linking

`needs` is the cross-link, and it is a named edge rather than a broadcast: a lane is
given the findings of exactly the lanes it names, and nothing else. Because a lane
cannot read findings that do not exist yet, `needs` also derives the run order — the
waves are a topological sort of the graph.

The shipped lanes are `spec` and `reuse` with no needs, and `docs` needing both. A
lane that needs a lane you have turned off is not stranded; a `needs` cycle still
runs, in one final wave, seeing none of each other's findings. `crossLink: false`
flattens everything into one wave where no lane reads any other.

## How it works

```
tool.call (Edit/Write/NotebookEdit)   →  record the files, keyed by the loop that wrote them
turn.complete                          →  start the review; the turn is never held
  ├ whose turn? main → every lane; a subagent's → the `agents: true` lanes
  ├ a subagent's files also roll up to the turn that delegated them
  ├ git diff HEAD + ls-files --others  →  the evidence (the index is never written)
  ├ read specDocs / designDocs         →  the documents, handed over in full
  ├ waves from each lane's `needs`     →  $.model.complete, a fork, or a read-only CLI
  └ each lane gets the findings of the lanes it names
                                       →  parse, drop guesses, dedupe by subject, rank
                                       →  merge what two lanes agree on
ui.render{AbovePrompt}                 →  cards: [Fix it] [Explain] [Dismiss]
classic.Stop                           →  additionalContext, or a hold under severity/block
```

## What a turn's review covers

The trigger is the **turn**, never a commit. Every turn that changes code is reviewed by
the whole roster, and the diff covers both halves of what that turn did:

| The turn | What the review sees |
| :- | :- |
| edited files and left them | the working-tree changes |
| edited and committed them | the commits it made, via the baseline below |
| both | both |
| changed no code | nothing — no review runs |

## A turn that commits its own work

The diff is taken against **the commit each repository was on when the turn first wrote
to it**, not against the current `HEAD`. A session that commits as it goes — which is
how a disciplined one works — leaves nothing for a diff against `HEAD` to find: the work
*is* `HEAD`. Reviewing against `HEAD` reports every such turn as having nothing to
review, so the panel stays silent while appearing to work.

The baseline is read in the `tool.call` hook, because it has to be read before the
commit happens, and once per repository per turn: one `git rev-parse --show-toplevel
HEAD` answers both the root and the commit.

Two related rules. **No diff means no review** — the lanes are reported as `skipped`
rather than run, because asking a provider about an empty diff spends a call to be told
nothing is wrong and records a clean review of nothing, which reads exactly like a
working panel that found your code faultless. And when a review is already in flight,
the turn's evidence is **kept rather than consumed**, so it is reviewed with the next
turn's instead of being lost.

## Trees of repositories

The evidence is gathered from **each changed file's own repository**, not from the
session's directory. For every directory a change touched, the panel asks git which
repository holds it, groups the changed paths by that answer, and diffs each group
inside its own repository.

This is what makes the panel work in a directory holding many repositories side by
side with none at the root — and that layout is also why it matters: a diff taken in
the session's own directory there sees nothing, so the lanes would run on an empty
diff and report on evidence they never had. A file git reports no repository for
contributes nothing rather than a diff of whichever tree was nearby.

`/backseat review` asked by hand still needs a repository to diff against, and says so
plainly when the directory is not one, rather than reporting that nothing changed.

A finding's identity is its **subject** — the file, and the `reference` it names (the
spec it contradicts, the code it duplicates, the document it falsifies) — never its
wording, never its line number, and **not the lane that raised it**. An edit above a
finding moves it without changing it, and a reviewer rewords a standing finding on
every turn; keying on the subject is what stops either from becoming a second card.
Leaving the lane out is what lets `rank` merge two reviewers who reached one problem
from different questions, and what makes a dismissal stick whichever lane raises it
next.

## Verify it

From `plugins/backseat`:

```bash
claude plugin validate . --strict   # the manifest, and the events and calls the module makes
claude plugin test                  # 163 tests, no session, sign-in, or network
./node_modules/.bin/tsc -p .        # against the declarations your build wrote
```

The declarations under `.claude-plugin/types/` are written by Claude Code each time it
loads the plugin from a folder, so load it once before running `tsc`.

## Where it came from

It was built from three sources. `docs/review/` holds a line-by-line review of the two
that are public:

| Source | What it contributed |
| :- | :- |
| [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) | the structured verdict schema, the Stop-gate contract, and the provider-coupling seam list that made provider-agnosticism concrete |
| [`linxule/kimi-plugin-cc`](https://github.com/linxule/kimi-plugin-cc) | the multi-reviewer fan-out, its bounds, and the read-only safety posture — plus the gap this plugin fills, since its swarm delegates aggregation to the provider and keeps no per-reviewer attribution |
| `cc-plugin-you-should-know@builtin` | the delivery channel itself: cards above the prompt, submit-as-prompt, per-subject dedupe, and the discipline that silence is the expected answer. Its `turn.step` trigger and its `agentId` bail-out were **not** taken — this panel judges finished turns, and reviews subagents' turns rather than ignoring them |

The built-in mod ships inside Claude Code and has no public repository; what this
plugin took from it is its design, set out in `docs/design/backseat-architecture.md`.

## Known limits

- **The model-facing half of a delivery can be one turn late.** The review is started
  at `turn.complete` and not awaited, so `classic.Stop` often runs before the lanes
  answer; when it does it hands over nothing and holds nothing, and those findings
  reach the model at the next Stop. The person sees them sooner, as soon as the cards
  redraw. A test covers this ordering. Awaiting the lanes instead would hold every
  turn for the length of a review, which is the thing `deliver` exists not to do.
- A **non-interactive** `claude -p` run can exit before the lanes answer at all.
  Interactive sessions are the target.
- The `fork` provider inherits the conversation's context, including a wrong premise
  it has already accepted. The governing documents are therefore read from disk and
  handed over in full rather than left to the fork's account of them.
- A `kimi` lane runs under that CLI's own approval behaviour; `codex` lanes are pinned
  to `--sandbox read-only`. The default `fork` provider cannot write at all.
- **A subagent's own writes are not covered by the test suite.** The testing kit's
  `$.tool.call` takes no `agentId`, so a test cannot make an edit *as* a subagent. The
  suite covers the rest at the hook level — that a subagent's turn does not carry off
  what the main loop wrote, and that a machine-wide lane file is read and reaches the
  roster — and the lane selection itself (`lanesForTurn`) is covered as a pure
  function. The roll-up of a subagent's own writes is exercised live, not in the suite.
- Built and verified against Claude Code 2.1.273. Mods are documented as 2.1.287+;
  every event, method and render site this mod uses was probed against the installed
  build with `claude plugin validate` and exercised with `claude plugin test`.
