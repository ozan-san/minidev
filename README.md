# minidev

Ticket → PR pipeline for [pi](https://pi.dev). Open pi in a repo, hand it a ticket, watch subagents
scout, plan, build (one small subtask at a time), test, review and open the PR, all inside a per-ticket git worktree.
minidev explores the repo first and switches mode for **Android**, **iOS / Swift**, **TypeScript / JavaScript**, or **Generic**.

```
/minidev run                 # editor opens: paste ticket (Key/Title/Description/Acceptance)
/minidev run ABC-123         # same, key prefilled (Jira source not wired yet)
/minidev run ./ticket.md     # from a file
/ticket …                    # alias for /minidev run
/minidev ui [show|hide|toggle|details|dismiss]   # show/hide/dismiss the minidev panel or open the details overlay
```

## Pipeline

```
workspace → detect → scout → plan → [approve plan] → build S1..Sn → test ⇄ fix → review → fix → [approve PR] → push + PR
```

## Panel

While a run is active, minidev shows a live widget above the editor plus a status line in the footer with
the current stage, cost and agent. Press `ctrl+shift+m` to toggle the panel (or use `/minidev ui show`,
`/minidev ui hide`, `/minidev ui toggle`). `/minidev ui details` opens a scrollable overlay (close with
`esc`) listing stages, subtasks, agent runs, checks and the full activity log. The panel and the details
overlay are drawn inside a border frame tinted with the color of the stage currently running — each of the
eight stages has its own color. When a run ends the panel is **dismissed** automatically — a successful run
clears it, a paused or failed run keeps it so you can resume.
Set `"ui": { "dismissOn": "never" }` to keep the finished summary on screen, `"terminal"` to dismiss every
run that ends, or run `/minidev ui dismiss` at any time. `hide` only hides (`/minidev ui show` brings it
back); `dismiss` removes the panel and its run state.

## Modes (stack detection)

The `detect` stage reads tracked files in the fresh worktree, picks a mode, runs setup, and derives checks.
`/minidev detect` shows the result for the current repo without starting a run.

| Mode | Detected by | Setup | Subtask check | Final checks | Unit tests = |
|---|---|---|---|---|---|
| **Android** | `AndroidManifest.xml`, Android Gradle plugin, `settings.gradle` | – | `./gradlew assembleDebug` | assemble, `testDebugUnitTest`, `lintDebug` (non-blocking) | `src/test/` |
| **iOS / Swift** | `.xcodeproj`, `.xcworkspace`, `Package.swift`, XcodeGen/Tuist, `.swift` files | `xcodegen generate` / `tuist generate` / `pod install` if needed | Swift package: `swift build`; app: `xcodebuild -scheme <detected> build` (simulator, no signing, per-run DerivedData) | build, `swift test` / `xcodebuild test` on a detected simulator, SwiftLint (non-blocking) | `*Tests/*.swift` |
| **TypeScript / JS** | `package.json` (+ lockfile), `tsconfig.json`, `.ts`/`.js` files | install with the lockfile's manager (`npm ci`, `pnpm install --frozen-lockfile`, yarn, bun) | `typecheck` script or `tsc --noEmit` (else `build`) | typecheck, build, `CI=1 test`, lint (non-blocking) | `*.test.*`, `*.spec.*`, `__tests__/` |
| **Generic** | anything else | – | Rust/Go/Python/Make heuristics; otherwise **the scout's proposed commands** (read from README/CI) | same | `tests/`, `*_test.*`, `test_*.py` |

- Mixed repos (KMP, React Native, …): if two modes score close, you're asked which one to use.
- The mode selects the agents' stack guidance (`agents/stacks/<mode>.md`) and the facts passed to them (package manager, scheme, flavors, …).
- Override: `"stack": "ios"` in `.minidev.json`; checks: `"checks"` (this repo) or `"stacks": { "android": { "checks": … } }` (all your Android repos, in `~/.minidev/config.json`); setup: `"setup"` / `stacks.<mode>.setup`.
- Order of precedence for checks: `checks` ▸ `stacks.<mode>.checks` ▸ detected ▸ scout-proposed.

| Stage | Who | Default model | Notes |
|---|---|---|---|
| workspace | orchestrator | – | `git fetch`, worktree at `~/.minidev/worktrees/<repo>/<KEY>` on `{type}/{key}-{slug}`, copies `local.properties`, `.env*` |
| detect | orchestrator | – | picks the mode, runs setup, derives checks (see Modes) |
| scout | `scout` agent (read-only) | DeepSeek v4.1 Flash | → `context.md` + proposed build/test commands (used when none detected) |
| plan | `planner` agent (read-only) | **Claude Opus 5.5** | → `plan.md` + `plan.json` (small ordered subtasks + test plan) |
| build | `builder` agent, **one fresh conversation per subtask** | DeepSeek v4.1 Flash | after each: subtask check; failures fed back (3 tries); commit per subtask |
| test | `tester` agent + final checks | DeepSeek v4.1 Flash | writes unit tests if the repo has them; runs final checks; fix loop (3 rounds) |
| review | `reviewer` agent | Claude Opus 5.5 | JSON verdict; must-fix items → one builder fix round + re-check |
| pr | orchestrator | – | `git push`, then `gh`/`glab` if detected (configurable), final for review by default (set `pr.draft` to `true` for a draft) |

Pass/fail is decided by **exit codes of your build/test commands**, never by an agent saying "done".

Subagents run **in-process on the [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable)
Harness**: one conversation per run, reset and reconfigured per agent call. A `beforeTool` guard blocks git mutations
and writes outside the worktree. The orchestrator owns git.

## Commands

| | |
|---|---|
| `/minidev run [KEY\|file\|title]` | start a run |
| `/minidev resume [KEY]` | continue a paused/failed run (from the stage/subtask where it stopped) |
| `/minidev approve [KEY]` | approve a pending plan/PR gate and continue (useful headless) |
| `/minidev stop` | stop the active run (aborts the running agent call; resumable) |
| `/minidev status` | runs for this repo |
| `/minidev journal [KEY]` | show the run's pi-durable agent ledger (calls, replays, attempts) |
| `/minidev detect` | show the mode, setup and checks minidev would use here |
| `/minidev ui [show\|hide\|toggle\|details\|dismiss]` | show, hide, dismiss or inspect the live panel |
| `/minidev models` | pick model + thinking per role (default or "this run only"); applies from the next call |
| `/minidev models builder openrouter/deepseek/deepseek-v4.1-flash:high` | non-interactive |
| `/minidev budget <usd> [KEY\|default]` | raise a run's cap / set default cap |
| `/minidev clean [KEY]` | remove a run's worktree (branch + artifacts kept) |
| `/minidev config` | show effective config |

Headless: `pi -p "/minidev run ticket.md"` runs to the first gate and exits; `pi -p "/minidev approve KEY"` continues.
Set `gates.plan/pr = false` for fully unattended runs.

The footer shows the running minidev version and short commit via the `minidev-version` status (e.g. `v0.1.0 (abc1234)`);
the run panel and the `/minidev ui details` header repeat it.

## Budget

`budget.maxUsdPerRun` (default $10) is a hard cap over all agents of a run. Cost is tracked from OpenRouter usage on
every model turn; when the cap is hit the running agent call is aborted at the next turn boundary and the run pauses (`/minidev budget 20` then
`/minidev resume`). Overshoot is at most one model turn. Optional per-role cap: `models.<role>.maxUsdPerCall`.
Warning at `budget.warnAt` (80%).

## Durability

Every run keeps a durable, JSONL-backed `Harness`/Session through
[`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) under `<run dir>/session/`,
where each entry is an atomic append-only commit. A half-written entry is never observed, and the session survives
process death.

Each agent call is submitted as a durable submission keyed deterministically by `` `requestId:inputHash` ``. When a
run is resumed after a pause or crash, a settled successful call with the same key is **replayed** from the session
instead of re-run, and an in-flight submission is **re-attached** rather than restarted. Replay is skipped when the
task, system prompt or model changed (the input hash differs). The single knob is `durable.replay` (`"safe"` |
`"off"`). Nothing is spawned, so the `subagent.isolate`, `subagent.extraArgs` and `durable` block `reapOrphans` settings are gone.

## Config

`defaults ← ~/.minidev/config.json ← <repo>/.minidev.json` (deep merge). See [`minidev.example.json`](minidev.example.json).
Model refs are anything `pi --model` accepts (`pi --list-models <search>`). The `durable` block can be set in
`~/.minidev/config.json` or `<repo>/.minidev.json`; its only knob is `durable.replay` (`"safe"` | `"off"`). The `ui` block controls panel lifetime: `ui.dismissOn`
is `"done"` by default (dismiss after a successful run), `"terminal"` dismisses after any run that ends,
`"never"` keeps the panel until `/minidev ui dismiss`.

## Agent prompts

Each subagent's system prompt = **role contract** + **stack guidance** + detected facts:

```
agents/<role>.md             scout, planner, builder, tester, reviewer — stack-agnostic rules + output format
agents/stacks/android.md     ┐
agents/stacks/ios.md         │ "## All roles" + "## Scout" / "## Planner" / "## Builder" / "## Tester" / "## Reviewer"
agents/stacks/typescript.md  │ sections; each agent gets "All roles" + its own section
agents/stacks/generic.md     ┘
```

Override whole files per user (`~/.minidev/agents/<role>.md`, `~/.minidev/stacks/<mode>.md`) or per repo
(`<repo>/.minidev/agents/…`, `<repo>/.minidev/stacks/…`). Repo `AGENTS.md`/`CLAUDE.md` are also loaded by every subagent.
Keep the output format sections of the role contracts intact; the orchestrator parses them.

## Artifacts

`~/.minidev/runs/<repo>/<KEY>/`: `ticket.md`, `context.md`, `plan.md`, `plan.json`, `test-report.md`, `review.md`,
`pr-body.md`, `state.json`, `session/` (pi-durable session: conversations, agent calls, replays),
`logs/*.log` (check output), `agents/*.jsonl` (committed transcript of each agent call, plus `.system.md`/`.task.md` prompts).

## Install

```bash
pi install ~/minidev      # always loaded
# or per session:
pi -e ~/minidev
```

Requires OpenRouter credentials in pi (`/login openrouter` or `OPENROUTER_API_KEY`).

## Development

```bash
npm ci                           # dev tools only (.npmrc skips peer deps; pi provides them)
npm run typecheck                # finds your pi install at runtime (or set PI_NODE_MODULES)
npm test                         # node:test via native TS type-stripping (Node >= 22.18); tests are extensions/**/*.test.ts
```

Unit tests must not import `@earendil-works/pi-coding-agent` or `@earendil-works/pi-tui` (which are peer packages, absent locally); `@earendil-works/pi-durable` and `@earendil-works/chord` are ordinary dependencies and are fine. Use `import type` for type-only imports.

### CI

GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on every push and pull request to `main`. The `test` job runs `npm ci` followed by `CI=1 npm run -s test` on Node 22.18, and the `typecheck` job installs pi's peer packages with `npm install --no-save` before running `npm run -s typecheck` with `PI_NODE_MODULES=$PWD/node_modules`. Both jobs use Node 22.18 because the tests rely on native TypeScript type-stripping (Node >= 22.18), so run them with a matching local Node version.

## Layout

```
extensions/minidev/
  index.ts      commands, transcript renderer
  pipeline.ts   stage machine (workspace → … → pr), gates, fix loops, budget
  harness.ts    pi-durable Harness: in-process agent runs, replay, recovery
  harness-models.ts  pi-ai model bridge from the host ModelRegistry
  harness-util.ts    pure harness helpers (ids, usage, entries, tool selection, context)
  ledger.ts     pi-durable `minidev.calls` document + call decisions
  agent-tools.ts     grep/find/ls tools over the harness bash
  agent-guard.ts     beforeTool hook blocking git mutations and outside-writes
  stack.ts      mode detection (android / ios / typescript / generic), setup, checks
  checks.ts     build/test/lint commands, error extraction
  git.ts        worktree, commit, push
  prompts.ts    task prompts per stage + PR body
  ticket.ts     ticket sources (manual, file; Jira slot)
  ui-model.ts   pure widget/detail renderers + formatting (unit-tested)
  text-width.ts  terminal cell width + ANSI-aware clipping (unit-tested)
  version.ts    package version + short git commit shown in the TUI
  config.ts state.ts ui.ts agents.ts util.ts
agents/         role contracts (scout, planner, builder, tester, reviewer)
agents/stacks/  per-mode guidance (android, ios, typescript, generic)
```

## Roadmap

- Jira source (Atlassian MCP or REST) → `SOURCES` in `ticket.ts`
- Parallel builders for independent subtasks (separate worktrees)
- Emulator/instrumented tests stage
