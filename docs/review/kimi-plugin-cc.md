# Line-by-line review: `kimi-plugin-cc` (v2.0.7)

Reviewed tree: `_reference/kimi-plugin-cc` at the cloned upstream HEAD. All citations are
`path:line` against the **TypeScript sources under `runtime/`**, not `dist/`. `runtime/vendor/`
is covered by a one-line note each (§9).

Scale: 19,293 lines of TS under `runtime/` (excl. vendor), 11 slash commands, 7 agents,
1 Claude hook, 12 Codex skills, 1,013 lines of dev tooling under `scripts/`.

Shape in one sentence: **the plugin is a job-store-backed subprocess wrapper around
`kimi -p --output-format stream-json`, whose entire safety story is one `PreToolUse` hook that
the plugin installs into the *provider CLI's own* config file and re-verifies byte-exactly before
every spawn.** Everything else — commands, agents, swarm, worktrees, provenance — hangs off that.

---

## 1. Capability inventory

### 1.1 Entry points

| Surface | File | Mechanism |
|---|---|---|
| Claude slash commands | `commands/*.md` | Markdown prompt tells the model to shell out to `${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh <subcommand> <args>` |
| Claude subagents | `agents/*.md` | `tools: Bash`, `model: sonnet`; same shell-out |
| Claude Stop hook | `hooks/hooks.json:3-13` | `command: ${CLAUDE_PLUGIN_ROOT}/scripts/review-gate-hook.sh`, `timeout: 10` |
| Codex skills | `plugins/kimi-codex/skills/*/SKILL.md` | Generated; same shell-out via `PLUGIN_ROOT` |
| Shell shim (commands) | `scripts/companion.sh:13-38` | Resolves `CLAUDE_PLUGIN_ROOT`→`PLUGIN_ROOT`→`dirname $0/..`; gates Node ≥ 22.5; `cd $CLAUDE_PLUGIN_ROOT && exec node dist/companion.js "$@"` |
| Shell shim (Stop) | `scripts/review-gate-hook.sh:32` | Same dance, `exec node dist/hooks/review-gate-stop.js` |
| Runtime dispatcher | `runtime/companion.ts:32-120` | `switch (command)` over `setup \| review \| task \| ask \| status \| result \| cancel \| replay \| repair-sessions \| worker` |

Note `commands/*.md` all carry `disable-model-invocation: true` (e.g. `commands/swarm.md:4`) — slash
commands are human-only; model dispatch happens exclusively through `agents/*.md`.

### 1.2 Commands → runtime modules → flags

| Command file | companion argv | Implementing module | Flags (parser) |
|---|---|---|---|
| `commands/setup.md` | `setup [...]` | `runtime/commands/setup.ts:138` (`runSetup`), `runtime/commands/models.ts:19` (`--models`) | `--check`, `--uninstall`, `--all`, `--enable-review-gate`, `--disable-review-gate`, `--models [--json]` — `setup.ts:184-247` |
| `commands/review.md` | `review [...]` | `runtime/commands/review.ts:65` (`runReview(…, "review")`) | `--base <ref>`, `-m/--model` + trailing focus; `--background`/`--wait` parsed then **rejected** `review.ts:71-77` |
| `commands/challenge.md` | `task challenge [...]` | same `runReview(…, "challenge")` via `companion.ts:70-74` | identical to review |
| `commands/ask.md` | `ask [...]` | `runtime/commands/ask.ts:73` (`runAsk`) | `--background`, `--wait`, `--fresh`, `-r`, `--resume <id>`, `-m/--model` — `parsing.ts:413-532` |
| `commands/rescue.md` | `task rescue [...]` | `runtime/commands/rescue.ts:72` (`runRescue`) | same set as ask — `parsing.ts:551-667` |
| `commands/pursue.md` | `task pursue [...]` | `runtime/commands/pursue.ts:154` (`runPursue`) | `--budget <dur>`, `--turns <N>`, `-m/--model` — `parsing.ts:314-402` |
| `commands/swarm.md` | `task swarm [...]` | `runtime/commands/swarm.ts:209` (`runSwarm`) | `--write`, `--budget`, `--cap <N>`, `--max-concurrency <N>`, `-m/--model` — `parsing.ts:154-246` |
| `commands/status.md` | `status [...]` | `runtime/commands/status.ts:10` | `[<job-id>] [--type …]` — `parsing.ts:669-720` |
| `commands/result.md` | `result [...]` | `runtime/commands/result.ts:11` | `[<job-id>] [--type …] [--json]` |
| `commands/cancel.md` | `cancel [...]` | `runtime/commands/cancel.ts:12` | `[<job-id>]` (`--type`/`--json` parsed but `--json` ignored) |
| `commands/replay.md` | `replay <job-id>` | `runtime/commands/replay.ts:58` | exactly one positional, `replay.ts:59-66` |
| *(no command file)* | `repair-sessions [...]` | `runtime/commands/repair-sessions.ts:28` | `--apply`, `--all` — companion-only, no slash command, no Codex skill |
| *(no command file)* | `worker <rescue\|ask> <job-id>` | `runtime/commands/worker.ts:6` | internal; prompt arrives base64 in env |

`--budget` accepts `30m`/`1h`/`90s`/bare-minutes, hard-capped at 24 h (`parsing.ts:276-307`:
`MAX_DURATION_MS`, rejects rather than clamps). `--cap`/`--max-concurrency` require strict positive
integers (`parsing.ts:255-264`) because upstream's resolver *throws* on anything else.

Unknown flag-shaped tokens **hard-fail** `INVALID_ARGS` in every parser (`parsing.ts:15-24`
`looksLikeFlag`, used at `parsing.ts:224-230`, `382-388`, `493-499`, `628-634`, `763-774`);
`--thinking`/`--no-thinking` are explicitly rejected as removed (`parsing.ts:40-50`).

### 1.3 Agents → commands

| Agent | `color` | Wraps | Dispatch gate (prose) |
|---|---|---|---|
| `agents/kimi-ask.md` | cyan | `companion.sh ask` | narrative answer, not diff review |
| `agents/kimi-review.md` | cyan | `companion.sh review` | single working-tree/branch diff |
| `agents/kimi-challenge.md` | yellow | `companion.sh task challenge` | adversarial design pushback |
| `agents/kimi-rescue.md` | magenta | `companion.sh task rescue` | **proactive** handoff allowed (`kimi-rescue.md:28-31`) |
| `agents/kimi-pursue.md` | red | `companion.sh task pursue` | requires explicit hands-off autonomy intent |
| `agents/kimi-swarm.md` | green | `companion.sh task swarm` | requires many targets **AND** explicit fan-out intent |
| `agents/kimi-swarm-write.md` | red | `companion.sh task swarm --write` | requires many **disjoint write** targets AND fan-out intent |

Every agent repeats a verbatim "Model selection" block and a verbatim "If the companion refuses with
a hook error" retry protocol (e.g. `agents/kimi-review.md:60-82`) — the same text is also emitted at
runtime by `runtime/hooks/install.ts:279-287` (`hookRefusalRetryProtocol`), so the contract lives in
two places by design.

### 1.4 Hooks (two completely different kinds)

1. **Claude Stop hook** — declared in `hooks/hooks.json`, implemented in
   `runtime/hooks/review-gate-stop.ts:7-19` → `runtime/commands/review-gate.ts:65`. Opt-in
   (`runtime/config.ts:9-11` defaults `reviewGateEnabled: false`).
2. **Provider-side `PreToolUse` hook** — *not* a host hook. `/kimi:setup` writes a managed
   `[[hooks]]` block into `~/.kimi-code/config.toml` (`runtime/commands/setup.ts:1006-1040`) whose
   `command` spawns `dist/hooks/approval-hook.js` (`runtime/hooks/approval-hook.ts`). This is the
   load-bearing safety control; §2e/§2f.

### 1.5 What this plugin has that a Codex-style (`codex-plugin-cc`-shaped) plugin does not

- **`ask`** — free-form prose Q&A as a *first-class job* with session resume (`-r`, `--resume <id>`,
  `--fresh`), background detach, and its own SQLite lineage (`commands/ask.ts:349-430`).
- **`challenge`** — a second read-only persona over the same diff payload, differing only in the
  prompt preamble (`commands/review.ts:256-263`) and the hook label.
- **`pursue`** — autonomous multi-turn goal mode. Prompt is literally `/goal <objective>`
  (`commands/pursue.ts:121-126`); terminal outcomes are decoded from **exit codes**
  (`commands/pursue.ts:102-113`: 0=complete, 3=blocked, 6=paused) and reported as status, not error.
- **`swarm`** — read-only parallel fan-out through the provider's own `AgentSwarm` tool, with a hard
  peak-concurrency ceiling and a soft total-count hint (§3.2).
- **`swarm --write`** — write fan-out confined to an ephemeral `git worktree` off HEAD, returning a
  `.patch` the plugin never applies (`commands/swarm.ts:314-443`).
- **`replay`** — re-render a finished job from its own NDJSON diagnostics log
  (`commands/replay.ts:123-227`), independent of the provider.
- **`repair-sessions`** — read-only SQLite scan + provider-session-metadata repair
  (`commands/repair-sessions.ts`), the only module that opens the job DB *read-only*
  (`repair-sessions.ts:80-87`) specifically to avoid running migrations.
- **`models`** — offline, credential-scrubbing projection of the provider's `config.toml`
  (`commands/models.ts:19-117`), with an explicit field allowlist and a hard rule never to serialize
  parse errors (`models.ts:114-117`).

---

## 2. Architecture map

### 2a. `kimi-engine.ts` + `cli-client.ts`: how the provider CLI is invoked, streamed, parsed

**Plan-then-spawn.** No command spawns the CLI directly. Each first builds an immutable
`KimiExecutionPlan` (`runtime/kimi-engine.ts:47-58`) via `prepareKimiExecutionPlan`
(`kimi-engine.ts:199-289`):

1. Refuse the ambient master experimental flag (`kimi-engine.ts:171-191`,
   `assertNoUnsafeExperimentalSelector`).
2. Resolve the binary name + prefix argv from env (`runtime/kimi-command.ts:36-76`), refusing any
   *reserved* provider flag in the prefix (`kimi-command.ts:87-100`: `-r`, `--resume`, `-C`,
   `--continue`, `-p`, `--output-format`, `--plan`, `--yolo`, `-m`, `--add-dir`, `-V`, `-h`, …).
   The prefix is explicitly "a launcher shim only".
3. **Resolve the binary to an exact realpath** by walking `PATH` with `access(X_OK)` then
   `realpath()` (`kimi-engine.ts:818-859`). The *resolved absolute path* is what gets persisted.
4. Probe `<bin> [prefix] --version` (`runtime/kimi-version-probe.ts:1288-1377`), parse one semver
   token (`kimi-version-probe.ts:1389-1406`).
5. Select engine: exact-version membership in `NATIVE_V2_CERTIFIED_VERSIONS`
   (`kimi-engine.ts:104-113` — `0.42.0`, `0.43.0`, `0.43.1`, `2.0.0`, `2.0.1`, `2.0.2`, `2.1.0`,
   `2.1.1`) ⇒ `native-v2`; otherwise `legacy-v1`, which must satisfy both a per-operation minimum
   (`kimi-engine.ts:85-94`) and minor-level membership in `KIMI_TESTED_MINORS`
   (`kimi-version-probe.ts:59`, 0.1–0.41).
6. For `native-v2`, run `assertNativeV2Preflight` (`runtime/native-v2-preflight.ts:434-501`).
7. Freeze the plan; `persistedExecutionPlanFields` (`kimi-engine.ts:331-346`) writes
   `kimi_command`, `kimi_prefix_args` (JSON), `kimi_version`, `intended_engine`,
   `plan_certification`, `safety_profile` into the job row.

A detached worker reloads the plan from SQLite (`kimi-engine.ts:358-420`
`executionPlanFromPersisted`) and **re-validates** it at the spawn boundary
(`kimi-engine.ts:291-316` `assertExecutionPlanMatchesSpawn` → `assertPlanCertification`
`kimi-engine.ts:702-740`). A forged row cannot upgrade a plan to `native-v2` without the safety
profile, nor use `test-bypass` without `KIMI_PLUGIN_CC_SKIP_VERSION_PROBE=1` present *at spawn*.

**The spawn.** `runCliPrompt` (`runtime/cli-client.ts:211-911`):

- argv assembly, `cli-client.ts:1049-1074`: `[...prefixArgs, "--output-format", "stream-json",
  ("-r" sessionId)?, ("-m" model)?, ("--skills-dir" d)*, "-p", prompt]`. The prompt is a **separate
  argv entry**, never interpolated into a shell string (`cli-client.ts:1069-1072`).
- env assembly, `cli-client.ts:1076-1110`: overlays `KIMI_CODE_LEGACY_FLAG=1` when the plan is
  legacy, `KIMI_CODE_NO_AUTO_UPDATE=1`, `KIMI_PLUGIN_CC_OPERATION`, `KIMI_CODE_HOME`,
  `KIMI_PLUGIN_CC_CMD` (the hook label), optional
  `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY`, optional `KIMI_PLUGIN_CC_WORKSPACE_ROOT`.
- `spawn(..., { stdio: "pipe", detached: process.platform !== "win32" })`
  (`cli-client.ts:276-283`) — a fresh POSIX process group so cancellation can reach descendants.
- An `error` listener is pre-attached *before* the promise body to survive a Bun/Node async
  `error` emission (`cli-client.ts:303-308`), then atomically swapped (`cli-client.ts:784-798`).
- stdin is ended immediately (`cli-client.ts:896`); `kimi -p` reads the prompt from argv.

**Streaming + parsing.** `runtime/stream-json.ts` is a stateful NDJSON line parser
(`stream-json.ts:349-391`). `parseLine` (`stream-json.ts:393-436`) routes by `role`:

- `assistant` → `AssistantRecord` (`stream-json.ts:563-598`), content and/or validated `tool_calls`.
- `tool` → `ToolResultRecord` (`stream-json.ts:613-631`).
- `meta` → one of `session.resume_hint`, `turn.step.retrying`, `system.version`
  (`stream-json.ts:482-561`); unknown `meta.type` → malformed/diagnostic.
- role-less `{type:"goal.summary"}` → dedicated out-of-band channel (`stream-json.ts:438-480`).
- any other non-empty string role → `unknownRecord`, tolerated out-of-band (`stream-json.ts:427-429`).
- else → `malformedLine` (diagnostics only).

`consumeOutcomes` (`cli-client.ts:375-499`) is the real state machine. It filters every `meta` out
of `records[]`, captures session id first-announce-wins, and enforces a **marker-first contract**:
on a `native-v2` plan, *nothing* may precede `system.version`
(`cli-client.ts:365-373` `requireMarkerBeforeOutput`, applied to unknown roles, goal summaries,
other metas, assistant/tool records, malformed lines, and even a clean exit at
`cli-client.ts:822-829`). Mismatches raise `CLI_ENGINE_PROVENANCE_MISMATCH` and **tear the process
tree down before resolving** (`cli-client.ts:706-735`).

Prose is reassembled by concatenating only `role === "assistant"` `content` strings, in arrival
order, with no per-fragment trimming (`runtime/commands/cli-helpers.ts:33-41`).

**Budget.** `runCliPromptWithBudget` (`cli-client.ts:973-1027`) owns an `AbortController`, links the
caller's signal, and on expiry aborts rather than racing a rejection — so teardown always completes
before the caller sees `RESPONSE_TIMEOUT`. Budgets: ask 15 min, review/challenge 30 min, rescue
30 min, pursue 45 min default, swarm 30 min default, review-gate **8 s**
(`runtime/kimi-timeouts.ts:22-64`).

**Cancellation.** `teardownChildTree` (`cli-client.ts:648-703`): snapshot descendant *identities*
(pid + PGID + start token) with a 1 s bound, SIGTERM the group and every revalidated identity, wait
`escalationMs` (1500 ms), SIGKILL, then a 500 ms quiescence check. `runtime/process-tree.ts` does
the identity work: `/proc/<pid>/stat` on Linux, one batched `ps -axo pid=,ppid=,pgid=,state=,lstart=`
elsewhere (`process-tree.ts:291-318`), with a two-snapshot cross-check so a PID-reuse window cannot
promote an unrelated process into the kill set (`process-tree.ts:180-205`).

### 2b. The Stop review gate

```
Claude Stop event
 └─ hooks/hooks.json  (timeout 10s)
     └─ scripts/review-gate-hook.sh        (Node ≥22.5 gate, cd plugin root)
         └─ dist/hooks/review-gate-stop.js  ← runtime/hooks/review-gate-stop.ts
             readFileSync(0,"utf8") → JSON.parse → runReviewGateStopHook
                 └─ runtime/commands/review-gate.ts:65
```

`runReviewGateStopHook` (`review-gate.ts:65-157`) skip ladder, each returning
`{systemMessage: "review-gate skipped: …"}`:

1. `hook_event_name !== "Stop"` ⇒ throw `INVALID_HOOK_EVENT` (`review-gate.ts:69-75`).
2. plugin-data resolution failure ⇒ skip (`review-gate.ts:77-85`).
3. `reviewGateEnabled === false` ⇒ skip `"disabled"` (`review-gate.ts:89-91`).
4. `payload.stop_hook_active` ⇒ skip (anti-recursion, `review-gate.ts:93-95`).
5. no last assistant message (payload field, else transcript scan) ⇒ skip
   (`review-gate.ts:107-112`, scanner at `review-gate.ts:409-444`).
6. `verifyHookInstalled` false ⇒ skip, explicitly **"allowing stop without invoking Kimi"**
   (`review-gate.ts:114-126`).

Then `executeReviewGate` (`review-gate.ts:163-303`) creates a `review_gate` job
(`pid: null`, `thinking: false`), writes the invocation-log header *before* the job row
(`review-gate.ts:199-206`, deliberate: a disk failure must not orphan a running row), runs the
8 s-budgeted prompt with `commandLabel: "review_gate"`, re-checks the persisted status to lose a
cancel race (`review-gate.ts:278-285`), writes the artifact, and returns the parsed verdict.

Decision mapping (`review-gate.ts:138-151`) — this is the whole gate contract:

| Verdict | Hook output | Effect |
|---|---|---|
| `decision === "BLOCK"` **and** `confidence === "high"` | `{decision: "block", reason: buildBlockReason(output)}` | Claude must take another turn |
| `decision === "BLOCK"`, any lower confidence | `{systemMessage: "Kimi review gate noted concerns but allowed stop: <summary>"}` | advisory only |
| `decision === "ALLOW"` | `{}` | silent allow |
| any thrown error | `{systemMessage: buildWarningMessage(error)}` (`review-gate.ts:356-399`) | **fail-open** |

`buildBlockReason` (`review-gate.ts:331-341`) renders at most 5 issues as
`- [severity] title: body`.

### 2c. Swarm (`runtime/commands/swarm.ts`) — the most important file

Two modes behind one entry point (`swarm.ts:209-223`): `parsed.write ? runWriteSwarm : runReadSwarm`.

**The fan-out is not implemented by the plugin.** There is no plugin-side agent pool, no
aggregation code, no per-reviewer process. The plugin spawns **one** `kimi -p` coordinator and asks
the *provider's own* `AgentSwarm` tool to fan out; the provider consolidates. The plugin's
contribution is (i) the prompt, (ii) the hook label that constrains every child, (iii) two
independent bounds, (iv) for write mode, an ephemeral worktree + patch capture.

**Read mode** (`swarm.ts:226-304`):

1. `resolvePluginPaths` + `ensurePluginPaths`, `resolveRepoIdentity`, open `JobStore`.
2. `sweepStaleJobs`, then `prepareKimiExecutionPlan({operationKind: "swarm"})`.
3. Prompt from `buildSwarmPrompt` (`swarm.ts:144-165`). Deliberately **goal-only**: it states
   read-only intent, the objective, the available tools, "Launch the parallel fan-out as your FIRST
   action", "fan the work out … using your own subagent capability, as you judge best", the optional
   soft cap, and the required report shape. The header comment (`swarm.ts:129-143`) records *why*:
   prescribing `AgentSwarm` + `subagent_type` + `prompt_template/items` made a 0.26.0 coordinator
   emit a non-sole-tool-call response that never launched (0 records, hang to budget).
4. Job row with `command_type: "review"` — swarm **reuses the review lineage**
   (`swarm.ts:249-252`) so `status`/`result`/`cancel` work unchanged; `agent_profile: "<swarm>"`
   (`swarm.ts:71`) is the only marker in the row.
5. `executeSwarmJob(..., resolveSwarmMaxConcurrency(parsed.maxConcurrency), …)`.
6. Return `readArtifact(completed.final_output_path)`.

**Write mode** (`swarm.ts:314-443`), in order:

1. `assertWriteSwarmPreconditions` — must be a git repo (`swarm.ts:446-454`, `WRITE_SWARM_NOT_A_REPO`).
2. `hasBornHead` — must have ≥1 commit (`swarm.ts:330-336`, `WRITE_SWARM_NO_HEAD`).
3. `sweepStaleWorktrees` (`swarm.ts:462-483`) — `git worktree prune`, then force-remove dirs older
   than `WORKTREE_ORPHAN_TTL_MS` = `MAX_DURATION_MS + 2 h` (`swarm.ts:88`). The 26 h TTL is derived,
   not guessed: the only liveness signal is dir mtime, which stays frozen when a run edits existing
   files, so the TTL must exceed the longest possible run (`swarm.ts:73-87`).
4. Dirty-tree **warning** on stderr (`swarm.ts:338-342`) — the worktree is based on HEAD.
5. `createEphemeralWorktree(repoRoot, "HEAD", worktreePath)` (`runtime/git.ts:189-206`) where
   `worktreePath = <pluginData>/kimi-plugin-cc/worktrees/<repoId>/swarm-write-<jobId>`
   (`swarm.ts:351`) — **never inside the user repo** (`runtime/paths.ts:13-20`), namespaced per repo
   so the cross-repo sweep can't touch a live sibling.
6. `prepareKimiExecutionPlan({operationKind: "swarm-write", cwd: worktreePath})` — probed **from the
   worktree cwd** so a relative wrapper prefix can't diverge (`swarm.ts:364-371`).
7. Job row with `command_type: "rescue"` (write lineage) but `cwd: context.cwd` (the user's real
   cwd, for lineage) — the *spawn* cwd is the worktree, threaded as
   `{spawnCwd, workspaceRoot}` (`swarm.ts:373-397`, `418-426`).
8. `finally { removeWorktree(...) }` (`swarm.ts:435-439`) — `--force`, after patch capture.

**`executeSwarmJob`** (`swarm.ts:526-720`) — the shared core:

- **Hook gate, fail-closed** (`swarm.ts:553-576`): a swarm with no hook is "an N-fold blast radius";
  refusal is `SWARM_HOOK_NOT_INSTALLED` and the job is marked failed.
- `runCliPromptWithBudget` with `cwd: writeMode?.spawnCwd ?? job.cwd`,
  `commandLabel: writeMode ? "swarm-write" : "swarm"`, `swarmMaxConcurrency`,
  `trustedWorkspaceRoot: writeMode?.workspaceRoot` (`swarm.ts:584-615`).
- On success: `reassembleProseFromRecords`, then in write mode prepend
  `renderWriteSwarmHeader(await capturePatchArtifact(...))` + `\n\n---\n\n`
  (`swarm.ts:642-650`).
- **Patch capture on every terminal path**: success (`swarm.ts:647-649`) *and* in the `catch`
  (`swarm.ts:686-700`) before `markJobFailed`/`markJobCancelled`, so a cancel or budget expiry keeps
  partial work. `captureWorktreePatch` (`git.ts:227-248`) runs `git add -N -- .` (intent-to-add, so
  untracked files appear in the diff **without** writing blobs) then
  `git diff --binary HEAD --` with a 64 MB buffer and **no truncation** (a capture patch must apply).
- Header rendering (`swarm.ts:510-524`): capture-failed / empty-patch / `git apply --3way <path>`
  + "The plugin did NOT apply or commit anything — you own the merge."

**Aggregation, precisely.** There is exactly one model process and one `records[]`. "Aggregation" is
(a) the provider coordinator's own consolidation, instructed by prose
(`swarm.ts:161-164` read, `swarm.ts:202-206` write), and (b) the plugin's concatenation of assistant
content. No plugin-side severity ranking, dedup, or per-reviewer attribution exists.

### 2d. Job persistence

`runtime/job-store.ts` — single `jobs` table, `job_id` PK (`job-store.ts:122-155`), opened through a
thin `SqliteAdapter` that picks `bun:sqlite` or the Node-builtin `node:sqlite`
(`job-store.ts:563-679`) so `dist/` ships **zero native deps**. `journal_mode = WAL`,
`busy_timeout = 5000` (`job-store.ts:106-107`). Migrations are idempotent `ALTER TABLE` adds
(`job-store.ts:157-180`) plus a reconciliation `UPDATE` that must run *before* creating the unique
partial index `jobs_running_session_idx`, or an old DB with duplicate running rows would brick the
store at open (`job-store.ts:196-227`). Handle leaks on mid-migration failure are closed by the
constructor's own try/catch (`job-store.ts:232-242`) and by `withJobStore`
(`job-store.ts:786-803`).

Writes are allowlisted by column name (`job-store.ts:430-438` `JOBS_COLUMNS`, enforced at
`job-store.ts:451`) — no SQL injection surface. Terminal transitions are guarded
`WHERE … AND status = 'running'` (`job-store.ts:409-428`), so a cancel and a completion cannot both
win.

`runtime/jobs.ts` — `markJobFailed`/`markJobCancelled` (`jobs.ts:41-103`) **write a rendered
artifact first**, then flip the row, so every terminal job has a readable artifact.
`sweepStaleJobs` (`jobs.ts:105-166`) reaps `running` rows older than 15 s whose recorded pid is gone,
with an explicit skip when the foreground companion pid is still alive (`jobs.ts:143-150`) to avoid
killing a companion mid-render.

`runtime/background-spawn.ts` — `startBackgroundJob` (`background-spawn.ts:43-199`):

- Node binary chosen by `preferStableNodePath(process.execPath)` **to match the hook verifier's own
  resolution** (`background-spawn.ts:60-72`); the comment at `background-spawn.ts:50-67` records the
  failure it prevents (worker computes a different expected hook command ⇒ every background job
  refuses forever).
- `spawn(node, [entrypoint, "worker", kind, jobId], {detached: true, stdio: "ignore", env: {...,
  <PROMPT>_B64: base64(prompt), KIMI_PLUGIN_CC_DATA: resolve(paths.claudePluginData)}})`
  (`background-spawn.ts:98-115`). The prompt travels base64 in env, never on argv.
- Synchronous-spawn-error detection via a one-tick `setImmediate` race
  (`background-spawn.ts:118-142`), early-exit detection gated on phase
  (`background-spawn.ts:210-222`), and a retrying failure-persist with JSONL
  `stuck-jobs.jsonl` telemetry as the last resort (`background-spawn.ts:224-288`).
- `--wait` polls `waitForTerminalJob` (`jobs.ts:248-274`, 200 ms, 60 s cap); without it the command
  prints `{job_id, command_type}` JSON (`background-spawn.ts:191-198`).

The worker re-verifies the hook *inside* the detached process (`commands/ask.ts:195-197`,
`commands/rescue.ts:195-224`) and re-validates persisted resume lineage from the store
(`kimi-engine.ts:526-577` `assertPersistedResumeLineage`) before handing a session id to the spawn.

### 2e. Hook installation and the managed settings block

The plugin edits the **provider's** `~/.kimi-code/config.toml`, not the user's `settings.json`.
`resolveKimiCodeConfigPath` = `resolveKimiHome(env)` + `config.toml`
(`commands/setup.ts:1079-1081`, `runtime/kimi-home.ts:4-10`).

**Canonical command, single source of truth.** `runtime/hooks/install-paths.ts:127-133`:
`buildHookShellCommand` = `shellSingleQuote(nodeBin) + " " + shellSingleQuote(hookScriptPath)`.
Both tokens POSIX-single-quoted (`install-paths.ts:140-142`). `resolveNodeBinary`
(`install-paths.ts:93-111`) requires an absolute path and prefers `process.argv0` over
`process.execPath` **only** when argv0 is absolute and `realpath`-identical
(`install-paths.ts:69-82` `preferStableNodePath`) — the guard is the safety argument: it can pick a
more stable *name* for the running interpreter, never a different binary.
`resolveHookScriptPath` (`install-paths.ts:155-195`) anchors on the tail
`{runtime|dist}/hooks/install-paths.*` so an ancestor directory named `dist` can't confuse it.

**Host scoping.** `resolveHostId` (`install-paths.ts:490-518`): `~/.claude/` → `claude-code`,
`~/.codex/` → `codex`, else `host-<sha1(dirname)[0:16]>` (16 hex chars, not 8 — a reviewer found a
colliding dev-root pair). The marker carries `:<host-id>` so both harnesses coexist in one shared
config file.

**Write path** (`commands/setup.ts:249-384` `runInstall`), all inside `withKimiConfigLock`:

1. Read; detect line ending (`setup.ts:798-804`).
2. Normalize a top-level inline `hooks = [...]` into `[[hooks]]` tables
   (`hooks/config-safety.ts:509-551`), validating the *original* bytes first so an invalid inline
   entry leaves the file untouched (`setup.ts:262-277`).
3. Prune this host's marker-less orphan tables (`setup.ts:286-297`, host-scoped — a host-blind prune
   used to disarm the other harness's live hook).
4. `parseManagedBlock` → refuse `orphan` / `duplicate` (`setup.ts:299-324`).
5. Build the block (`setup.ts:1006-1040`): BEGIN marker with host id + version, explanatory comments,
   `[[hooks]]`, `event = "PreToolUse"`, `command = <TOML basic string>`
   (escaped by `setup.ts:1049-1059`), `timeout = 15`, END marker. **No `matcher` line** — the comment
   at `setup.ts:1027-1030` records why (`new RegExp("*")` throws upstream and silently disables the
   hook).
6. Splice or append (`setup.ts:806-826`).
7. Re-validate the **whole candidate file** against upstream's strict hook schema
   (`setup.ts:342`, `config-safety.ts:630-661`) — one invalid foreign hook makes the provider drop
   the entire array, so it must fail verification.
8. Atomic write (`setup.ts:724-772`): `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` at mode `0o600` passed to
   `open()` (never create-then-chmod — the config holds API keys), then `rename`.

**Locking.** `withKimiConfigLock` (`config-safety.ts:86-156`) is unusually careful: the lock is
published by writing a private candidate then `link()`ing it into place (atomic create-if-absent,
`config-safety.ts:165-202`), identity is `dev:ino` not a path, reads are
`O_RDONLY|O_NOFOLLOW|O_NONBLOCK` and capped at 4 KiB (`config-safety.ts:204-253`), stale recovery
takes a per-inode recovery lease and renames-then-verifies-then-unlinks to kill the ABA window
(`config-safety.ts:317-382`), and ownership is rechecked before entering the transaction and before
release (`config-safety.ts:422-435`, `457-490`).

**Verify path** (`runtime/hooks/install.ts:86-247` `verifyHookInstalled`), run before *every* model
spawn:

1. `KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1` ⇒ `installed: true` (test/diagnostic escape, `install.ts:90-92`).
2. Rebuild the expected command from the live env (`install.ts:99-106`).
3. Read config; ENOENT and read errors are distinct reasons (`install.ts:108-125`).
4. Whole-array schema validation (`install.ts:127-134`).
5. `evaluateInstalled(raw, expected.command, {hostId, nodeExists})`
   (`hooks/managed-block.ts:587-689`) — **byte-exact equality**, never substring (a crafted
   `true # /path/to/approval-hook.js` would run only `true`, exit 0, and be read as allow).
6. `access(hookScriptPath, R_OK)` — a matching command proves nothing if the script was pruned
   (`install.ts:162-171`).
7. `access(nodeBin, X_OK)` — the narrow backstop for "bytes still match but the interpreter died
   post-launch" (`install.ts:228-244`), carrying `refusalKind: "node-bin-not-executable"`, the one
   refusal whose remedy is *not* re-running setup.

`evaluateInstalled` has four ways to say installed/not:
`absent` + a byte-exact **marker-less** `[[hooks]]` table ⇒ installed via `"bare-table"`
(`managed-block.ts:593-616`) — because the provider re-serializes its own config and strips all
comments; `duplicate`/`orphan`/invalid ⇒ refuse; command mismatch ⇒ refuse **plus** a machine-readable
`drift` classification (`install-paths.ts:320-357` `classifyHookCommandDrift`, axes
`hook-script | node-bin | both`, with `nodeInterpreterUnchanged` when both spellings realpath to the
same file). `hookRefusalDetails` (`install.ts:289-318`) turns that into
`retryable_after_setup`, which the agents branch on. The verifier **never repairs** — the rejected
in-verifier auto-repin is documented at `docs/safety.md:195`.

Matcher rejection is belt-and-braces: a line regex (`managed-block.ts:118`), a parser-based check of
the block body (`managed-block.ts:277-300`), and a whole-file parse attributing keys outside the
markers to the same TOML table (`managed-block.ts:576-585` `foundHookEntryIsClean`,
`managed-block.ts:680-687`).

### 2f. Approval / safety policy

**Entry script** `runtime/hooks/approval-hook.ts`. Protocol (documented `approval-hook.ts:11-31`):
stdin = JSON payload, exit 2 + stderr = deny (stderr becomes the model-visible reason), exit 0 =
allow, **any other exit = allow (fail-open upstream)**. Therefore every path is wrapped and any
unexpected error exits 2 (`approval-hook.ts:79-82` `failClosed`, `approval-hook.ts:119-121`). stdin
read has a 5 s timeout (`approval-hook.ts:88-117`). Context passed to the policy
(`approval-hook.ts:60-67`): `commandLabel = KIMI_PLUGIN_CC_CMD`,
`operationKind = KIMI_PLUGIN_CC_OPERATION`, `trustedWorkspaceRoot = KIMI_PLUGIN_CC_WORKSPACE_ROOT`,
`rescueEvaluator = evaluateRescueHookRequest`.

**Policy** `runtime/hooks/approval-policy.ts:142-315` `decideHookOutcome`, in order:

1. No/empty label ⇒ **allow everything** (`approval-policy.ts:149-151`) — the user running `kimi`
   directly must not be restricted.
2. `EnterPlanMode`/`ExitPlanMode` ⇒ deny for every label (`approval-policy.ts:85`, `155-161`).
3. Goal tools `GetGoal`/`UpdateGoal`/`CreateGoal`/`SetGoalBudget` ⇒ deny, with one narrow exception:
   label `rescue` **and** `operationKind === "pursue"` **and** a non-empty trusted root **and**
   exactly `GetGoal {}` or `UpdateGoal {status: "complete"|"blocked"}` (`approval-policy.ts:163-184`).
   The arg check uses `Reflect.ownKeys` and a prototype check to reject prototype-polluted or
   extra-keyed inputs.
4. `ask|review|challenge|review_gate` ⇒ `READ_ONLY_TOOLS` only
   (`approval-policy.ts:53-60`: `Read`, `Grep`, `Glob`, `ReadMediaFile`, `TaskList`, `TaskOutput`;
   network tools deliberately excluded).
5. `swarm` ⇒ read-only set **+ exact `AgentSwarm`** (`approval-policy.ts:75`, `207-225`); singular
   `Agent` deliberately denied.
6. `swarm-write` ⇒ read-only set + `AgentSwarm`; everything else routed to the rescue evaluator
   against `ctx.trustedWorkspaceRoot`; **missing root ⇒ deny** (`approval-policy.ts:227-264`).
7. `rescue` ⇒ same, with read-only still allowed when the root is missing
   (`approval-policy.ts:266-294`).
8. Unknown label ⇒ read-only only (`approval-policy.ts:296-313`).

**Rescue evaluator** `runtime/rescue-approval.ts:242-321`. `workspaceRoot` is `realpath`'d once
(`rescue-approval.ts:252-259`); the hook payload's `cwd` is never trusted. Tool dispatch:

- `Bash`: extract `command`; validate `tool_input.cwd` *first* — must be a non-symlink existing
  directory whose realpath is inside the root and not under `.git`
  (`rescue-approval.ts:269-288`, `413-427`); then `validateShellCommand`.
- `Write`/`Edit`/`MultiEdit`: `checkApprovedPath` (`rescue-approval.ts:384-411`) — reject symlink
  targets, resolve the nearest existing ancestor via `realpath`, require containment and no `.git`
  segment. `extractFilePath` (`rescue-approval.ts:346-358`) reads `path` **then** `file_path`; the
  comment records that a `file_path`-only read silently denied every real write until a real-binary
  smoke caught it.
- anything else ⇒ deny.

`validateShellCommand` (`rescue-approval.ts:458-503`): reject `\r`/`\n` (shell-quote collapses them
and would hide a second command), then the **keystone syntax gate** `hasUnsafeShellSyntax`
(`rescue-approval.ts:931-933`) = `scanUnsafeUnquoted` (quote-aware scan for backticks, `$( )`,
`<( )`/`>( )`, `$'…'`/`$"…"`, brace expansion — `rescue-approval.ts:878-919`) **or**
`hasShellExpansion` (`rescue-approval.ts:826-833`, which re-parses with a throwing env callback so
`$IFS`-gluing and `${VAR:-flag}` are caught using the parser's own quote tracking). Only simple
`|` pipelines survive; each stage goes through `validateShellStage`
(`rescue-approval.ts:505-796`): absolute/`/`-containing entrypoints denied, global mutating-flag and
exec-delegating-flag sets, then a long per-tool table (`git` read-only subcommands with
pre-subcommand flags banned and `-O` banned locally; `find` banned actions; `tsc` requires
`--noEmit` and bans the profile/trace/outDir writers case-insensitively; `biome`, `ruff`, `cargo`,
`go`, `pytest`, `mypy` with argparse-abbreviation-aware matching; `eslint` with `-o` and
module-loading flags banned; pipeline plumbing `head|tail|wc|sort|uniq` with `sort`'s bundled
short-cluster getopt scan at `rescue-approval.ts:983-991`).

---

## 3. The two contracts, in full

### 3.1 Review-gate contract

**Input** (`review-gate.ts:36-46` `StopHookInput`): `session_id?`, `transcript_path?`, `cwd?`,
`hook_event_name: "Stop"`, `stop_hook_active?`, `last_assistant_message?`, `last_user_message?`,
`user_request?`, `prompt?`. Parsed with a bare `JSON.parse` + cast
(`review-gate-stop.ts:8-9`) — only `hook_event_name` is checked.

**Prompt** (`review-gate.ts:305-329`) — verbatim structure:

```
Review the just-finished Claude response and decide whether Claude should be allowed to stop.
Block only for concrete, high-confidence problems that require an immediate corrective follow-up turn.
Do not block for style nits, optional improvements, or low-confidence concerns.
Return exactly one JSON object with no prose wrapper and no code fences.

Required output schema:
{"decision":"ALLOW|BLOCK","confidence":"low|medium|high","summary":"string","issues":[{"title":"string","body":"string","severity":"low|medium|high"}]}

Workspace cwd: <cwd>
Repository root: <repoRoot>

User request:
<userRequest | "(unavailable from transcript)">

Claude response under review:
<assistantMessage>
```

**Verdict schema** (`runtime/schemas/review-gate-output.ts:3-18`):

```ts
interface ReviewGateOutput {
  decision: "ALLOW" | "BLOCK";
  confidence: "low" | "medium" | "high";
  summary: string;
  issues: Array<{ title: string; body: string; severity: "low" | "medium" | "high" }>;
}
```

Validation (`review-gate-output.ts:20-87`) is strict-ish: `JSON.parse`, must be a non-array object,
`decision`/`confidence` must be in their sets (compared via `String(value)`), `summary` must be a
`string`, `issues` must be an array; each issue must be an object with string `title`/`body` and a
valid `severity`. Any failure ⇒ `REVIEW_GATE_PARSE_FAILED`. Extra fields are kept (the object is
returned by reference, `review-gate-output.ts:86`). **No cap on `issues` length** at parse time; the
cap is presentational (`review-gate.ts:332-333`, `.slice(0, 5)`).

Two-layer parse: `renderManagedJobOutput` first calls `assertOutputModeConsistency`
(`render.ts:97-118`), which for `outputMode === "parsed"` does a plain `JSON.parse` and raises
`REVIEW_GATE_PARSE_FAILED`; then `parseReviewGateOutput` on the trimmed text (`render.ts:70-78`).
`review_gate` is the **only** `parsed` command in the registry (`commands/registry.ts:127-130`);
`ask`/`review`/`challenge`/`rescue` are `passthrough`.

**Block vs allow**: see the table in §2b. The gate blocks on **exactly one** condition —
`BLOCK` + `confidence: "high"`.

**Fail-open ladder** (`review-gate.ts:356-399`): timeout ⇒ "timed out after 8s; allowing stop";
parse failures ⇒ "returned malformed output; allowing stop"; `MAX_STEPS_REACHED` ⇒ "exhausted its
step budget"; spawn/exit/abort/no-session codes ⇒ "unavailable in this environment"; then the generic
availability classifier (`runtime/kimi-errors.ts:76-109`); else "failed unexpectedly; allowing stop".
**The gate can never block because of an error — only because of an explicit high-confidence BLOCK.**

**Artifact** (`render.ts:148-170`): `# Review Gate Result` + Job / Decision / Confidence / Summary
/ optional Kimi session, then `## Issues` with `### <title>`, `- Severity: …`, body — or
`No issues.`

**stdout/exit protocol**: `review-gate-stop.ts:18` writes `JSON.stringify(output) + "\n"` to stdout
and leaves `exitCode` 0; on an uncaught error it writes `formatError(error)` to stderr and sets
`exitCode = 1` (`review-gate-stop.ts:21-24`).

### 3.2 Swarm contract

**Bounds — three, deliberately not merged:**

| Bound | Kind | Default | Mechanism |
|---|---|---|---|
| `--budget` | **hard** wall-clock | read 30 min / write 30 min (`kimi-timeouts.ts:49`) | `AbortController` in `runCliPromptWithBudget`, then full process-tree teardown |
| `--max-concurrency` | **hard** peak parallelism | **4** read (`swarm.ts:101`), **1** write (`swarm.ts:122`) | exported as `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` (`cli-client.ts:1099-1103`); ignored by older provider builds |
| `--cap` | **soft** lifetime total | unset | injected as prose into the coordinator prompt (`swarm.ts:146-147`, `178-180`); the hook is stateless and cannot count subagents |

The write default of 1 is justified at `swarm.ts:113-121`: disjoint-target partitioning is prompt-only
and unenforceable, so two concurrent `coder` subagents racing one file would corrupt the patch.

**Enforcement surface**: one hook label for the coordinator *and* every spawned subagent —
`"swarm"` (read-only + `AgentSwarm`) or `"swarm-write"` (plus the rescue allowlist scoped to the
env-pinned worktree). Both refuse with `SWARM_HOOK_NOT_INSTALLED` when the hook is missing
(`swarm.ts:553-576`).

**Aggregation + rendering**: coordinator-side consolidation instructed by prose; plugin-side
concatenation of assistant content (`cli-helpers.ts:33-41`); `renderManagedJobOutput`
→ `renderReviewArtifact` for read mode (`render.ts:124-134`: `# Review Result`, job id, optional
session id, body) or `renderRescueArtifact` for write mode (`render.ts:136-138`: raw passthrough,
newline-normalized). Write mode prepends the patch header + `---` *before* rendering
(`swarm.ts:646-650`).

**Report shape asked of the model**: read — "a short verdict line, a brief summary, then findings as
`file:line — issue — severity`. Return plain markdown — no JSON wrapper, no outer code fences"
(`swarm.ts:161-164`). Write — verdict line, cross-target summary, one section per target listing
edited files, **no full diffs** (`swarm.ts:202-206`).

**Errors**: `SWARM_HOOK_NOT_INSTALLED`, `SWARM_LOG_HEADER_FAILED`, `SWARM_CANCELLED`,
`SWARM_ARTIFACT_WRITE_FAILED`, `SWARM_RESULT_MISSING`, `WRITE_SWARM_NOT_A_REPO`,
`WRITE_SWARM_NO_HEAD`, `GIT_WORKTREE_ADD_FAILED`, `GIT_WORKTREE_DIFF_FAILED`.

### 3.3 stdout / exit-code protocol (whole runtime)

- stdout is the load-bearing channel: artifact prose, or JSON for `status`/`result --json`/`cancel`/
  `repair-sessions`/background launch. stderr is humans-only (warnings, hook-missing banner).
  This "LLM-caller discipline" is stated at `install.ts:359-365`.
- Errors: `main().catch` writes `formatError(error)` to stderr and sets `exitCode = 1`
  (`companion.ts:123-126`). `formatError` (`errors.ts:15-43`) emits
  `[CODE] [stage] message` plus a deterministic `details: {...}` JSON line so structured context
  (`drift_axis`, `retryable_after_setup`, `refusal_kind`) reaches a foreground caller that has no
  job row to read.
- `setup` exits 1 when `result.probe === "failed"`, even on the install path, because agents key a
  retry decision on the exit code (`companion.ts:42-54`).
- **Inconsistency**: `review`/`challenge`/`ask` rethrow and exit 1; `rescue`/`pursue`/`swarm` return
  the rendered *failure* artifact and exit **0** — see D1 in §6.

### 3.4 Every env var and config key

**Plugin-owned env (`KIMI_PLUGIN_CC_*`)**

| Var | Read at | Meaning |
|---|---|---|
| `KIMI_PLUGIN_CC_DATA` | `plugin-data.ts:16-26` | absolute data-root override; relative/empty ⇒ `INVALID_PLUGIN_DATA` |
| `KIMI_PLUGIN_CC_WORKSPACE_CWD` | `companion.ts:21`, `review-gate-stop.ts:11`, set by both shims | the user's cwd, preserved across the `cd` into the plugin root |
| `KIMI_PLUGIN_CC_SHELL_LAUNCH` | `plugin-data.ts:55` | set by the shims; enables the Codex `CODEX_HOME`/`HOME` data fallback |
| `KIMI_PLUGIN_CC_NODE_BIN` | `install-paths.ts:94`, `background-spawn.ts:68`, `companion.sh:21` | interpreter override; must be absolute for the hook command |
| `KIMI_PLUGIN_CC_HOOK_SCRIPT` | `install-paths.ts:156` | hook-script override; must be absolute |
| `KIMI_PLUGIN_CC_HOST_ID` | `install-paths.ts:494` | host-id override, slugified |
| `KIMI_PLUGIN_CC_KIMI_BIN` | `kimi-command.ts:37` | provider binary override (default `kimi`) |
| `KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS` | `kimi-command.ts:38-75` | JSON array (or space-split) launcher prefix; reserved flags refused |
| `KIMI_PLUGIN_CC_SKIP_HOOK_CHECK` | `install.ts:90` + every command | bypasses hook verification only |
| `KIMI_PLUGIN_CC_SKIP_VERSION_PROBE` | `kimi-engine.ts:233`, `setup.ts:1288` | test-bypass plan; also required at the spawn boundary |
| `KIMI_PLUGIN_CC_REVIEW_GATE_MODEL` | `review-gate.ts:186` | model alias for the gate only |
| `KIMI_PLUGIN_CC_CMD` | set `cli-client.ts:1096-1098`, read `approval-hook.ts:61` | the hook label |
| `KIMI_PLUGIN_CC_OPERATION` | set `cli-client.ts:1094`, read `approval-hook.ts:62` | true operation kind (distinguishes `pursue` from `rescue`) |
| `KIMI_PLUGIN_CC_WORKSPACE_ROOT` | set `cli-client.ts:1104-1108`, read `approval-hook.ts:66` | forge-proof trusted write root |
| `KIMI_PLUGIN_CC_{ASK,RESCUE}_PROMPT_B64` | `worker.ts:18,34` | base64 prompt for a detached worker |
| `KIMI_PLUGIN_CC_{ASK,RESCUE}_REUSED_SESSION` | `worker.ts:23` | `"1"`/`"0"` |
| `KIMI_PLUGIN_CC_TEST_FAIL_WRITE_ARTIFACT` | `rescue.ts:301` | test seam |

**Provider/host env read or written**: `CLAUDE_PLUGIN_ROOT`, `PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`,
`PLUGIN_DATA`, `CODEX_HOME`, `HOME`, `PATH`, `PATHEXT` (`plugin-data.ts:29-60`,
`kimi-engine.ts:827-831`); `KIMI_CODE_HOME` (`kimi-home.ts:4-10`),
`KIMI_CODE_LEGACY_FLAG`, `KIMI_CODE_NO_AUTO_UPDATE`, `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY`
(`cli-client.ts:1085-1103`), `KIMI_CODE_EXPERIMENTAL_FLAG` (`kimi-engine.ts:176`),
`KIMI_CODE_EXPERIMENTAL_TOWER` / `_SUBAGENT_FORK` (`native-v2-preflight.ts:218-223`),
`KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND` (`pursue.ts:298`), `KIMI_MODEL_NAME` /
`KIMI_MODEL_PROVIDER_TYPE` (`models.ts:65-74`).

**Config keys.** Plugin config is one file, one key:
`<dataRoot>/kimi-plugin-cc/config.json` → `{ reviewGateEnabled: boolean }`
(`runtime/config.ts:5-32`, default `false`). Paths derived in `runtime/paths.ts:24-38`:
`state.db`, `logs/`, `artifacts/`, `worktrees/`, `config.json`.
Provider config keys *inspected* (never written except the hook block): `defaultPlanMode` under
every `snakeToCamel` spelling (`native-v2-preflight.ts:142-178`), `[experimental].tower` /
`.subagent_fork` (`native-v2-preflight.ts:210-217`), `hooks[]`
(`config-safety.ts:663-758`), `defaultModel`/`providers`/`models`/`secondaryModel`
(`models.ts:52-85`).

---

## 4. Provider coupling points (the seam list)

Ordered by how hard each is to abstract.

### 4.1 Hard-wired, high-effort

| # | Coupling | Citation |
|---|---|---|
| P1 | **The hook-into-provider-config mechanism.** The entire safety story depends on the provider (a) reading hooks from `~/.kimi-code/config.toml`, (b) firing `PreToolUse` before its own auto-approve, (c) treating exit 2 + stderr as deny and **everything else as allow**. | `setup.ts:1006-1040`, `approval-hook.ts:11-31`, `install.ts:86-247` |
| P2 | **Hook config grammar**: `[[hooks]]` array-of-tables, `event`/`matcher`/`command`/`timeout` fields, `timeout` 1–600, matcher compiled as a JS regex (so it must be omitted), strict schema that drops the *whole* array on one bad entry. | `config-safety.ts:19-43`, `707-758`, `managed-block.ts:107-121` |
| P3 | **CLI invocation shape**: `kimi [prefix] --output-format stream-json [-r SID] [-m MODEL] [--skills-dir D]* -p PROMPT`. Includes the fact that `-p` reads the prompt from argv, not stdin. | `cli-client.ts:1049-1074`, `896` |
| P4 | **stream-json record shapes**: `{role:"assistant",content,tool_calls}`, `{role:"tool",tool_call_id,content}`, `{role:"meta",type:"session.resume_hint",session_id}`, `…"turn.step.retrying"` with 7 snake_case fields, `…"system.version"`, and the role-less `{type:"goal.summary",goalId,status,reason,turnsUsed,tokensUsed,wallClockMs}`. | `stream-json.ts:180-303`, `438-561` |
| P5 | **Engine/version certification tables**: exact native-v2 set and the legacy minor table, plus per-operation minimums (`pursue` ≥ 0.8, `swarm` ≥ 0.12, `swarm-write` ≥ 0.18). | `kimi-engine.ts:85-94`, `104-128`, `kimi-version-probe.ts:59`, `1256` |
| P6 | **The `native-v2` no-plan construction**: `defaultPlanMode` key name + upstream's `snakeToCamel`, the `sessions/<workspace>/<session>/agents/<agent>/wire.jsonl` journal layout, the `plan_mode.*`/`plan.*` record prefixes, the `[experimental]` flag ids. | `native-v2-preflight.ts:142-178`, `200-231`, `342-412` |
| P7 | **Tool names.** `READ_ONLY_TOOLS` = `Read|Grep|Glob|ReadMediaFile|TaskList|TaskOutput`; `AgentSwarm`; `EnterPlanMode`/`ExitPlanMode`; `GetGoal|UpdateGoal|CreateGoal|SetGoalBudget`; `Bash|Write|Edit|MultiEdit`. And the **field names** inside `tool_input`: `command`, `cwd`, `path` (with `file_path` as compat). | `approval-policy.ts:53-60`, `75`, `85`, `163`; `rescue-approval.ts:218-225`, `261-320`, `346-358` |

### 4.2 Provider-shaped but narrower

| # | Coupling | Citation |
|---|---|---|
| P8 | **Goal mode**: prompt prefix `/goal `, exit codes 0/3/6, the `goalId ≠ sessionId` split, the experimental env gate. | `pursue.ts:102-126`, `298` |
| P9 | **Session-id token format**: `session_<uuid>` or bare UUID, carried verbatim back through `-r`; plus the 0.1.x stderr fallback line `To resume this session: kimi -r <token>` matched by an anchored regex. | `stream-json.ts:214-218`, `650-665` |
| P10 | **Provider home + auth**: `KIMI_CODE_HOME` default `~/.kimi-code`; the `plugins/installed.json` manifest shape; the `sessions/` + `session_index.jsonl` + `state.json` metadata layout the title sync writes. | `kimi-home.ts:4-10`, `setup.ts:1319-1362`, `session-title.ts:117-221` |
| P11 | **Auth error strings**: classification keys on the literal substrings `auth.login_required`, `LLM is not set`, `LLM service error`, with remedy prose `Run \`kimi login\``. | `kimi-errors.ts:126-144` |
| P12 | **Env-overlay model discovery**: `KIMI_MODEL_NAME`/`KIMI_MODEL_PROVIDER_TYPE` synthesize a pseudo-provider `__kimi_env__`; the explicit warning that `kimi provider list --json` leaks credentials. | `models.ts:65-74`, `docs/models.md:73-74` |
| P13 | **Concurrency env var** `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY`, including the fact that older builds silently ignore it and that upstream *throws* on a non-positive integer. | `cli-client.ts:99-112`, `parsing.ts:248-264` |
| P14 | **`--thinking` does not exist** — the option survives in the options bag as intent only. | `cli-client.ts:124-139`, `1063-1067` |
| P15 | **Rescue allowlist tool knowledge** — ~20 developer tools and their write/exec flags. Provider-independent in principle, but it is *the* reason rescue is safe. | `rescue-approval.ts:38-180`, `505-796` |

### 4.3 Naming / branding (mechanical)

Every identifier, error code prefix (`KIMI_*`, `*_KIMI_*`), artifact name, SQLite column
(`kimi_session_id`, `kimi_version`, `kimi_command`, `kimi_pid`), marker tag
(`kimi-plugin-cc-managed`), host-id literals (`claude-code`, `codex`), and the prose in all 11
commands + 7 agents + 12 skills. `docs/models.md` is entirely Kimi-specific. Subscription handling
is **not implemented** — `docs/subscription-switching-spec.md:3` says so explicitly ("No feature in
this document is implemented in plugin 2.0.3"), and the only runtime mention of "subscription" is a
prose note in `models.ts:91`.

### 4.4 What is already provider-agnostic

`process-tree.ts`, `job-store.ts`, `jobs.ts`, `background-spawn.ts`, `config-safety.ts`'s locking
half, `errors.ts`, `logging.ts`, `paths.ts`, `render.ts`'s plumbing, `parsing.ts`'s flag machinery,
and `rescue-approval.ts`'s shell/path analysis. Roughly 45 % of the runtime by line count has no
Kimi knowledge at all.

---

## 5. Reuse vs rewrite, per module

**Reuse as-is** (no provider knowledge, or only naming):

| Module | Lines | Reasoning |
|---|---|---|
| `process-tree.ts` | 560 | Pure POSIX process-identity work; the two-snapshot PID-reuse guard is the hardest part to get right and is already correct. |
| `job-store.ts` | 817 | Generic job table + dual bun/node sqlite adapter; only column *names* are Kimi-flavoured. |
| `jobs.ts` | 280 | Terminal-state + stale-sweep logic is provider-neutral. |
| `errors.ts` / `logging.ts` | 43 / 34 | `RuntimeError` + the `details:` JSON line is the right LLM-caller contract. |
| `paths.ts` / `plugin-data.ts` | 50 / 120 | Host-agnostic already (Claude *and* Codex layouts, conflict refusal). |
| `cli-cancellation.ts` | 96 | SIGTERM/SIGINT → AbortController. |
| `git.ts` | 290 | `--end-of-options` hardening, intent-to-add patch capture, worktree lifecycle — all generic. |
| `hooks/config-safety.ts` (lock half, `:13-494`) | ~480 | A genuinely good `link()`-based config lock. Keep verbatim. |
| `vendor/shell-quote`, `vendor/smol-toml` | — | Already pinned + patched; see §9. |

**Reuse with abstraction** (extract a provider interface):

| Module | Seam to introduce |
|---|---|
| `cli-client.ts` | Split into *process supervision* (spawn, teardown, budget, log chain — keep) and a `ProviderWire` (argv builder, env builder, record parser, provenance rules — swap). `buildArgs`/`buildEnv` are already isolated functions at `:1049`/`:1076`. |
| `stream-json.ts` | Becomes one implementation of `ProviderStreamParser → {prose, sessionId, meta}`. The line-buffer + outcome-union design is reusable; the record vocabulary is not. |
| `kimi-engine.ts` | The *plan* abstraction (resolve-exact-binary → probe → certify → freeze → persist → re-verify at spawn) is the best idea in the repo and is provider-neutral. The certification *tables* and the no-plan profile are provider data. |
| `kimi-version-probe.ts` | Keep `probeKimiVersion`/`parseVersionLine` (~120 lines of code); the 1,200-line comment block and `KIMI_TESTED_MINORS` are provider data. |
| `hooks/approval-policy.ts` | Label→policy table is the right shape; the tool-name sets are provider data. Make `READ_ONLY_TOOLS`, the fan-out tool name, and the plan/goal tool sets injected config. |
| `hooks/install.ts` + `install-paths.ts` + `managed-block.ts` | Generalize to "managed block in a third-party config file": keep byte-exact verification, host scoping, drift classification, bare-table fallback; parameterize the file path, the block grammar, and the serializer (TOML today, JSON for a `settings.json`-style target). |
| `rescue-approval.ts` | Keep the whole shell/path analyzer; parameterize `extractFilePath`'s key list and the read-only tool set. |
| `commands/registry.ts`, `render.ts`, `parsing.ts` | Keep; add per-provider prompt/report-shape config. |
| `background-spawn.ts` | Keep; the `preferStableNodePath` coupling to the verifier must survive any refactor (`background-spawn.ts:50-67`). |

**Provider-specific — rewrite or reparameterize**:

`kimi-home.ts` (10), `kimi-command.ts` (124 — the reserved-flag list is per-CLI),
`native-v2-preflight.ts` (504 — entirely about one engine's plan-mode internals),
`kimi-errors.ts` (285 — string-matching one CLI's error text),
`session-title.ts` (366 — writes one provider's session metadata),
`commands/repair-sessions.ts` (158), `commands/models.ts` (140 — one config schema),
`commands/pursue.ts` (408 — one CLI's goal mode), `version.ts` (7).
All 11 `commands/*.md`, all 7 `agents/*.md`, all 12 Codex skills, `docs/models.md`,
`scripts/audit-*.ts`.

---

## 6. Defects and risks

### D1 — `rescue` / `pursue` / `swarm` exit **0** on failure (contract inconsistency)

`executeRescueJob`'s catch returns `markJobFailed(...)` instead of rethrowing
(`rescue.ts:341-362`); `executePursueJob` (`pursue.ts:382-395`) and `executeSwarmJob`
(`swarm.ts:684-715`) do the same. The caller then only checks `final_output_path`
(`rescue.ts:160-164`, `pursue.ts:229-232`, `swarm.ts:297-300`) — which `markJobFailed` always
populates (`jobs.ts:61-69`) — and returns the artifact. `companion.ts:64-86` writes it to stdout and
returns, so `process.exitCode` stays 0. By contrast `review`/`challenge` (`review.ts:215-217`) and
`ask` (`ask.ts:311-317`) rethrow and exit 1.

*Failure scenario*: a CI wrapper runs `companion.sh task rescue "fix X"`, gets exit 0, and treats a
`RESCUE_HOOK_NOT_INSTALLED` run — i.e. **no safety enforcement was in place and nothing ran** — as
success. The failure text is only in the stdout markdown.

### D2 — `kimi_pid` is written as `null` everywhere, so part of the cancel contract is dead

Every `createJob` call passes `kimi_pid: null` (`review.ts:112`, `ask.ts:114`, `rescue.ts:112`,
`pursue.ts:192`, `swarm.ts:259`, `swarm.ts:386`, `review-gate.ts:216`) and no code path ever updates
it (verified: the only other references are reads in `jobs.ts:112`, `cancel.ts:46,167,218`).

Consequences:
- `review_gate` rows have `pid: null` **and** `kimi_pid: null`, so `/kimi:cancel` on a runaway gate
  throws `CANCEL_NOT_SUPPORTED` (`cancel.ts:46-52`) — exactly the scenario
  `cli-client.ts:955-961` says the 8 s budget exists to avoid.
- `jobs.ts:112`'s `kimiMissing` is permanently `false`, so half of `describeMissingForegroundProcess`
  (`jobs.ts:175-187`) and the background branch at `jobs.ts:126-128` are unreachable.
- `commands/cancel.md:11` claims "Cancellation uses the recorded companion **and Kimi** process ids";
  the `cancel.ts:54-114` review-gate branch and its comments describe signalling `kimi_pid`. All of
  that is documentation of behaviour that cannot occur.

### D3 — `/kimi:cancel` signals a raw recorded pid with no identity revalidation (PID-reuse kill)

`signalJobProcesses` (`cancel.ts:161-182`) does `process.kill(pid, signal)` for `job.pid`, and the
escalation path then sends `SIGKILL` (`cancel.ts:131`, `cancel.ts:98`). There is no start-token /
PGID check — unlike `cli-client.ts:625-645`, which revalidates identities twice precisely because
"a pid whose start token or PGID changed belongs to another process".

*Failure scenario*: a companion is SIGKILLed (laptop sleep, OOM). Its row stays `running` until the
15 s sweep. The OS recycles the pid to an unrelated user process. The user runs `/kimi:cancel`
(no id, so `findLatestJob({runningOnly:true})` picks that row) and the plugin SIGTERMs then SIGKILLs
the innocent process. `cancel.ts` also doesn't consult `process-tree.ts` at all, so the real kimi
descendants of a *detached* run are not reaped by this path — only the companion's own SIGTERM
handler reaches them.

### D4 — Review-gate budget can exceed the harness hook timeout

`hooks/hooks.json:10` sets `timeout: 10` (seconds). Inside that budget the gate must: start Node,
resolve paths, read config, read/scan the transcript, run `verifyHookInstalled` (which can itself
spawn `kimi --version` with a 5 s timeout when the user's config declares a version-sensitive hook
event — `install.ts:127`, `config-safety.ts:640-660`), run `prepareKimiExecutionPlan` which
**always** probes `kimi --version` with a 5 s timeout (`review-gate.ts:188-192`,
`kimi-version-probe.ts:43`), and only then run an 8 s model prompt
(`kimi-timeouts.ts:64`). 5 s + 8 s > 10 s.

*Failure scenario*: on a cold/slow provider binary the harness kills the Stop hook before the gate
decides. The harness sees no JSON output; the gate neither blocks nor emits its `systemMessage`, so
a genuine high-confidence BLOCK is silently lost. Fail-open, but invisibly — and the 8 s constant is
documented as "the only governor" (`review-gate.ts:61-63`), which is not true once the version probe
is counted.

### D5 — `MUTATING_FLAGS_EXACT` contains bare `-i` and `-w`, denying `grep -i` / `grep -w`

`rescue-approval.ts:38-49` lists `-i` and `-w` as exact mutating flags, and `hasMutatingFlag`
(`rescue-approval.ts:935-951`) is applied to **every** command before the per-tool branches
(`rescue-approval.ts:515-517`). The inline comment (`rescue-approval.ts:943-945`) claims the
punctuation-suffix regex avoids colliding with "`find -iname`, `grep -il`, `rg -iw`" — true for
*clusters*, but a bare `-i` or `-w` is matched by the exact set.

*Failure scenario*: `/kimi:rescue` cannot run `grep -i TODO src` or `grep -w main file.c`
(case-insensitive / word-match, both read-only). Denial text is the misleading
"Rescue rejects mutating shell flags". The test suite only covers the clustered forms
(`tests/runtime/rescue-approval.test.ts:218-219`), so the regression is unguarded. Same class:
`git diff -w`, `ls -i`, `sort -w`.

### D6 — `MAX_STREAM_JSON_LINE_BYTES` does not bound a newline-terminated line

The oversize guard fires only when the buffer contains **no** newline
(`stream-json.ts:355-364`). A 500 MB single record that arrives *with* its trailing newline is
drained by `drainCompleteLines` (`stream-json.ts:376-390`) and handed straight to `JSON.parse`
(`stream-json.ts:397`).

*Failure scenario*: a provider build (or a hostile tool result echoed into a `role:"tool"` record)
emits one enormous line; the companion's RSS spikes and `JSON.parse` blocks the event loop,
stalling the abort timer that is supposed to bound the run.

### D7 — Artifacts, logs and the job DB are written at default umask

`ensurePluginPaths` (`paths.ts:40-48`) `mkdir`s with no `mode`; `writeArtifact`
(`render.ts:22-30`) and `appendFile` in `logging.ts:23` and `cli-client.ts:333` use default
permissions. Those files hold the full model output, the complete `git diff --binary` patch
(`swarm.ts:498-500`), the full prompt argv in the spawn log record (`cli-client.ts:339-352` logs
`args`, which includes `-p <prompt>`), and the stderr tail. Contrast the same codebase's careful
`0o700`/`0o600` handling of the *provider's* config (`config-safety.ts:101`, `setup.ts:740-757`).

*Failure scenario*: on a shared host with a permissive umask, any local user can read another user's
workspace source, prompts, and patches out of `<pluginData>/kimi-plugin-cc/{logs,artifacts}`.

### D8 — Stop-hook payload is unvalidated and `transcript_path` is read verbatim

`review-gate-stop.ts:8-9`: `readFileSync(0, "utf8")` with no size cap and no timeout, then
`JSON.parse(raw) as StopHookInput` — a cast, not a validation.
`scanTranscriptForLastRoleText` (`review-gate.ts:409-444`) expands `~` and `readFile`s whatever path
arrives, unbounded, then the extracted text is embedded in the prompt sent to the provider
(`review-gate.ts:326-328`).

*Failure scenario*: any process that can drive the plugin's Stop entry point (a misconfigured or
hostile harness hook config, a replayed payload) can make the plugin read an arbitrary
user-readable file and forward its tail to a remote model. Low severity because the payload source
is the harness, but it is the one boundary in the repo with *no* schema validation — everywhere else
(`approval-hook.ts:49-58`, `kimi-command.ts:55-72`, `managed-block.ts`, `native-v2-preflight.ts`)
validates aggressively.

### D9 — `status` / `result` / `cancel` with an explicit job id are not repo-scoped

`status.ts:19-24`, `result.ts:20-27` and `cancel.ts:22-28` call `store.getJob(parsed.jobId)` with no
`repo_id` comparison. Only `replay.ts:75-78` checks `job.repo_id !== repoIdentity.repoId`.

*Failure scenario*: from repo A, `/kimi:result <uuid-from-repo-B>` prints repo B's artifact (model
output about another codebase), and `/kimi:cancel <uuid-from-repo-B>` kills repo B's running job.
Requires knowing a UUID, so this is a scoping bug rather than an exploit — but `replay`'s check
shows the intended invariant.

### D10 — Doc/code divergence: the "read-only subagent profile" second layer does not exist

`docs/safety.md:91` states: "**Defense-in-depth: read-only subagent profile.** The coordinator
prompt steers the swarm to `subagent_type: "explore"` … whose tool loadout has *no* `Write`/`Edit`
tools at all. That is a second layer beneath the hook." `buildSwarmPrompt`
(`swarm.ts:144-165`) contains no `subagent_type` at all, and the header comment
(`swarm.ts:129-143`) explains it was **removed on purpose** because prescribing it broke launch.
Grepping the whole runtime finds `explore` only in an unrelated review-prompt sentence
(`review.ts:269`).

*Consequence*: read-only swarm has exactly **one** enforcement layer (the hook), not two. Anyone
sizing risk from `docs/safety.md` will over-credit the design.

### D11 — Double-opened SQLite connection per command

`runReadSwarm` opens a `JobStore` (`swarm.ts:234`) and `executeSwarmJob` opens a **second** one on
the same file (`swarm.ts:543`) while the first is still open; same pattern in `runAsk`→
`executeAskJob` (`ask.ts:83`, `ask.ts:181`), `runRescue`→`executeRescueJob`, `runPursue`→
`executePursueJob`, and `cancel.ts` (which opens up to three: `cancel.ts:17`, `cancel.ts:77`,
`cancel.ts:194` in a poll loop). WAL + `busy_timeout=5000` makes this *work*, but
`sweepStaleJobs` on the outer handle can run concurrently with the inner handle's writes, and a
5 s busy timeout is now on the critical path of every command.

### D12 — Non-ENOENT `rm` / cleanup failures are swallowed in several paths

`removeWorktree` (`git.ts:257-270`) never throws by contract; `sweepStaleWorktrees`
(`swarm.ts:474-481`) swallows per-entry errors; `capturePatchArtifact` returns `null` on any failure
and only writes a stderr line (`swarm.ts:501-506`). So a write-swarm whose patch capture fails
reports `**Patch:** capture FAILED` in the report body but **still exits 0** (D1) and still
force-removes the worktree in the `finally` (`swarm.ts:435-439`) — the edits are gone. The error
cause is only in `job.stream_log_path`, not in the job row.

### D13 — Smaller items worth tracking

- `appendToTail` (`cli-client.ts:1112-1116`) compares `combined.length` (UTF-16 code units) against
  `STDERR_TAIL_BYTES`; multi-byte stderr retains fewer bytes than the name implies.
- `truncateChars` (`cli-client.ts:1118-1120`) likewise; `malformed[].line` is capped at 200 *chars*.
- `isSqliteConstraintError`/`isSqliteBusyError` (`job-store.ts:733-741`) classify by lowercase
  substring match on the driver's message — brittle across bun/node sqlite versions and locales.
- `--json` is accepted by `parseJobLookupArgs` for `cancel` but `runCancel` never reads it
  (`cancel.ts:13`), so `/kimi:cancel --json` silently ignores the flag.
- `validateKimiHookSetForEnvironment` probes the provider version **without** `prefixArgs`
  (`config-safety.ts:648-651`), unlike `prepareKimiExecutionPlan` (`kimi-engine.ts:250-255`), so a
  wrapped-binary setup can probe the wrong executable.
- `writeStateFileAtomic` (`session-title.ts:306-317`) compares current content to `expected` and
  *then* renames — a narrow TOCTOU where a concurrent provider write is clobbered.
- `withKimiConfigLock` depends on `link()` (`config-safety.ts:189`); on a filesystem without
  hardlinks (some network/FUSE mounts) setup fails with `SETUP_CONFIG_LOCK_FAILED` rather than
  degrading.
- Windows: `cli-client.ts:655-674` manages only the direct child (documented); `process-tree.ts:61`
  returns `[]`; `probeHookViaShell` is skipped (`setup.ts:1156-1161`). The plugin is POSIX in
  practice despite partial win32 branches.
- Non-`--wait` background launches rely on the stale sweeper for early-exit detection, because the
  `close` listener (`background-spawn.ts:144-159`) lives in a companion that exits immediately after
  printing the job id.

---

## 7. Cross-harness packaging (`plugins/kimi-codex/`)

**Mechanism, in three sentences.** One shared compiled runtime (`dist/`) plus two shell entrypoints
are the only executable artifacts; each harness gets a thin, *generated* text surface that tells its
model to shell out to `companion.sh <subcommand> <args>`, so adding a harness means adding a
renderer, not a runtime. `scripts/surface-registry.ts` is the single declarative source for both
surfaces — it pins the Claude-side files by SHA-256 (`surface-registry.ts:36-58`) and declares the
Codex skills as data (`surface-registry.ts:119` `CODEX_SKILLS`), and `scripts/generate-surfaces.ts`
renders `SKILL.md` + `agents/openai.yaml` per skill (`generate-surfaces.ts:58-85`, renderers at
`renderSkillMarkdown`/`renderOpenAiYaml`) and byte-mirrors `dist/` + the two `.sh` files into the
self-contained `plugins/kimi-codex/` subfolder (`generate-surfaces.ts:220-243`). Drift is a build
failure, not a review nicety: `generate-surfaces.ts` **refuses to write** if a Claude surface hash
moved (`generate-surfaces.ts:194-203`), `checkAllSurfaces` validates hashes + generated content +
text orphans + the runtime mirror (`generate-surfaces.ts:286-300`), and `package.json:10` chains
`build && check:surfaces && tsc --noEmit && test && git diff --exit-code -- dist plugins/kimi-codex`
plus an untracked-file gate.

**Why a subfolder.** `surface-registry.ts:11-17` records the reason: Claude Code auto-discovers a
top-level `skills/` directory, so keeping Codex skills out of the repo root is what stops them
leaking into the Claude surface; Codex copies the plugin root into its install cache and forbids
`../` escapes, so the subfolder must carry its own `dist/` and `scripts/`. The root
`.agents/plugins/marketplace.json` points *into* the subfolder (`source: {source: "local", path:
"./plugins/kimi-codex"}`) and is not part of the payload (`generate-surfaces.ts:66-70`).

**What differs between the two skins.**

| Axis | Claude Code | Codex |
|---|---|---|
| Manifest | `.claude-plugin/plugin.json` listing 11 `commands/*.md` | `plugins/kimi-codex/.codex-plugin/plugin.json` with `"skills": "./skills/"` + an `interface` block (display name, capabilities, `brandColor`, `defaultPrompt`) |
| Model-invocable surface | `agents/*.md` (7, with `<example>` trigger blocks, `color`, `tools: Bash`) | `skills/*/agents/openai.yaml` — `interface` + `policy.allow_implicit_invocation` |
| Human-only surface | `commands/*.md` with `disable-model-invocation: true` | *none* — Codex has one unified skill surface |
| Auto-dispatch allowed | per-agent prose | three skills only: `kimi-ask`, `kimi-challenge`, `kimi-review` have `allow_implicit_invocation: true`; the other nine are `false` |
| Plugin root discovery | `CLAUDE_PLUGIN_ROOT` | `PLUGIN_ROOT`, else "the directory that CONTAINS `skills/`" (`SKILL.md` Invocation section) |
| Data root | `CLAUDE_PLUGIN_DATA` / derived installed path | `PLUGIN_DATA`, or the `CODEX_HOME`/`HOME` → `plugins/data/kimi-marketplace-kimi` fallback (`plugin-data.ts:55-60`, `78-80`) |
| Hook host id | `claude-code` (path contains `/.claude/`) | `codex` (path contains `/.codex/`) — `install-paths.ts:507-518` |
| Stop review gate | wired via `hooks/hooks.json` | **not wired** (see below) |

**Shared-state coordination.** Both harnesses write a host-scoped managed block into the *same*
`~/.kimi-code/config.toml`. The marker suffix (`setup.ts:1014`), `effectiveHost`
(`managed-block.ts:369-372`), host-scoped pruning (`setup.ts:286-297`,
`managed-block.ts:839-859`), and `--uninstall` vs `--uninstall --all` (`setup.ts:866-877`) exist
entirely to make that coexistence non-destructive. They are separate on the *job* side: each host has
its own plugin-data root, hence its own `state.db` (`docs/session-visibility.md`: "Claude Code and
Codex have separate stores, so run against each relevant host").

**Gap**: the Codex subfolder mirrors `scripts/review-gate-hook.sh` and `dist/hooks/review-gate-stop.js`
(`generate-surfaces.ts:31` + the `dist` mirror), and `$kimi-setup --enable-review-gate` flips the
shared `config.json` flag, but the Codex manifest declares only `skills` — there is **no Codex hook
registration**, so nothing ever invokes the gate there. The ship-side consequence is a dead
entrypoint in the bundle and a toggle that appears to work but does nothing on that harness.
(README scopes the feature correctly — `README.md:141` says "Claude Code also has an optional review
gate" — so this is a packaging/UX gap, not a false claim.)

**The pattern worth copying.** A harness adapter is: (1) a manifest shape, (2) a text-surface
renderer, (3) a plugin-root + data-root resolution rule, (4) a model-invocability policy, (5)
optionally a hook registration. Everything else — one `companion.sh`, one `dist/`, one job store, one
approval hook — is shared. The hash-pinning of the *other* harness's surfaces is what keeps the two
from drifting apart; a merged plugin should keep that gate.

---

## 8. Noted doc↔code divergences (beyond D10)

- `docs/subscription-switching-spec.md:3` — explicitly a *proposed* spec; 271 lines of design with
  zero runtime implementation. Treat as a requirements document, not a feature.
- `runtime/README.md:5` and `docs/safety.md:4` list different certified-version sets (`…2.0.0` vs
  `…2.1.1`) than each other; `kimi-engine.ts:104-113` is authoritative.
- `commands/cancel.md:11` describes cancelling via recorded Kimi pids — see D2.
- `review-gate.ts:61-63` calls the 8 s timeout "the only governor" — see D4.

---

## 9. `runtime/vendor/` (one line each)

- `vendor/shell-quote/` — the `parse()` half of `shell-quote@1.8.3` (MIT) as TS, with the upstream
  1.9.0 GHSA-395f-4hp3-45gv accumulator fix backported; `quote()` is deliberately not shipped.
  `index.ts` re-exports `parse` only.
- `vendor/smol-toml/` — the parser subset of `smol-toml@1.6.1` (BSD-3-Clause) with the 1.7.1
  GHSA-7w5x-hrqm-74c2 EOF-comment guard patched into `util.js`; vendored because the plugin uses the
  internal `parseKey`/`extractValue`/`skipVoid` interfaces that later releases changed.

Both are invisible to package-manager audits; the repo compensates with
`tests/runtime/shell-quote-linear.test.ts` and `tests/runtime/toml-eof-comment.test.ts`, which
exercise the source copy *and* both shipped mirrors in a child process with a hard timeout.
