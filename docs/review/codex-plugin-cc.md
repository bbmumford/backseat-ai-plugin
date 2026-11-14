# Line-by-line review: `codex-plugin-cc` (upstream OpenAI Codex plugin for Claude Code)

Reviewed tree: a local clone of [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)
HEAD at review time: `db52e28 Remove shell expansion for git commands (#447)`; plugin version `1.0.6` (`plugins/codex/.claude-plugin/plugin.json:3`).

All paths below are relative to that repo root. Every file under `plugins/codex/` was read in full, plus `README.md`, `package.json`, `scripts/bump-version.mjs`, `.github/workflows/pull-request-ci.yml`, and all of `tests/`.

Size: 15 `.mjs` modules + 2 entry scripts + 1 hook pair ≈ 4.5k lines of JS; 8 command files, 1 agent, 3 skills (+3 reference docs), 2 prompts, 1 JSON schema; 10 test files ≈ 3.7k lines.

---

## 1. Capability inventory

### 1.1 Slash commands (`plugins/codex/commands/`)

| Command | File | Frontmatter | What it does | Implementation |
|---|---|---|---|---|
| `/codex:review` | `commands/review.md` | `disable-model-invocation: true`; `allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion`; `argument-hint: '[--wait\|--background] [--base <ref>] [--scope auto\|working-tree\|branch]'` (`commands/review.md:1-6`) | Prompt-driven command (not a `!` command). Claude sizes the diff with `git status --short --untracked-files=all` and `git diff --shortstat` (`commands/review.md:21-29`), asks once via `AskUserQuestion` (`:30-32`), then runs the companion in foreground (`:42-49`) or via `Bash(run_in_background: true)` (`:51-63`). Review-only; stdout must be returned verbatim (`:13-16`, `:47-49`). | `scripts/codex-companion.mjs` subcommand `review` → `handleReview` (`scripts/codex-companion.mjs:755-760`) → `handleReviewCommand` with `reviewName: "Review"` and `validateRequest: validateNativeReviewRequest` |
| `/codex:adversarial-review` | `commands/adversarial-review.md` | same tool set; `argument-hint` adds `[focus ...]` (`commands/adversarial-review.md:1-6`) | Same flow, but keeps user focus text and frames the run as a design challenge (`:8-19`, `:37-45`). | `handleReviewCommand(argv, { reviewName: "Adversarial Review" })` (`scripts/codex-companion.mjs:1038-1042`) |
| `/codex:rescue` | `commands/rescue.md` | `allowed-tools: Bash(node:*), AskUserQuestion, Agent`; **no** `disable-model-invocation` (`commands/rescue.md:1-5`) | Routes to the `codex:codex-rescue` subagent via the `Agent` tool (`:7-8`). Flags: `--background\|--wait`, `--resume\|--fresh`, `--model <model\|spark>`, `--effort <none\|minimal\|low\|medium\|high\|xhigh>`. If neither `--resume` nor `--fresh`, it first calls the hidden `task-resume-candidate --json` helper and asks once (`:23-37`). | `agents/codex-rescue.md` → one `Bash` call to `codex-companion.mjs task ...` → `handleTask` (`scripts/codex-companion.mjs:762-823`) |
| `/codex:transfer` | `commands/transfer.md` | `disable-model-invocation: true`; `allowed-tools: Bash(node:*)`; `argument-hint: "[--source <claude-jsonl>]"` | `!`-command: runs `codex-companion.mjs transfer "$ARGUMENTS"` at expansion time (`commands/transfer.md:8`) and prints the Codex session id + `codex resume <id>`. | `handleTransfer` (`scripts/codex-companion.mjs:825-836`) → `executeTransfer` (`:625-641`) |
| `/codex:status` | `commands/status.md` | `disable-model-invocation: true`; `argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'` | `!`-command (`commands/status.md:8`). With no id, Claude renders the output as one compact Markdown table (`:10-13`); with an id, verbatim. | `handleStatus` (`scripts/codex-companion.mjs:883-908`); snapshots from `lib/job-control.mjs:213-254` |
| `/codex:result` | `commands/result.md` | `disable-model-invocation: true` | `!`-command (`commands/result.md:8`); must present verdict/summary/findings/paths unchanged (`:10-15`). | `handleResult` (`scripts/codex-companion.mjs:910-926`) → `resolveResultJob` (`lib/job-control.mjs:256-279`) + `renderStoredJobResult` (`lib/render.mjs:390-446`) |
| `/codex:cancel` | `commands/cancel.md` | `disable-model-invocation: true` | `!`-command (`commands/cancel.md:8`). | `handleCancel` (`scripts/codex-companion.mjs:963-1022`) |
| `/codex:setup` | `commands/setup.md` | `allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion`; `argument-hint: '[--enable-review-gate\|--disable-review-gate]'` | Runs `setup --json`, and if Codex is absent but npm present, offers `npm install -g @openai/codex` once via `AskUserQuestion`, then re-runs setup (`commands/setup.md:7-32`). Preserves the `!codex login` hint (`:37`). | `handleSetup` (`scripts/codex-companion.mjs:215-239`) → `buildSetupReport` (`:182-213`) |

Note: `$ARGUMENTS` is passed as a **single** quoted shell word in every case; the companion re-splits it with its own tokenizer (`lib/args.mjs:76-128`, invoked from `normalizeArgv`, `scripts/codex-companion.mjs:130-139`).

### 1.2 Hidden/internal subcommands

Declared usage lists 8 subcommands (`scripts/codex-companion.mjs:75-89`), but the dispatcher accepts 10 (`:1031-1066`):

- `task-worker --cwd <dir> --job-id <id>` — the detached background executor (`:838-881`). Not in usage text.
- `task-resume-candidate [--json]` — resumability probe used by `/codex:rescue` (`:928-961`). Not in usage text.
- `help|--help` → `printUsage()` (`:1026-1029`). Unknown subcommand throws (`:1064-1065`), caught at `:1069-1073` → stderr + exit 1.

`task` flags actually parsed: `--model/-m`, `--effort`, `--cwd/-C`, `--prompt-file`, `--json`, `--write`, `--resume-last`, `--resume`, `--fresh`, `--background` (`:762-769`). `review`/`adversarial-review` parse `--base`, `--scope`, `--model/-m`, `--cwd/-C`, `--json`, `--background`, `--wait` (`:712-719`) — **`--background` and `--wait` are parsed and then never read** (see §6.1).

### 1.3 Agent

`agents/codex-rescue.md` — `name: codex-rescue`, `model: sonnet`, `tools: Bash`, `skills: [codex-cli-runtime, gpt-5-4-prompting]` (`agents/codex-rescue.md:1-9`). Contract: a thin forwarder that makes exactly one `Bash` call to `codex-companion.mjs task ...` and returns stdout unchanged (`:22`, `:41-45`); defaults to `--write` unless the user asked for read-only (`:34`); maps `spark` → `gpt-5.3-codex-spark` (`:31`); `--resume` → `--resume-last`, `--fresh` → no resume (`:35-38`).

### 1.4 Skills

- `skills/codex-cli-runtime/SKILL.md` — `user-invocable: false`. Helper contract for the rescue subagent: only `task`, never `setup/review/adversarial-review/status/result/cancel` (`:17`), effort enum (`:35`), write-by-default (`:24`, `:39`).
- `skills/codex-result-handling/SKILL.md` — `user-invocable: false`. Presentation rules; notably the hard stop: "After presenting review findings, STOP… Auto-applying fixes from a review is strictly forbidden" (`:19`).
- `skills/gpt-5-4-prompting/SKILL.md` — `user-invocable: false`. XML-block prompt methodology, with three reference files: `references/prompt-blocks.md` (14 reusable blocks), `references/codex-prompt-recipes.md` (5 end-to-end templates), `references/codex-prompt-antipatterns.md` (6 anti-patterns).

### 1.5 Hooks (`plugins/codex/hooks/hooks.json`)

| Event | Command | Timeout | Script |
|---|---|---|---|
| `SessionStart` | `node "${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs" SessionStart` | 5 s (`hooks/hooks.json:9-10`) | exports `CODEX_COMPANION_SESSION_ID`, `CODEX_COMPANION_TRANSCRIPT_PATH`, `CLAUDE_PLUGIN_DATA` into `$CLAUDE_ENV_FILE` (`scripts/session-lifecycle-hook.mjs:77-81`) |
| `SessionEnd` | same script, `SessionEnd` | 5 s (`hooks/hooks.json:20-21`) | broker shutdown + job cleanup (`scripts/session-lifecycle-hook.mjs:83-114`) |
| `Stop` | `node "${CLAUDE_PLUGIN_ROOT}/scripts/stop-review-gate-hook.mjs"` | **900 s** (`hooks/hooks.json:31-32`) | the review gate (`scripts/stop-review-gate-hook.mjs`) |

### 1.6 Other surfaces

- `scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]` — never user-invoked; spawned by `ensureBrokerSession` (`lib/broker-lifecycle.mjs:140-147`).
- Repo tooling: `npm run bump-version|check-version` (`scripts/bump-version.mjs`), `npm run prebuild` which regenerates app-server types via `codex app-server generate-ts` (`package.json:14`), `npm run build` = `tsc -p tsconfig.app-server.json`, `npm test` = `node --test tests/*.test.mjs`.

---

## 2. Architecture map

### 2.1 `/codex:review` control flow

```
/codex:review [--wait|--background] [--base ref] [--scope ...]
  → Claude sizes diff (git status/shortstat)         commands/review.md:21-29
  → AskUserQuestion (wait vs background)             commands/review.md:30-32
  → Bash: node codex-companion.mjs review "$ARGS"    commands/review.md:45 / :55
```

Inside the companion:

1. `main()` dispatch (`scripts/codex-companion.mjs:1024-1066`) → `handleReview` → `handleReviewCommand`.
2. `parseCommandInput` → `normalizeArgv` (single-string re-tokenize) → `parseArgs` (`:713-719`, `lib/args.mjs:1-74`).
3. `cwd = resolveCommandCwd(options)`; `workspaceRoot = resolveWorkspaceRoot(cwd)` which is `git rev-parse --show-toplevel` with a silent fallback to `cwd` (`:721-722`, `lib/workspace.mjs:3-9`).
4. `resolveReviewTarget(cwd, {base, scope})` (`lib/git.mjs:135-191`): explicit `--base` → `{mode:"branch", baseRef}`; `--scope working-tree` → working tree; `--scope branch` → `detectDefaultBranch` (`lib/git.mjs:94-116`: `origin/HEAD` symbolic-ref, else `main`/`master`/`trunk` local then `origin/*`); `auto` → dirty ⇒ working-tree, else branch.
5. `config.validateRequest?.(target, focusText)` = `validateNativeReviewRequest` (`:271-284`): **any focus text is a hard error** for `/codex:review`, and unsupported targets are rejected. Maps to `{type:"uncommittedChanges"}` or `{type:"baseBranch", branch}` (`:259-269`).
6. Job record created *before* any Codex call: `createCompanionJob` → `generateJobId("review")` (`:731-738`, `lib/state.mjs:124-127`).
7. `runForegroundCommand` (`:658-669`) creates the log file + progress reporter (`createTrackedProgress`, `:580-590`), wraps the run in `runTrackedJob` (`lib/tracked-jobs.mjs:142-203`), writes stdout, and sets `process.exitCode = execution.exitStatus` on failure.
8. `executeReviewRun` (`:358-458`) re-checks `ensureCodexAvailable` + `ensureGitRepository`, **re-resolves the target** (second git round trip), then for `reviewName === "Review"` calls `runAppServerReview`; otherwise it collects context and runs a structured turn (adversarial path).
9. `runAppServerReview` (`lib/codex.mjs:1002-1056`): `withAppServer` → `thread/start` (read-only, ephemeral) → `review/start {threadId, delivery:"inline", target}` → `captureTurn` → returns `{status, threadId, sourceThreadId, turnId, reviewText, reasoningSummary, stderr}`. `reviewText` comes from the `exitedReviewMode` item (`lib/codex.mjs:449-461`).
10. Render: `renderNativeReviewResult` (`lib/render.mjs:288-313`) — a title, `Target:`, Codex's review text verbatim, optional `stderr` block, optional `Reasoning:` list.

The adversarial branch instead builds the prompt from `prompts/adversarial-review.md` via `loadPromptTemplate`/`interpolateTemplate` (`:241-250`, `lib/prompts.mjs:4-13`), runs `turn/start` with `outputSchema = schemas/review-output.schema.json` and `sandbox: "read-only"` (`:411-417`), parses the final message as JSON (`lib/codex.mjs:1188-1213`), and renders with `renderReviewResult` (`lib/render.mjs:211-286`). Context collection (`lib/git.mjs:300-347`) decides inline-diff vs self-collect: inline only when `changedFiles ≤ 2` **and** measured diff bytes `≤ 256 KiB` (`lib/git.mjs:8-9, 309-334`).

### 2.2 The Stop review gate

Trigger: Claude Code `Stop` event → `scripts/stop-review-gate-hook.mjs` with hook JSON on stdin (900 s harness timeout).

```
main()                                      stop-review-gate-hook.mjs:142-176
├─ readHookInput()  JSON.parse(fd 0)                              :21-27
├─ cwd = input.cwd || CLAUDE_PROJECT_DIR || process.cwd()         :144
├─ workspaceRoot = resolveWorkspaceRoot(cwd); config = getConfig  :145-146
├─ jobs = sortJobsNewestFirst(filterJobsForCurrentSession(...))   :148
│    session scoping: input.session_id || CODEX_COMPANION_SESSION_ID  :40-46
├─ runningTaskNote if any queued/running job                      :149-152
├─ if (!config.stopReviewGate) → logNote(note) to stderr; return  :154-157   [ALLOW]
├─ setupNote = buildSetupNote(cwd)  (getCodexAvailability)        :59-67
│    if Codex missing → stderr notes only; return                :159-164   [ALLOW, fail-open]
├─ review = runStopReview(cwd, input)                             :98-140
└─ if (!review.ok) emitDecision({decision:"block", reason}) else logNote     :166-176
```

`runStopReview` (`:98-140`):

1. `prompt = buildStopReviewPrompt(input)` → `prompts/stop-review-gate.md` with `{{CLAUDE_RESPONSE_BLOCK}}` replaced by `"Previous Claude response:\n" + input.last_assistant_message` (`:48-57`).
2. `spawnSync(process.execPath, [codex-companion.mjs, "task", "--json", prompt], {cwd, env: {...process.env, CODEX_COMPANION_SESSION_ID: input.session_id}, timeout: 15*60*1000})` (`:101-110`). No shell; the prompt is one argv element. Sandbox is read-only because `--write` is absent (`scripts/codex-companion.mjs:491`).
3. `ETIMEDOUT` → not-ok with a 15-minute message (`:112-118`); non-zero exit → not-ok with stderr/stdout detail (`:120-128`); unparseable stdout → not-ok (`:130-139`).
4. `parseStopReviewOutput(payload.rawOutput)` (`:69-96`): empty → not-ok; first line starts `ALLOW:` → ok; starts `BLOCK:` → not-ok with that reason; anything else → not-ok ("unexpected answer").

The companion labels this run specially: `buildTaskRunMetadata` matches the literal marker `"Run a stop-gate review of the previous Claude turn."` in the prompt and titles the job "Codex Stop Gate Review" (`scripts/codex-companion.mjs:73, 540-554`); the same literal is duplicated at `scripts/stop-review-gate-hook.mjs:19` (unused there) and is line 2 of `prompts/stop-review-gate.md`.

`schemas/review-output.schema.json` is **not** used by the gate — the gate uses the ALLOW/BLOCK prose contract from `prompts/stop-review-gate.md:14-20`. The schema is only wired into `/codex:adversarial-review` (`scripts/codex-companion.mjs:68, 415`).

### 2.3 App-server broker and session spawn/resume

Client factory `CodexAppServerClient.connect(cwd, options)` (`lib/app-server.mjs:335-353`):

```
disableBroker?  ──yes──────────────────────────────► SpawnedCodexAppServerClient (transport "direct")
       │ no
       ▼
brokerEndpoint = options.brokerEndpoint
              ?? options.env[CODEX_COMPANION_APP_SERVER_ENDPOINT]
              ?? process.env[...]                                   :339
   ├─ none & reuseExistingBroker → loadBrokerSession(cwd)?.endpoint  :340-342
   ├─ none & !reuseExistingBroker → await ensureBrokerSession(cwd)   :343-346
   └─ endpoint ⇒ BrokerCodexAppServerClient (transport "broker")     :348-350
await client.initialize()
```

- Direct transport: `spawn("codex", ["app-server"], {cwd, env, stdio: pipe×3, shell: win32 ? (SHELL||true) : false})` (`lib/app-server.mjs:190-196`), newline-delimited JSON-RPC over stdio via `readline` (`:220-223`), then `initialize` + `initialized` notify (`:225-229`). stderr is accumulated into `this.stderr` (`:201-203`) and surfaced in results after `cleanCodexStderr` (`lib/codex.mjs:54-60`).
- Broker transport: `net.createConnection({path})` against the parsed endpoint (`lib/app-server.mjs:285-310`); endpoint grammar is `unix:<path>` or `pipe:<path>` (`lib/broker-endpoint.mjs:19-41`), created as `unix:<sessionDir>/broker.sock` on POSIX and `pipe:\\.\pipe\<sanitized-dir>-codex-app-server` on Windows (`lib/broker-endpoint.mjs:10-17`).
- Broker lifecycle (`lib/broker-lifecycle.mjs`): `ensureBrokerSession` reuses a live endpoint from `broker.json` in the per-workspace state dir (`:113-117, 72-87`), else tears down the stale one and spawns `app-server-broker.mjs serve` detached with stdout/stderr to `broker.log` (`:59-70, 131-147`), waits up to 2 s for the socket (`:24-41, 149-160`), and persists `{endpoint, pidFile, logFile, sessionDir, pid}` (`:162-170`).
- Broker server (`scripts/app-server-broker.mjs`): one `CodexAppServerClient.connect(cwd, {disableBroker:true})` upstream (`:68`), a `net.createServer` front end, and single-flight ownership: `activeRequestSocket` for the in-flight request, `activeStreamSocket` + `activeStreamThreadIds` for `turn/start`, `review/start`, `thread/compact/start` (`:12, 197-206`). Other sockets get `-32001 "Shared Codex broker is busy."` (`:173-182`), except `turn/interrupt`, which is allowed through during another socket's stream (`:170-195`). Notifications are routed to the current owner and ownership is released on a matching `turn/completed` (`:84-100`). `initialize` is answered locally (`:146-154`), `initialized` swallowed (`:156-158`), `broker/shutdown` shuts down and exits (`:160-164`).
- Fallback: `withAppServer` retries the whole operation against a direct server when the broker says busy, or when a broker was requested but the socket is gone (`ENOENT`/`ECONNREFUSED`) (`lib/codex.mjs:613-642`). `withDirectAppServer` (`:644-651`) bypasses the broker entirely — used only by the session import.

Session spawn/resume:
- New thread: `thread/start` with `{cwd, model, approvalPolicy:"never", sandbox, serviceName:"claude_code_codex_plugin", ephemeral}` (`lib/codex.mjs:62-72, 732-748`); if a `threadName` is given it follows with `thread/name/set`, swallowing only "unknown variant"/"unknown method" errors from older CLIs (`:735-746`).
- Reviews use `ephemeral: true`; tasks use `ephemeral: false` when `persistThread` is set (`lib/codex.mjs:1117`), with the name `"Codex Companion Task: <56-char excerpt>"` (`:48, 107-110, 1184-1186`).
- Resume: `--resume-last` → `resolveLatestTrackedTaskThread` (`scripts/codex-companion.mjs:336-356`) prefers the newest finished tracked job with a `threadId` **scoped to the current Claude session**, throws if a task is still running, and only falls back to `thread/list` discovery when there is no session id (`:351-355`). `findLatestTaskThread` queries `thread/list {cwd, limit:20, sortKey:"updated_at", sourceKinds:["appServer"], searchTerm:"Codex Companion Task"}` (`lib/codex.mjs:1162-1182`). Then `thread/resume` (`:750-752`) and `turn/start` with `DEFAULT_CONTINUE_PROMPT` if no prompt was supplied (`:49-50`, `scripts/codex-companion.mjs:488`).
- Turn capture: `captureTurn` (`lib/codex.mjs:559-611`) installs a notification handler, buffers notifications until the response's `turn.id` is known, filters by `belongsToTurn` (thread + turn id), and resolves on `turn/completed` for the root thread (`:541-553`) or by a 250 ms "inferred completion" timer once a `final_answer` agent message is seen and no collaboration/subagent work is outstanding (`:373-394`).
- Interrupt: `interruptAppServerTurn` connects with `reuseExistingBroker: true` and sends `turn/interrupt {threadId, turnId}` (`lib/codex.mjs:960-1000`).

### 2.4 Background job tracking

State layout (`lib/state.mjs`):

- Root: `$CLAUDE_PLUGIN_DATA/state/<slug>-<sha256(realpath(workspaceRoot)).slice(0,16)>`, or `os.tmpdir()/codex-companion/<slug>-<hash>` when the env var is absent (`:9-13, 29-44`).
- `state.json` = `{version:1, config:{stopReviewGate:false}, jobs:[…]}` (`:19-27`), `jobs/<id>.json` per-job detail, `jobs/<id>.log` per-job log (`:50-52, 183-190`).
- `saveState` prunes to the newest 50 jobs by `updatedAt` and deletes the dropped jobs' `.json` and log files (`:80-116`). `loadState` silently returns defaults on any parse error (`:64-78`).
- `upsertJob` is a read-modify-write of the whole file (`:129-147`).

Job records (`lib/tracked-jobs.mjs`): `createJobRecord` stamps `createdAt` and the `sessionId` from `CODEX_COMPANION_SESSION_ID` (`:60-68`). `runTrackedJob` writes `status:"running"`, `pid: process.pid`, `phase:"starting"` up front, then on success `status` + `threadId`/`turnId`/`result`/`rendered` and appends a "Final output" log block; on throw it writes `status:"failed"` with `errorMessage` and rethrows (`:142-203`). Progress plumbing: `createProgressReporter` fans a normalized event out to stderr (`[codex] …`), the log file, and `createJobProgressUpdater`, which persists only *changes* to `phase`/`threadId`/`turnId` (`:70-132`).

Background launch (`scripts/codex-companion.mjs:684-710`): `enqueueBackgroundTask` creates the log, **spawns the detached worker**, then writes the `queued` job record carrying the serialized `request`. `spawnDetachedTaskWorker` runs `process.execPath <script> task-worker --cwd <cwd> --job-id <id>` with `detached:true, stdio:"ignore", env: process.env` and `unref()`s it (`:671-682`). The worker re-reads the stored job, rebuilds the progress reporter against the existing log file, and runs `executeTaskRun` under `runTrackedJob` (`:838-881`).

Reads (`lib/job-control.mjs`): `buildStatusSnapshot` splits jobs into `running` / `latestFinished` / `recent` (default cap 8), attaches `elapsed`/`duration`/`progressPreview` (last 4 non-title log lines) and a legacy `phase` inference from log text (`:49-76, 103-181, 213-240`). `matchJobReference` supports exact and unique-prefix ids, erroring on ambiguity (`:191-211`). `resolveCancelableJob` scopes implicit selection to the current session (`:281-307`).

Cancel (`scripts/codex-companion.mjs:963-1022`): resolve job → read stored `threadId`/`turnId` → `interruptAppServerTurn` → log → `terminateProcessTree(job.pid)` → write `cancelled` to both the job file and the index.

Session end (`scripts/session-lifecycle-hook.mjs:83-114`): `sendBrokerShutdown(endpoint)` → `cleanupSessionJobs` kills `queued`/`running` jobs of that session and removes **all** of that session's jobs from the index (which prunes their files) → `teardownBrokerSession` (kill pid, unlink pidfile/log/socket, rmdir session dir) → `clearBrokerSession`.

### 2.5 `lib/claude-session-transfer.mjs`

44 lines. `resolveClaudeSessionPath(cwd, {source})`:

1. `requestedPath = options.source || process.env.CODEX_COMPANION_TRANSCRIPT_PATH`; missing → actionable error (`:21-24`).
2. `resolveUserPath` expands `~`/`~/…` then `ensureAbsolutePath(cwd, value)` (`:10-18`, `lib/fs.mjs:5-7`).
3. Extension must be `.jsonl` (`:27-29`).
4. `fs.realpathSync` on both the source and `~/.claude/projects`; failure → "Claude session file not found" (`:31-38`).
5. Containment check via `path.relative` — rejects `""`, `".."`, `"../…"`, and absolute results (`:39-42`), i.e. the file must live strictly inside `~/.claude/projects` after symlink resolution.

Consumer: `executeTransfer` (`scripts/codex-companion.mjs:625-641`) → `importExternalAgentSession` (`lib/codex.mjs:1058-1093`) → `withDirectAppServer` → `externalAgentConfig/import` with a `migrationItems[{itemType:"SESSIONS", details:{sessions:[{path, cwd, title:null}], plugins:[], mcpServers:[], hooks:[], subagents:[], commands:[]}}]` envelope (`:681-699`), waiting for the `externalAgentConfig/import/completed` notification with a 2-minute timeout (`:51-52, 701-730`). The resulting thread id is **not** returned by the RPC — it is recovered by reading `~/.codex/external_agent_session_imports.json` and matching `source_path` + `sha256(content)` (`:653-679`). `-32601` becomes an "update Codex" message (`:1072-1077`); a completed import with no ledger record is a hard error (`:1080-1086`).

---

## 3. The review-gate contract, in full

### 3.1 Two distinct verdict contracts

**(a) Structured review verdict** — `schemas/review-output.schema.json`, used only by `/codex:adversarial-review` as `turn/start.outputSchema`:

```json
{ "type":"object", "additionalProperties": false,
  "required": ["verdict","summary","findings","next_steps"],
  "verdict": "approve" | "needs-attention",
  "summary": string (minLength 1),
  "findings": [ { "severity": "critical"|"high"|"medium"|"low",
                  "title": string≥1, "body": string≥1, "file": string≥1,
                  "line_start": int≥1, "line_end": int≥1,
                  "confidence": number 0..1, "recommendation": string } ],
  "next_steps": [ string≥1 ] }
```
(`schemas/review-output.schema.json:1-87`; every finding field is `required` and `additionalProperties:false` at both levels.)

**(b) Stop-gate verdict** — prose, not JSON: the first line must be exactly `ALLOW: <short reason>` or `BLOCK: <short reason>`, with nothing before it (`prompts/stop-review-gate.md:14-20`). The gate never validates (a).

### 3.2 Block vs allow decision table (`scripts/stop-review-gate-hook.mjs`)

| Condition | stdout | stderr | exit | Effect |
|---|---|---|---|---|
| `config.stopReviewGate` false | — | running-task note if any (`:155`) | 0 | allow |
| gate on, Codex unavailable | — | setup note + running-task note (`:160-163`) | 0 | allow (fail-open) |
| gate on, review `ok` | — | running-task note (`:175`) | 0 | allow |
| first line `ALLOW:` | — | — | 0 | allow (`:80-82`) |
| first line `BLOCK:` | `{"decision":"block","reason":"Codex stop-time review found issues that still need fixes before ending the session: <reason>"}` | — | 0 | block (`:83-89, 168-172`) |
| empty final output | block JSON, reason "returned no final output… Run /codex:review --wait manually or bypass the gate" | — | 0 | block (`:72-77`) |
| first line neither prefix | block JSON, reason "returned an unexpected answer…" | — | 0 | block (`:91-95`) |
| child exit ≠ 0 | block JSON, reason "The stop-time Codex review task failed: <stderr\|stdout>" | — | 0 | block (`:120-128`) |
| child timeout (15 min) | block JSON, "timed out after 15 minutes…" | — | 0 | block (`:112-118`) |
| child stdout not JSON | block JSON, "returned invalid JSON…" | — | 0 | block (`:130-139`) |
| hook itself throws (e.g. bad hook JSON) | — | error message (`:180-183`) | 1 | no decision emitted |

When a job is still running, the running-task note is **prefixed** onto the block reason (`:170`): `"Codex task <id> is still running. Check /codex:status and use /codex:cancel <id> … <review reason>"`.

So: everything except an explicit `ALLOW:` blocks, *unless* the gate is off or Codex is missing. Fail-closed on review failure, fail-open on configuration failure.

### 3.3 Findings rendering back into the Claude session

The gate itself returns only the one-line `reason` string. Full findings reach Claude through the normal command path:

- Structured path: `parseStructuredOutput` (`lib/codex.mjs:1188-1213`) → `renderReviewResult` (`lib/render.mjs:211-286`). Order of checks: no `parsed` → "did not return valid structured JSON" + parse error + raw block; shape invalid per the hand-rolled `validateReviewResultShape` (`:24-41`) → "unexpected review shape" + the specific missing field + raw block; otherwise normalize (`normalizeReviewFinding`, `:43-60`: severity defaults to `low`, title defaults to `Finding N`, body to "No details provided.", file to `unknown`, line_end coerced ≥ line_start) and emit `# Codex <label>`, `Target:`, `Verdict:`, summary, then findings **sorted critical→high→medium→low** (`:1-12, 251`) as `- [sev] title (file:line_start-line_end)` + body + optional `Recommendation:`, then `Next steps:`, then `Reasoning:`.
- `confidence` is required by the schema but is **dropped** by `normalizeReviewFinding` and never rendered.
- Native review path: Codex's own review text passed through verbatim (`lib/render.mjs:288-313`).
- Task path: `renderTaskResult` returns the raw final message unchanged (newline-normalized), else the failure message; its `meta` argument (title/jobId/write) is accepted and ignored (`lib/render.mjs:315-323`).
- Stored results: `renderStoredJobResult` prefers `storedJob.rendered` for structured review jobs, else `result.rawOutput`, else `result.codex.stdout`, else `rendered`, else a synthesized status block; appends `Codex session ID:` + `Resume in Codex: codex resume <threadId>` when a thread id exists (`lib/render.mjs:390-446`).

### 3.4 Env vars and settings keys the gate reads

| Name | Where | Use |
|---|---|---|
| hook stdin JSON `cwd`, `session_id`, `last_assistant_message` | `:143-148, 49` | workspace, session scoping, prompt body |
| `CLAUDE_PROJECT_DIR` | `:144` | cwd fallback |
| `CODEX_COMPANION_SESSION_ID` | `:41, 103` | session scoping; re-exported to the child |
| `CLAUDE_PLUGIN_DATA` | via `lib/state.mjs:9, 41-42` | state dir root (else tmpdir) |
| `CODEX_COMPANION_APP_SERVER_ENDPOINT` | via `lib/app-server.mjs:22, 339` | broker reuse by the spawned task |
| `CODEX_HOME` | via `lib/codex.mjs:654` | only on the transfer path |
| `PATH` | via `binaryAvailable("codex", …)` (`lib/process.mjs:38-51`) | availability probe |
| setting `config.stopReviewGate` in `state.json` | `lib/state.mjs:22, 153-164`; toggled by `/codex:setup --enable-review-gate` (`scripts/codex-companion.mjs:229-235`) | the only persisted plugin setting |
| `hooks.json` `Stop.timeout = 900` | `hooks/hooks.json:32` | harness-side kill |

`stop_hook_active` is **never read** — `grep -rn stop_hook_active plugins/codex` returns nothing.

---

## 4. Provider coupling points (the seam list)

Every place the code assumes Codex/OpenAI specifically.

**P1 — Binary name and subcommand surface.** `spawn("codex", ["app-server"])` (`lib/app-server.mjs:190`); availability = `codex --version` **and** `codex app-server --help` both exiting 0 (`lib/codex.mjs:886-904`). No env override, no configurable path. Seam: a `ProviderRuntime.spawn()` descriptor.

**P2 — JSON-RPC method vocabulary.** Nine request methods are hard-wired in the typed map (`lib/app-server-protocol.d.ts:59-69`); eleven are actually called by name — `account/read` and `config/read` are invoked (`lib/codex.mjs:870-874`) without being in the map, so they are unchecked by `tsc`: `initialize`, `account/read`, `config/read`, `thread/start`, `thread/resume`, `thread/name/set`, `thread/list`, `review/start`, `turn/start`, `turn/interrupt`, `externalAgentConfig/import` (`lib/codex.mjs:724, 733, 737, 751, 870-874, 983, 1026, 1136, 1169`). The broker additionally hard-codes the set of *streaming* methods `{"turn/start","review/start","thread/compact/start"}` (`scripts/app-server-broker.mjs:12`) and the review-specific `result.reviewThreadId` field (`:19-21`).

**P3 — Notification/event vocabulary.** `thread/started`, `thread/name/updated`, `turn/started`, `item/started`, `item/completed`, `error`, `turn/completed` (`lib/codex.mjs:490-556`), plus item types `enteredReviewMode`, `exitedReviewMode`, `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `collabAgentToolCall`, `webSearch`, `agentMessage` (with `phase === "final_answer"` as the completion signal), `reasoning` (`:241-300, 406-488`). The completion heuristic, the subagent accounting, and the whole progress/phase UI are built on these names.

**P4 — Initialize handshake and client identity.** `clientInfo {title:"Codex Plugin", name:"Claude Code", version: plugin.json version}` and `capabilities {experimentalApi:false, requestAttestation:false, optOutNotificationMethods:["item/agentMessage/delta","item/reasoning/summaryTextDelta","item/reasoning/summaryPartAdded","item/reasoning/textDelta"]}` (`lib/app-server.mjs:19-42`). The delta opt-out names are Codex-specific; a provider without them would stream token deltas the client cannot handle.

**P5 — `serviceName: "claude_code_codex_plugin"`** sent on every `thread/start` (`lib/codex.mjs:47, 69`) — a Codex-side attribution/telemetry key.

**P6 — Sandbox/approval vocabulary.** `approvalPolicy:"never"`, `sandbox:"read-only"|"workspace-write"` (`lib/codex.mjs:63-83`; selected at `scripts/codex-companion.mjs:414, 491`). The entire read-only-vs-write safety model is expressed in Codex's enum.

**P7 — Review target and delivery shapes.** `{type:"uncommittedChanges"}` / `{type:"baseBranch", branch}` (`scripts/codex-companion.mjs:259-269`), `delivery: "inline"|"detached"` and the `reviewThreadId` response field (`lib/codex.mjs:1020-1041`). `/codex:review`'s entire value proposition is Codex's *built-in* reviewer; a provider without a review RPC can only be served by the adversarial (prompt+schema) path.

**P8 — Model ids and the alias table.** `MODEL_ALIASES = {spark → "gpt-5.3-codex-spark"}` (`scripts/codex-companion.mjs:72`), repeated in prose at `commands/rescue.md:46`, `agents/codex-rescue.md:31-32`, `skills/codex-cli-runtime/SKILL.md:23, 29`, `README.md:148-162`, and asserted by tests (`tests/commands.test.mjs:117, 137-138, 159`).

**P9 — Reasoning-effort enum.** `{none, minimal, low, medium, high, xhigh}` (`scripts/codex-companion.mjs:71, 114-128`) — `xhigh` is OpenAI-specific; the value is sent as `turn/start.effort` (`lib/codex.mjs:1140`).

**P10 — Auth and provider model.** `account/read` → `{account:{type:"chatgpt"|"apiKey", email}, requiresOpenaiAuth}`; `config/read` → `config.model_provider` + `config.model_providers[id]`; built-in label map `{openai, ollama, lmstudio}`; messages literally say "requires OpenAI authentication" (`lib/codex.mjs:758-866`). Also the "ChatGPT login active for <email>" string (`:828`).

**P11 — Config and state locations on disk.** `CODEX_HOME || ~/.codex` (`lib/codex.mjs:653-655`); the import ledger `~/.codex/external_agent_session_imports.json` with `source_path` / `content_sha256` / `imported_thread_id` record fields (`:661-679`). README documents `~/.codex/config.toml`, `.codex/config.toml`, `openai_base_url` (`README.md:273-320`).

**P12 — Install/login/upgrade instructions.** `npm install -g @openai/codex` appears in 6 code paths (`scripts/codex-companion.mjs:192, 255`; `lib/codex.mjs:1005, 1061, 1098, 1165`) plus `commands/setup.md:22` and the README; `!codex login`, `--device-auth`, `--with-api-key` at `scripts/codex-companion.mjs:194-197`; `@openai/codex@latest` upgrade advice at `lib/codex.mjs:1074`.

**P13 — Resume UX.** `codex resume <threadId>` is rendered into status/result/transfer output (`lib/render.mjs:102-107, 392, 398`; `scripts/codex-companion.mjs:632`).

**P14 — Thread discovery by name convention.** `TASK_THREAD_PREFIX = "Codex Companion Task"` used both as the written thread name and as `thread/list.searchTerm`, with `sourceKinds:["appServer"]` and `sortKey:"updated_at"` (`lib/codex.mjs:48, 107-110, 1169-1180`).

**P15 — Session transfer envelope.** `externalAgentConfig/import` + `migrationItems[].itemType:"SESSIONS"` + the empty `plugins/mcpServers/hooks/subagents/commands` arrays + the `externalAgentConfig/import/completed` notification name (`lib/codex.mjs:51, 681-730`). Also Claude-side coupling: `~/.claude/projects` and `.jsonl` transcripts (`lib/claude-session-transfer.mjs:8, 27`).

**P16 — stderr noise filtering.** Drops exactly `"WARNING: proceeding, even though we could not update PATH:"` (`lib/codex.mjs:54-60`).

**P17 — RPC error-code semantics.** `-32601` ⇒ "this Codex version is too old" (`lib/codex.mjs:1072-1077`); "unknown variant"/"unknown method" substring sniffing for `thread/name/set` (`:739-745`); `-32001` reserved as the broker-busy code (`lib/app-server.mjs:23`).

**P18 — Prompt wording.** `prompts/adversarial-review.md:2` ("You are Codex performing an adversarial software review"); the whole `skills/gpt-5-4-prompting/` tree is named and written for GPT-5.4 (`SKILL.md:1-11`, references). `prompts/stop-review-gate.md` is symmetrically coupled to Claude ("the previous Claude turn", `/codex:setup`, `/codex:status`).

**P19 — Build-time type generation.** `prebuild` runs `codex app-server generate-ts --out plugins/codex/.generated/app-server-types` (`package.json:14`), and the type surface imports from that generated tree including a `v2/` namespace (`lib/app-server-protocol.d.ts:1-30`, `tsconfig.app-server.json:16-22`). CI installs the real Codex CLI to build (`.github/workflows/pull-request-ci.yml:28-35`). Type-checking the plugin therefore *requires* Codex on the machine.

**P20 — Naming/identity throughout.** Plugin name `codex`, author `OpenAI`, marketplace `openai-codex` (`plugins/codex/.claude-plugin/plugin.json:2-7`, `.claude-plugin/marketplace.json:1-20`), command namespace `/codex:*`, agent `codex:codex-rescue`, env prefix `CODEX_COMPANION_*`, state dir `codex-companion`, log prefix `[codex]` (`lib/tracked-jobs.mjs:126`), job id prefixes `review-`/`task-`.

**Where the seam is cheapest:** P1/P2/P3/P4/P6/P7 are one adapter (a `ProviderClient` with `startThread/resumeThread/startTurn/startReview/interrupt/listThreads/authStatus` plus an event normalizer that maps provider notifications into the existing `TurnCaptureState` shape). P8/P9/P10/P11/P12/P13 are provider metadata/strings tables. P14/P15/P19 need real per-provider implementations (or must be degraded gracefully). P5/P16/P17 are small per-provider quirk hooks.

---

## 5. Reusable vs. rewrite, per module

| Module | Lines | Verdict | Reasoning |
|---|---|---|---|
| `lib/args.mjs` | 128 | **Reuse as-is** (but fix the tokenizer, §6.2) | Pure argv parsing, zero provider knowledge. |
| `lib/fs.mjs` | 40 | **Reuse as-is** | Generic fs helpers; `readStdinIfPiped` is the only risky one. |
| `lib/workspace.mjs` | 9 | **Reuse as-is** | Git-root-or-cwd, nothing else. |
| `lib/prompts.mjs` | 13 | **Reuse as-is** | `{{UPPER_SNAKE}}` template loader; keep, but add per-provider prompt directories. |
| `lib/process.mjs` | 135 | **Reuse with abstraction** | Generic spawn/kill, but the win32 `shell: SHELL || true` default (`:12`) is a footgun that every caller must opt out of; invert the default. |
| `lib/git.mjs` | 347 | **Reuse as-is** | Fully provider-agnostic review-context collection, correctly shell-free (`:11-18`). The best-engineered module here. Only `buildAdversarialCollectionGuidance` wording is prompt-adjacent. |
| `lib/state.mjs` | 191 | **Reuse with abstraction** | Layout is sound but single-provider: `config` has one key and job records have no provider field. Needs atomic writes + a `provider` dimension in the id/state keys. |
| `lib/tracked-jobs.mjs` | 204 | **Reuse with abstraction** | Progress/job lifecycle is generic; the normalized event shape (`phase`, `threadId`, `turnId`, `logTitle`) encodes Codex's notification model and the `[codex]` stderr prefix (`:126`). |
| `lib/job-control.mjs` | 308 | **Reuse with abstraction** | Selection/snapshot logic is generic; `inferLegacyJobPhase` pattern-matches Codex log strings ("Thread ready", "Reviewer started", "Starting collaboration tool:") (`:109-159`), and `getJobTypeLabel` hard-codes the `rescue`/`review` taxonomy (`:27-47`). |
| `lib/render.mjs` | 465 | **Reuse with abstraction** | Markdown rendering of a provider-neutral verdict shape; only `formatCodexResumeCommand` / "Codex session ID" / `# Codex <label>` headings are provider strings (`:102-107, 139-143, 214, 292`). Drop-in after a label/resume-command injection. |
| `lib/claude-session-transfer.mjs` | 44 | **Reuse as-is** | Claude-side only (source of the transfer), and the containment check is the right shape. |
| `lib/broker-endpoint.mjs` | 41 | **Reuse as-is** | `unix:`/`pipe:` grammar, no provider knowledge. |
| `lib/broker-lifecycle.mjs` | 209 | **Reuse with abstraction** | Generic detached-daemon lifecycle; keyed per workspace only, so it must become per workspace **× provider × Claude session** (§6.7). |
| `lib/app-server.mjs` | 354 | **Reuse with abstraction** | The JSONL JSON-RPC client core (framing, pending map, notification dispatch, dual transport) is reusable; `spawn("codex", ["app-server"])` and the initialize payload are the provider seam (`:190, 19-42`). Split into `JsonRpcStdioClient` + provider descriptor. |
| `lib/codex.mjs` | 1219 | **Provider-specific** | This *is* the Codex adapter: method names, item types, auth model, config paths, import ledger, thread naming. Keep `captureTurn`/`TurnCaptureState` as the neutral event accumulator and push everything else behind an interface. |
| `scripts/app-server-broker.mjs` | 252 | **Reuse with abstraction** | Single-flight multiplexer is generic except `STREAMING_METHODS` and `reviewThreadId` (`:12, 19-21`), which should come from the provider descriptor. Needs the re-entrancy fix (§6.3). |
| `scripts/codex-companion.mjs` | 1073 | **Reuse with abstraction** | The CLI shell, job orchestration, and command handlers are reusable; `MODEL_ALIASES`, the effort enum, every "install Codex" string, and the native-review target mapping are provider-specific (`:71-72, 192-197, 255, 259-284`). |
| `scripts/stop-review-gate-hook.mjs` | 184 | **Reuse with abstraction** | Gate logic is provider-neutral once the child command and the ALLOW/BLOCK prompt are parameterized; the duplicated marker literal (`:19`) should be imported, not copied. |
| `scripts/session-lifecycle-hook.mjs` | 133 | **Reuse with abstraction** | Env export + teardown is generic; it tears down exactly one broker (`:85-113`), which won't survive multiple providers. |
| `schemas/review-output.schema.json` | 87 | **Reuse as-is** | Provider-neutral verdict schema. Good merge candidate as the canonical output contract. |
| `prompts/adversarial-review.md` | 84 | **Reuse with abstraction** | Strong content; only the role line names Codex (`:2`). |
| `prompts/stop-review-gate.md` | 36 | **Reuse as-is** | Claude-side framing, no provider names. |
| `skills/gpt-5-4-prompting/**` | 476 | **Provider-specific** (content largely portable) | The block taxonomy and anti-patterns are good general prompt engineering; the name, "GPT-5.4" framing, and `task`/`--resume-last` helper references are Codex-specific. |
| `skills/codex-cli-runtime/SKILL.md` | 43 | **Provider-specific** | It is literally the Codex helper contract (flags, model alias, write default). |
| `skills/codex-result-handling/SKILL.md` | 21 | **Reuse as-is** | Presentation discipline; only "Codex" appears as a label. The "never auto-apply review fixes" rule (`:19`) is worth keeping verbatim. |
| `agents/codex-rescue.md`, `commands/*.md` | ~330 | **Provider-specific** | One per provider, or one generic command with a `--provider` flag; the current text duplicates the flag contract across command, agent, and skill (three copies kept in sync only by `tests/commands.test.mjs`). |
| `scripts/bump-version.mjs` | 227 | **Reuse with abstraction** | Clean multi-manifest version sync; the `TARGETS` list and the `plugins[codex]` lookup (`:134-138`) are repo-shaped. |

---

## 6. Defects and risks

Ordered roughly by severity. Each item: the mechanism, the citation, and the failure scenario.

### 6.1 `--background` is silently ignored by `review` / `adversarial-review`
`handleReviewCommand` declares `booleanOptions: ["json","background","wait"]` (`scripts/codex-companion.mjs:715`) and never reads either flag; the review always runs inline. Detachment happens only because `commands/review.md:51-63` tells Claude to use `Bash(run_in_background:true)`. Scenario: anything that invokes the companion directly — the rescue agent, a script, a user running the documented `node … review --background` — blocks for the full review and gets the complete payload instead of a queued job id. The test suite encodes the current behavior rather than flagging it (`tests/runtime.test.mjs:1034-1063`: `review --background` returns a finished payload). Also, `task --background` exists and behaves differently, so the two commands' flag semantics diverge.

### 6.2 `splitRawArgumentString` corrupts backslashes and apostrophes
`lib/args.mjs:89-92` treats `\` as a universal escape and `:103-106` treats `'`/`"` as quote delimiters, then `normalizeArgv` applies this to the whole `"$ARGUMENTS"` string whenever there is exactly one argv element (`scripts/codex-companion.mjs:130-139`). Scenarios:
- `--cwd C:\Users\me\repo` → `C:Usersmerepo` (every backslash eaten). All Windows paths passed through a slash command are destroyed.
- `/codex:adversarial-review question the user's retry design` → the `'` opens an unterminated quote; tokens become `…user` + `s retry design`, and the rejoined focus text loses the apostrophe (`:723` joins positionals with a single space). Free-text focus and rescue prompts are silently mangled.
- An unterminated `"` swallows all later flags into one positional, so `--base main` inside an unbalanced quote stops being a flag.

### 6.3 Broker re-entrancy: the per-socket `data` handler is `async` and awaits inside its own loop
`scripts/app-server-broker.mjs:123-223`: `socket.on("data", async (chunk) => { buffer += chunk; while (…) { … await appClient.request(...) … } })`. A second `data` event during the `await` re-enters the handler, mutating the shared `buffer` and issuing a second upstream request concurrently. Scenario: a client pipelines two lines in separate TCP segments (or one segment split by the kernel) → requests are forwarded out of order, `activeRequestSocket` bookkeeping is clobbered (`:198, 207-209`), and `buffer` slicing can interleave such that a line fragment is parsed as invalid JSON (`:139-143`). The single-flight invariant the broker exists to enforce is not actually enforced per socket.

### 6.4 Detached worker can start before its job file exists
`enqueueBackgroundTask` spawns the worker at `scripts/codex-companion.mjs:688` and only then writes the job file at `:697`. The worker's first action is `readStoredJob` (`:849-852`) and it throws `No stored job found for <id>` if the file isn't there yet. Scenario: on a loaded or network-backed filesystem (a cloud-synced folder, say), the fork wins the race; `/codex:status <id>` then shows a job stuck at `queued` forever with no worker and no error surfaced to the user (the worker's stderr goes to `stdio:"ignore"`, `:677`). Fix is trivial: write then spawn, then patch the pid.

### 6.5 A mid-turn app-server death hangs the caller forever
`captureTurn` awaits `state.completion` (`lib/codex.mjs:606`), which is resolved only by `turn/completed` or the inferred-completion timer. `handleExit` rejects outstanding **requests** but never touches the capture promise (`lib/app-server.mjs:163-176`). Scenario: `codex app-server` is OOM-killed after `turn/start` returns → no further notifications → the foreground command hangs (and the Claude Bash call hangs with it), or the background job stays `running` with a dead pid until the session ends. There is no turn-level timeout anywhere; the only timeouts in the codebase are the import's 2 minutes (`lib/codex.mjs:52`) and the stop gate's 15 minutes.

### 6.6 Stop gate has no `stop_hook_active` guard and its internal timeout equals the harness timeout
No reference to `stop_hook_active` exists in the plugin (verified by grep), so each blocked stop re-runs the full gate; the README only warns in prose ("can create a long-running Claude/Codex loop and may drain usage limits quickly", `README.md:236-237`). Separately, `STOP_REVIEW_TIMEOUT_MS = 15*60*1000` (`scripts/stop-review-gate-hook.mjs:16`) is exactly the harness `timeout: 900` seconds (`hooks/hooks.json:32`), so the harness and the child race: the hook is as likely to be killed (producing no decision at all) as it is to emit its own "timed out" block message. Also note the gate blocks on *every* non-ALLOW outcome including transport failures (§3.2), so a flaky Codex install converts into an unstoppable session.

### 6.7 One broker per workspace, shared across Claude sessions
`broker.json` lives in the per-workspace state dir (`lib/broker-lifecycle.mjs:72-74` + `lib/state.mjs:29-44`), keyed by workspace root only — no session id. `SessionEnd` unconditionally sends `broker/shutdown`, kills the pid, unlinks the socket, and clears the record (`scripts/session-lifecycle-hook.mjs:83-114`). Scenario: two Claude Code sessions open on the same repo; session A ends while session B has a review in flight → B's upstream app-server is killed mid-turn, which lands in §6.5 (hang) or an abrupt `codex app-server exited unexpectedly` (`lib/app-server.mjs:209-218`). Related: `ensureBrokerSession` has a classic check-then-act race (`:113-171`) — two concurrent commands both see no live broker, both spawn one, and the loser's broker is leaked (its `sessionDir` is only known via the overwritten `broker.json`).

### 6.8 `terminateProcessTree` kills a process group from an unvalidated, possibly-recycled pid
`lib/process.mjs:100-117` tries `kill(-pid, SIGTERM)` first and falls back to `kill(pid)`. The pid comes straight out of `state.json` with no check that it is still a Codex job: `scripts/codex-companion.mjs:986` (cancel) and `scripts/session-lifecycle-hook.mjs:65` (session end). For foreground jobs `runTrackedJob` stores `pid: process.pid` — the companion process itself (`lib/tracked-jobs.mjs:148`). Scenarios: (a) stale `running` record + pid reuse ⇒ `/codex:cancel` SIGTERMs an unrelated process group; (b) cancelling a *foreground* job targets the companion's own group, which in some shells is shared with the invoking tool process. On Windows the same code shells out to `taskkill /T /F` (`:67`) with the same unverified pid.

### 6.9 State file is non-atomic, unlocked, and silently resets on corruption
`saveState` is read-modify-write + `writeFileSync` with no temp-and-rename and no lock (`lib/state.mjs:92-116`), and `loadState` swallows any parse error and returns `defaultState()` (`:64-78`, `defaultState` at `:19-27`). Concurrent writers are the norm, not the exception: the foreground command, the detached worker, and `createJobProgressUpdater` on every phase/thread/turn change (`lib/tracked-jobs.mjs:70-115`). Scenarios: (a) lost updates — a job's `threadId` written by the worker is clobbered by the parent's next `upsertJob`; (b) a crash or a sync client's partial write leaves truncated JSON, after which **`stopReviewGate` silently reverts to `false`** and the whole job index disappears — the review gate turns itself off with no message. (c) `saveState` also deletes the files of any job that falls out of the newest-50 window (`:105-112`), including the log of a *running* job whose `updatedAt` has gone stale.

### 6.10 `/codex:result <id>` reports the wrong error for a running job
`resolveResultJob` (`lib/job-control.mjs:256-279`) calls `matchJobReference` with a finished-only predicate; with an explicit reference and no finished match, `matchJobReference` **throws** `No job found for "<ref>"` (`:210`) before the second lookup at `:269` can produce the intended `Job <id> is still <status>` message. The `if (active)` branch is therefore dead for the reference case. Scenario: a user runs `/codex:result task-abc` while the task is running and is told the job does not exist.

### 6.11 `/codex:cancel` can report `turnInterrupted: true` when nothing was interrupted
`interruptAppServerTurn` connects with `reuseExistingBroker: true` (`lib/codex.mjs:982`); when no broker record exists it falls through to spawning a **fresh direct** app-server (`lib/app-server.mjs:340-350`) and sends `turn/interrupt` to a server that has never seen that thread. Any non-error response is reported as `interrupted: true` and logged as "Requested Codex turn interrupt" (`scripts/codex-companion.mjs:977-984, 1017-1018`). Scenario: a job started in another Claude session (or after a broker teardown) is "cancelled" in the UI while the real Codex turn keeps running and keeps writing to the workspace — recall that rescue tasks default to `--write` (`agents/codex-rescue.md:34`).

### 6.12 `withAppServer`'s direct-retry can re-execute a write-capable turn
`lib/codex.mjs:613-642` retries the *entire* callback against a direct client when the broker reports busy or the socket is missing. The callback is `runAppServerTurn`'s body, i.e. `thread/start` + `turn/start`. Scenario: the broker accepts `thread/start`, then returns `-32001` for `turn/start` (another socket grabbed the stream in between, `scripts/app-server-broker.mjs:173-182`) → the retry starts a second thread and a second turn. With `sandbox: "workspace-write"` that is a duplicated set of edits; at minimum it orphans a thread and the job's recorded `threadId` no longer matches the thread that did the work.

### 6.13 Prompt injection into the stop gate (and into reviews)
`buildStopReviewPrompt` interpolates `input.last_assistant_message` verbatim into the gate prompt (`scripts/stop-review-gate-hook.mjs:48-57`; template slot at `prompts/stop-review-gate.md:11`). The gate's decision is a one-line `ALLOW:`/`BLOCK:` prefix match (`:79-89`). Scenario: a turn whose assistant text contains attacker- or file-derived content ending in an instruction to answer `ALLOW: nothing to review` can neutralize the gate. The prompt tries to defend with grounding rules (`prompts/stop-review-gate.md:28-32`) but the decision channel is still in-band. The same shape applies to `{{REVIEW_INPUT}}` in `prompts/adversarial-review.md:82-84`, which embeds raw diff content, and to `{{USER_FOCUS}}` (`:9`).

### 6.14 Untracked file contents are embedded in prompts
`formatUntrackedFile` inlines up to 24 KiB of each untracked file into the review context (`lib/git.mjs:7, 197-223`), including on the "lightweight" path (`:244`). The file list comes from `git ls-files --others --exclude-standard` (`:125`), so gitignored files are excluded — but any un-ignored, uncommitted file is sent to the provider. Scenario: a developer drops `credentials.json` or a customer data export in the repo without ignoring it, runs `/codex:adversarial-review`, and the contents leave the machine. No redaction and no size/extension allowlist beyond the binary sniff (`lib/fs.mjs:25-33`).

### 6.15 State and logs land in a world-readable tmp directory when `CLAUDE_PLUGIN_DATA` is unset
`FALLBACK_STATE_ROOT_DIR = os.tmpdir()/codex-companion` (`lib/state.mjs:10, 42`) created with `fs.mkdirSync(..., {recursive:true})` and default permissions (`:54-56`); job logs contain assistant messages, reasoning summaries, and full review output (`lib/tracked-jobs.mjs:44-49`, `lib/codex.mjs:437-443, 452-458, 468-475`). Scenario: on a shared host, any local user can read another user's review findings and prompts. (The broker's own `mkdtemp` dir is 0700, so the socket itself is fine — `lib/broker-lifecycle.mjs:15-17`.)

### 6.16 `$ARGUMENTS` interpolation inside `!`-commands and Bash blocks is quote-fragile
`commands/cancel.md:8`, `commands/result.md:8`, `commands/status.md:8`, `commands/transfer.md:8` embed `"$ARGUMENTS"` inside a double-quoted shell word; `commands/review.md:45, 55` and `commands/adversarial-review.md:50, 60` do the same inside Bash/`run_in_background` commands. Commit `6a5c2ba` added the quotes, which fixes word-splitting but not embedded double quotes, `$(…)`, or backticks. Scenario: `/codex:status foo"; id; echo "` closes the quote and runs an extra command under the `Bash(node:*)` permission that the user already granted. The `allowed-tools: Bash(node:*)` prefix rule does not constrain what follows a `;`.

### 6.17 Buffered notifications skip the `thread/started` special case
In `captureTurn`'s live handler, `thread/started` and `thread/name/updated` are applied *before* the `belongsToTurn` filter (`lib/codex.mjs:569-572`); in the buffered replay loop they are not (`:591-599`), so a subagent's `thread/started` that arrives before the `turn/start` response is handed to `previousHandler` and the thread is never registered. Consequences: that subagent's `turn/started`/`item/completed` events then fail `belongsToTurn` and are dropped, so `activeSubagentTurns` is never populated and `scheduleInferredCompletion` can fire while the subagent is still working (`:373-394`), truncating the captured output; subagent labels also go missing in the log (`:216-221`).

### 6.18 Completion is partly a 250 ms heuristic, and `state.error` does not affect the exit status
`scheduleInferredCompletion` declares a turn finished 250 ms after a `final_answer` message when no collaboration is outstanding (`lib/codex.mjs:383-393`); `buildResultStatus` looks only at `finalTurn.status` (`:754-756`), so an `error` notification (`:537-540`) that is followed by a `completed` turn yields exit status 0 with the error silently dropped into an unread field. Scenario: a partially failed run is reported as success, and `runTrackedJob` records it as `completed` (`lib/tracked-jobs.mjs:156`).

### 6.19 Unbounded `maxBuffer` on several git invocations
`runCommand` passes `maxBuffer: options.maxBuffer` (`lib/process.mjs:13`), i.e. Node's 1 MiB default when unset. The *measured* diff paths pass an explicit cap (`lib/git.mjs:40-52, 311-331`), but `git status --short --untracked-files=all` (`:227`), `git log --oneline --decorate <range>` (`:267`), `git diff --stat` (`:268`), and the `--name-only` listings (`:123-125, 266, 326`) do not. Scenario: a repo with tens of thousands of untracked files or commits makes `gitChecked` throw a raw `ENOBUFS`, and the user sees `git status --short --untracked-files=all: exit=null: …` (`lib/process.mjs:120-134`) instead of an actionable message. Related minor issue: all of these split on `"\n"`, so filenames containing newlines would be mis-parsed (mitigated in practice by git's default path quoting).

### 6.20 Smaller items worth carrying into the merged plugin

- **Win32 shell default inverted.** `lib/process.mjs:12` defaults to `shell: process.env.SHELL || true` on Windows for *every* `runCommand` caller. `lib/git.mjs:12-18` now explicitly passes `shell:false` (that is commit `db52e28`, with a regression test at `tests/git.test.mjs:41-68` that proves a branch named `main&branch-helper&x` is not shell-expanded), and `lib/app-server.mjs:194` keeps `shell: SHELL || true` for the `codex` spawn. The dangerous default survives for any future caller; `terminateProcessTree`'s `taskkill` path (`lib/process.mjs:67`) also runs through it. Invert it and opt in where needed.
- **Duplicated constants with no shared source.** `SESSION_ID_ENV` is defined twice (`lib/tracked-jobs.mjs:6`, `scripts/session-lifecycle-hook.mjs:20`); the stop-gate marker string is defined in three places and must match `prompts/stop-review-gate.md:2` (`scripts/codex-companion.mjs:73`, `scripts/stop-review-gate-hook.mjs:19`); `looksLikeVerificationCommand` is copy-pasted (`lib/codex.mjs:101-105` vs `lib/job-control.mjs:103-107`); `shorten` exists in two variants (`scripts/codex-companion.mjs:163-172`, `lib/codex.mjs:90-99`); `buildJsonRpcError` is duplicated (`lib/app-server.mjs:44-46`, `scripts/app-server-broker.mjs:25-27`). Editing the prompt silently breaks the job title; editing the marker silently breaks nothing visible — both are invisible-coupling traps.
- **`confidence` is required by the schema and never shown.** `schemas/review-output.schema.json:68-72` + `prompts/adversarial-review.md:56` demand it; `normalizeReviewFinding` drops it (`lib/render.mjs:51-59`). Either render it or stop requiring it.
- **Review target resolved twice.** `handleReviewCommand` resolves the target for job metadata (`scripts/codex-companion.mjs:724-727`) and `executeReviewRun` resolves it again (`:362-365`), doubling the git work and opening a TOCTOU window in which a file save flips `auto` from working-tree to branch between the two calls.
- **Job records are created before availability checks.** `createCompanionJob` runs at `:731-738`, and `ensureCodexAvailable` only inside `executeReviewRun` (`:359`), so a machine without Codex accumulates `failed` review jobs in the index.
- **`readStdinIfPiped` can block.** `lib/fs.mjs:35-39` does a synchronous `readFileSync(0)` whenever stdin is not a TTY; `readTaskPrompt` calls it whenever no positional prompt and no `--prompt-file` were given (`scripts/codex-companion.mjs:643-650`). Under a harness that hands the child an open pipe, `task` with no prompt hangs instead of printing the "Provide a prompt…" error at `:652-656`.
- **`readJsonFile` throws through the ledger path.** `importedThreadIdForSource` → `readJsonFile` (`lib/codex.mjs:666`, `lib/fs.mjs:13-15`) with no try/catch: a malformed `~/.codex/external_agent_session_imports.json` surfaces as a bare `Unexpected token …` from `/codex:transfer`.
- **Broker can wedge permanently.** If a streaming turn never emits a matching `turn/completed` (crash, interrupt delivered out of band), `activeStreamSocket` is cleared only on socket close (`scripts/app-server-broker.mjs:74-82, 225-233`); until that client's socket closes, every other client gets `-32001` and silently degrades to its own direct app-server (`lib/codex.mjs:622-635`) — i.e. the "one shared runtime" guarantee quietly disappears, which also means `interruptAppServerTurn` can no longer reach the real turn (§6.11).
- **Brokered runs lose stderr.** `client.stderr` is only populated by the direct transport (`lib/app-server.mjs:201-203`); `BrokerCodexAppServerClient` never sets it, so `cleanCodexStderr(client.stderr)` returns `""` for every brokered result (`lib/codex.mjs:1053, 1154`) and failure diagnostics in `renderNativeReviewResult` (`lib/render.mjs:306-308`) disappear exactly when a shared runtime is in use.
- **`handleServerRequest` refuses every server→client request** with `-32601` (`lib/app-server.mjs:156-161`). That is a deliberate simplification, but it means any future provider feature that needs a client callback (approval prompts, credential refresh, file-write confirmation) fails hard rather than degrading — and it is the reason `approvalPolicy:"never"` is mandatory here.
- **Trusting `CODEX_COMPANION_APP_SERVER_ENDPOINT` from the environment.** `lib/app-server.mjs:339` will connect to any endpoint named in the env, and the session hook writes env values into `$CLAUDE_ENV_FILE` (`scripts/session-lifecycle-hook.mjs:35-40`). On a shared machine this is a local MITM seam for every prompt and every file the plugin sends; there is no handshake check that the peer is a broker the plugin started.
- **`enrichJob`'s `inferLegacyJobPhase` reads log prose.** `lib/job-control.mjs:109-159` infers phase by prefix-matching log lines that are produced elsewhere in English (`lib/codex.mjs:241-300`). Any wording change in the progress messages silently degrades `/codex:status`.
- **`parseArgs` swallows unknown flags into positionals** (`lib/args.mjs:48, 70`): `/codex:status --jsonn` is treated as a job reference and produces `No job found for "--jsonn"`; `review --scop branch` silently reviews the default target. No unknown-flag error anywhere.
- **`getCodexAvailability` spawns two processes per call** (`lib/codex.mjs:887-892`) and is called from `ensureCodexAvailable`, `runAppServerTurn`/`runAppServerReview`, `getCodexAuthStatus`, and `buildSetupNote` — 4–6 extra process spawns on a single `/codex:review`, plus one more `git rev-parse` per `resolveWorkspaceRoot`/`resolveStateDir` call (`lib/state.mjs:30`, called on every `loadState`).
- **`appendEnvVar` is a no-op without `CLAUDE_ENV_FILE`** (`scripts/session-lifecycle-hook.mjs:36-40`), so on harnesses that do not provide it the whole session-scoping feature degrades silently: no `sessionId` on jobs ⇒ `filterJobsForCurrentClaudeSession` returns everything (`scripts/codex-companion.mjs:298-304`), and `/codex:cancel` with no id can select another session's job.
- **Results do not survive the session.** `cleanupSessionJobs` removes every job of the ending session from the index (`scripts/session-lifecycle-hook.mjs:71-74`), and `saveState` then deletes their `.json` and `.log` files (`lib/state.mjs:105-112`). `/codex:result` after a restart reports "No finished Codex jobs found for this repository yet." That is defensible as a design choice but is undocumented in the README.
- **CI cannot type-check without the provider.** `npm run build` depends on types generated by `codex app-server generate-ts` (`package.json:14`, `.github/workflows/pull-request-ci.yml:28-35`), and `plugins/codex/.generated/` is not committed, so `tsc` fails on a machine without Codex. For a multi-provider plugin this needs either committed types or a provider-neutral protocol definition.
- **`strict: false` in the only type-checked config** (`tsconfig.app-server.json:9-13`, with `noImplicitAny:false` and `useUnknownInCatchVariables:false`) and only 5 of 15 lib files in `include` (`:15-22`) — the job/state/render/git layer is never type-checked at all.

### 6.21 What the tests do and do not cover

Strong: a 658-line fake `codex` app-server fixture (`tests/fake-codex-fixture.mjs`) exercising auth variants, subagents, late messages, missing `turn/completed`, interrupts, slow turns, and the import ledger; 61 runtime tests including broker reuse, session scoping, cancel-with-interrupt, and all four stop-gate branches (`tests/runtime.test.mjs:1926-2117`); shell-expansion regression for git (`tests/git.test.mjs:41-68`); prose contracts for commands/agent/skills pinned by regex (`tests/commands.test.mjs`).

Gaps that map directly onto the defects above: no test for `splitRawArgumentString` (§6.2) — `lib/args.mjs` has no test file at all; no concurrency tests for `state.json` or `ensureBrokerSession` (§6.7, §6.9); no test that a second client is actually serialized by the broker (§6.3); no test for the enqueue/worker race (§6.4); no test for app-server death mid-turn (§6.5); the broker tests even short-circuit when no broker came up (`tests/runtime.test.mjs:2139-2142, 2184-2187, 2225-2227`), so a platform where the broker never starts reports green while silently testing nothing.
