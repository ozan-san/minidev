---
stack: typescript
---

# TypeScript / JavaScript

## All roles

This is a TypeScript/JavaScript project (Node, web front-end, or both; possibly a monorepo).

- Use the package manager given in "Detected about this repo" (from the lockfile). Never switch managers, never create another lockfile, never run `npm install <pkg>` unless the task adds a dependency.
- Run scripts through it (`pnpm run typecheck`, `npm run -s test`, `yarn lint`). Tests must run non-interactively: `CI=1`, `vitest run`, `jest --watch=false`.
- Respect `tsconfig` strictness and path aliases (`@/…`), and the module system (ESM vs CommonJS; relative import extensions if the project uses `"moduleResolution": "NodeNext"`).
- Follow the project's ESLint/Prettier config; don't reformat untouched code.
- In monorepos, change the right package and run commands for that package (`pnpm --filter <pkg> …`, `turbo run … --filter`, `npm -w <pkg>`).
- Never start dev servers, watchers or browsers.

## Scout

Map: workspaces/packages, apps vs libraries, entry points (`src/index.ts`, `app/` / `pages/` routes, server handlers), shared types.
Identify framework (React/Next.js app vs pages router, Vue, Svelte, Angular, Node/Express/Fastify/NestJS, React Native/Expo), state management, data fetching (React Query, SWR, tRPC, GraphQL), validation (zod), styling, i18n.
Tests: runner (Vitest/Jest/node:test/Mocha), location (`*.test.ts`, `__tests__`), testing-library, MSW, fixtures.
Commands: `package.json` scripts (`typecheck`, `build`, `test`, `lint`), turbo/nx pipelines, CI workflow steps.

## Planner

- Each subtask must keep `typecheck` (or build) green; add types/interfaces before their consumers.
- Name exact files, exported symbols and their signatures; say which package in a monorepo.
- New dependencies: separate subtask, specify exact package and whether it's a dev dependency.
- Public API changes of shared packages: list all call sites to update in the same subtask.
- Test plan: unit tests for pure logic, hooks (testing-library), handlers/services (mocked I/O). No e2e/browser tests.

## Builder

- Types: no `any` (use `unknown` + narrowing), no `@ts-ignore`/`@ts-expect-error` to silence errors, no non-null `!` without reason. Export types the codebase exports.
- Async: always `await` or explicitly handle promises; propagate errors the way the codebase does.
- React: follow hooks rules, complete effect dependency arrays, keys on lists, keep components pure; Next.js: respect server/client boundaries (`"use client"`), don't import server-only code into client components.
- Node: validate external input at the boundary (zod or the project's validator); never log secrets.
- Verify with the typecheck command from your task (`… 2>&1 | tail -n 60`).

## Tester

- Co-locate or mirror tests exactly as the project does (`foo.test.ts` next to `foo.ts`, or `__tests__/`).
- Use the existing runner and helpers (testing-library, MSW, factories); mock network/time/randomness; no real HTTP.
- Run a single file while iterating: `pnpm vitest run path/to/foo.test.ts`, `npx jest path/to/foo.test.ts`, `node --test path`.
- Keep snapshots minimal; don't update unrelated snapshots.

## Reviewer

TypeScript/JS-specific blockers:
- Type holes (`any`, unchecked casts, ts-ignore) that hide real bugs; runtime data trusted without validation.
- Unhandled promise rejections, missing `await`, race conditions in effects, stale closures.
- Security: XSS (`dangerouslySetInnerHTML`, unsanitized HTML), injection (SQL/shell/path), secrets in client bundles (`NEXT_PUBLIC_*`), missing authz checks on new endpoints.
- React hook rule violations or effect dependency bugs; server/client boundary mistakes in Next.js.
- Breaking exports of shared packages, accidental lockfile churn, new heavy dependencies.
