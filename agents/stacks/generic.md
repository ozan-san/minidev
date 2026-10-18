---
stack: generic
---

# Generic (unknown stack)

## All roles

minidev could not match this repo to a known stack (Android, iOS/Swift, TypeScript). Treat the repository itself
as the documentation:

- Sources of truth, in order: `AGENTS.md`/`CLAUDE.md`, `CONTRIBUTING*`, `README*`, CI config (`.github/workflows`, `.gitlab-ci.yml`, `Jenkinsfile`, …), `Makefile`/`justfile`/`Taskfile.yml`, language manifests (`Cargo.toml`, `go.mod`, `pyproject.toml`, `Gemfile`, `pom.xml`, `*.csproj`, `mix.exs`, …).
- Use the toolchain and versions the repo pins (`.tool-versions`, `.nvmrc`, `rust-toolchain.toml`, `.python-version`); use existing virtualenv/wrapper scripts instead of global tools.
- Match the existing language idioms, formatter and linter settings exactly; don't introduce new tools, frameworks or dependencies.
- Never run deploy, release, publish, migration-against-real-DB or other side-effecting scripts.

## Scout

Be extra thorough on *how to build and test*: the orchestrator may have no detected commands and will use the
`commands` JSON you return. Read the CI workflow steps and copy their build/test/lint commands (minus caching,
matrix and deploy steps). Prefer commands that run locally without credentials or services. If tests need a
database or service, say so under Risks and give the command that runs the subset that doesn't.
Report language(s), frameworks, project layout and the test framework with an example test.

## Planner

- If no build/test commands are known (check your task), keep subtasks extra small and low-risk, and state in each subtask's acceptance how the builder can verify it locally.
- Name exact files and symbols; mention the idiom/file to imitate, since the builder has no stack-specific guidance.
- Prefer changes within existing files and modules over new structure.

## Builder

- Read neighbouring code first and mirror it (error handling, logging, naming, file layout).
- Verify with the command in your task; if none is given, use the most targeted compile/test command the README or CI uses, and report what you ran under Notes.

## Tester

- Find the test framework from existing tests and CI; mirror the closest existing test file.
- Run only the new/affected tests; if tests need unavailable services, write tests for the pure logic only and say so.

## Reviewer

- Check that the change follows the repo's own conventions (compare with neighbouring code), not generic preferences.
- Flag any new tool, dependency or pattern the repo doesn't already use.
