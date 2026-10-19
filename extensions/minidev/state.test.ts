import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runDirFor, saveState, loadState, listRuns, type RunState } from "./state.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "minidev-state-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function makeState(runDir: string, over: Partial<RunState> = {}): RunState {
	return {
		version: 1,
		key: "K",
		title: "T",
		ticket: { key: "K", title: "T", body: "", source: "s" },
		repoRoot: "/repo",
		repoName: "repo",
		runDir,
		stage: "workspace",
		completed: [],
		status: "running",
		budgetUsd: 10,
		costUsd: 0,
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

describe("runDirFor", () => {
	test("joins runsDir, repoName and key", () => {
		assert.equal(runDirFor("/runs", "repo", "MD-1"), path.join("/runs", "repo", "MD-1"));
	});
});

describe("saveState / loadState", () => {
	test("round-trips state and bumps updatedAt", () => {
		const runDir = path.join(root, "roundtrip");
		const state = makeState(runDir, { key: "MD-9", updatedAt: 1 });
		saveState(state);
		const loaded = loadState(runDir);
		assert.ok(loaded);
		assert.equal(loaded.key, "MD-9");
		assert.ok(loaded.updatedAt > 1);
	});

	test("returns undefined for a missing run dir", () => {
		assert.equal(loadState(path.join(root, "does-not-exist")), undefined);
	});

	test("round-trips the inPlace flag", () => {
		const runDir = path.join(root, "in-place");
		saveState(makeState(runDir, { key: "MD-10", inPlace: true }));
		const loaded = loadState(runDir);
		assert.ok(loaded);
		assert.equal(loaded.inPlace, true);
	});

	test("loads a state file without inPlace as undefined", () => {
		const runDir = path.join(root, "legacy");
		const state = makeState(runDir, { key: "MD-11" });
		delete state.inPlace;
		saveState(state);
		const loaded = loadState(runDir);
		assert.ok(loaded);
		assert.equal(loaded.inPlace, undefined);
	});
});

describe("listRuns", () => {
	test("sorts by updatedAt desc and skips dirs without state.json", () => {
		const runsDir = path.join(root, "runs");
		const repoName = "repo";
		const write = (key: string, updatedAt: number) => {
			const dir = path.join(runsDir, repoName, key);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(makeState(dir, { key, updatedAt })), "utf-8");
		};
		write("a", 100);
		write("b", 300);
		write("c", 200);
		fs.mkdirSync(path.join(runsDir, repoName, "nodata"), { recursive: true });

		assert.deepEqual(
			listRuns(runsDir, repoName).map((s) => s.key),
			["b", "c", "a"],
		);
	});

	test("returns an empty list when the repo has no runs", () => {
		assert.deepEqual(listRuns(path.join(root, "empty"), "repo"), []);
	});
});
