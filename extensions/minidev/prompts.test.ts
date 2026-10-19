import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "./config.ts";
import { builderSubtaskTask, fixTask, reviewerTask, testerTask } from "./prompts.ts";
import type { RunState, Subtask } from "./state.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "minidev-prompts-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function makeState(over: Partial<RunState> = {}): RunState {
	return {
		version: 1,
		key: "MD-1",
		title: "Better UI",
		ticket: { key: "MD-1", title: "Better UI", body: "", source: "s" },
		repoRoot: "/repo",
		repoName: "repo",
		runDir: path.join(root, "MD-1"),
		worktree: "/wt/repo/MD-1",
		branch: "feat/md-1",
		base: "main",
		baseRef: "origin/main",
		stage: "build",
		completed: [],
		status: "running",
		budgetUsd: 10,
		costUsd: 0,
		plan: { summary: "Do the thing", subtasks: [] },
		subtasks: [],
		agentRuns: [],
		checks: [],
		reviewRounds: 0,
		fixRounds: 0,
		createdAt: 1,
		updatedAt: 1,
		...over,
	};
}

const subtask: Subtask = { id: "S1", title: "Do it", goal: "Do it", status: "pending", attempts: 0 };

describe("working directory wording", () => {
	test("builderSubtaskTask names the in-place checkout and not a worktree", () => {
		const prompt = builderSubtaskTask(makeState({ inPlace: true }), DEFAULT_CONFIG, subtask);
		assert.match(prompt, /\(in-place run: the main checkout on branch /);
		assert.doesNotMatch(prompt, /\(git worktree\)/);
	});

	test("builderSubtaskTask keeps the worktree wording for normal runs", () => {
		const prompt = builderSubtaskTask(makeState(), DEFAULT_CONFIG, subtask);
		assert.match(prompt, /\(git worktree\)/);
		assert.doesNotMatch(prompt, /\(in-place run: the main checkout on branch /);
	});

	test("builderSubtaskTask says 'the checkout' for partial in-place work", () => {
		const prompt = builderSubtaskTask(makeState({ inPlace: true }), DEFAULT_CONFIG, subtask, undefined, true);
		assert.match(prompt, /the checkout may contain partial uncommitted work/);
	});

	test("builderSubtaskTask says 'the worktree' for partial worktree work", () => {
		const prompt = builderSubtaskTask(makeState(), DEFAULT_CONFIG, subtask, undefined, true);
		assert.match(prompt, /the worktree may contain partial uncommitted work/);
	});

	test("fixTask, testerTask and reviewerTask follow the same wording", () => {
		for (const build of [
			(s: RunState) => fixTask(s, DEFAULT_CONFIG, "problem", "checks"),
			(s: RunState) => testerTask(s, DEFAULT_CONFIG, true),
			(s: RunState) => reviewerTask(s),
		]) {
			assert.match(build(makeState({ inPlace: true })), /\(in-place run: the main checkout on branch /);
			assert.doesNotMatch(build(makeState({ inPlace: true })), /\(git worktree\)/);
			assert.match(build(makeState()), /\(git worktree\)/);
		}
	});
});
