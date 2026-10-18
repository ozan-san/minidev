# minidev

Ticket → PR pipeline for [pi](https://pi.dev). Open pi in an Android repo, hand it a ticket, watch subagents
scout, plan, build (one small subtask at a time), test, review and open the PR, all inside a per-ticket git worktree.

```
/minidev run                 # editor opens: paste ticket (Key/Title/Description/Acceptance)
/minidev run ABC-123         # same, key prefilled (Jira source not wired yet)
/minidev run ./ticket.md     # from a file
/ticket …                    # alias for /minidev run
```

## Pipeline

```
workspace → scout → plan → [approve plan] → build S1..Sn → test ⇄ fix → review → fix → [approve PR] → push + PR
```

| Stage | Who | Default model | Notes |
|---|---|---|---|
| workspace | orchestrator | – | `git fetch`, worktree at `~/.minidev/worktrees/<repo>/<KEY>` on `{type}/{key}-{slug}`, copies `local.properties` |
| scout | `scout` agent (read-only) | DeepSeek v4.1 Flash | → `context.md` |
| plan | `planner` agent (read-only) | **Claude Opus 5.5** | → `plan.md` + `plan.json` (small ordered subtasks + test plan) |
| build | `builder` agent, **one fresh process per subtask** | DeepSeek v4.1 Flash | after each: subtask checks (`assembleDebug`); failures fed back (3 tries); commit per subtask |
| test | `tester` agent + final checks | DeepSeek v4.1 Flash | writes JVM unit tests if repo has them; `assembleDebug`, `testDebugUnitTest`, `lintDebug` (non-blocking); fix loop (3 rounds) |
| review | `reviewer` agent | Claude Opus 5.5 | JSON verdict; must-fix items → one builder fix round + re-check |
| pr | orchestrator | – | `git push`, then `gh`/`glab` if detected (configurable), draft by default |

Pass/fail is decided by **exit codes of your build/test commands**, never by an agent saying "done".

Subagents run as isolated `pi` processes (`--no-extensions` + `guard/guard.ts`): they cannot commit, push,
switch branches or write outside the worktree. The orchestrator owns git.

## Commands

| | |
|---|---|
| `/minidev run [KEY\|file\|title]` | start a run |
| `/minidev resume [KEY]` | continue a paused/failed run (from the stage/subtask where it stopped) |
| `/minidev approve [KEY]` | approve a pending plan/PR gate and continue (useful headless) |
| `/minidev stop` | stop the active run (kills subagents; resumable) |
| `/minidev status` | runs for this repo |
| `/minidev models` | pick model + thinking per role (default or "this run only"); applies from the next call |
| `/minidev models builder openrouter/deepseek/deepseek-v4.1-flash:high` | non-interactive |
| `/minidev budget <usd> [KEY\|default]` | raise a run's cap / set default cap |
| `/minidev clean [KEY]` | remove a run's worktree (branch + artifacts kept) |
| `/minidev config` | show effective config |

Headless: `pi -p "/minidev run ticket.md"` runs to the first gate and exits; `pi -p "/minidev approve KEY"` continues.
Set `gates.plan/pr = false` for fully unattended runs.

## Budget

`budget.maxUsdPerRun` (default $10) is a hard cap over all agents of a run. Cost is tracked from OpenRouter usage on
every model turn; when the cap is hit the running subagent is killed and the run pauses (`/minidev budget 20` then
`/minidev resume`). Overshoot is at most one model turn. Optional per-role cap: `models.<role>.maxUsdPerCall`.
Warning at `budget.warnAt` (80%).

## Config

`defaults ← ~/.minidev/config.json ← <repo>/.minidev.json` (deep merge). See [`minidev.example.json`](minidev.example.json).
Model refs are anything `pi --model` accepts (`pi --list-models <search>`).

Agents' system prompts live in [`agents/`](agents/); override per user in `~/.minidev/agents/<role>.md` or per
repo in `<repo>/.minidev/agents/<role>.md`.

## Artifacts

`~/.minidev/runs/<repo>/<KEY>/`: `ticket.md`, `context.md`, `plan.md`, `plan.json`, `test-report.md`, `review.md`,
`pr-body.md`, `state.json`, `logs/*.log` (check output), `agents/*.jsonl` (full subagent transcripts + prompts).

## Install

```bash
pi install ~/minidev      # always loaded
# or per session:
pi -e ~/minidev
```

Requires OpenRouter credentials in pi (`/login openrouter` or `OPENROUTER_API_KEY`).

## Layout

```
extensions/minidev/
  index.ts      commands, transcript renderer
  pipeline.ts   stage machine (workspace → … → pr), gates, fix loops, budget
  runner.ts     spawns `pi --mode json` subagents, streams events, enforces cost caps
  checks.ts     build/test/lint commands, error extraction
  git.ts        worktree, commit, push
  prompts.ts    task prompts per stage + PR body
  ticket.ts     ticket sources (manual, file; Jira slot)
  config.ts state.ts ui.ts agents.ts util.ts
agents/         scout, planner, builder, tester, reviewer system prompts
guard/guard.ts  safety extension loaded into every subagent
```

## Roadmap

- Jira source (Atlassian MCP or REST) → `SOURCES` in `ticket.ts`
- Parallel builders for independent subtasks (separate worktrees)
- Emulator/instrumented tests stage
