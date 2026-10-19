import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "./config.ts";
import { Pause, effectiveModel, removeWorktree } from "./pipeline.ts";
import type { RunState } from "./state.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "minidev-pipeline-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

/** A run state with only the fields effectiveModel reads. */
function makeState(over: Partial<RunState> = {}): RunState {
	return { modelOverrides: undefined, ...over } as unknown as RunState;
}

describe("effectiveModel", () => {
	test("returns the configured default when there are no overrides", () => {
		assert.deepEqual(effectiveModel(undefined, DEFAULT_CONFIG, "builder"), DEFAULT_CONFIG.models.builder);
		assert.deepEqual(effectiveModel(makeState(), DEFAULT_CONFIG, "scout"), DEFAULT_CONFIG.models.scout);
	});

	test("a per-run override wins over the configured default", () => {
		const state = makeState({ modelOverrides: { builder: { model: "run/only", thinking: "low" } } });
		assert.deepEqual(effectiveModel(state, DEFAULT_CONFIG, "builder"), { model: "run/only", thinking: "low" });
	});

	test("a partial override keeps the default fields it does not set", () => {
		const state = makeState({ modelOverrides: { builder: { model: "run/only" } } });
		const model = effectiveModel(state, DEFAULT_CONFIG, "builder");
		assert.equal(model.model, "run/only");
		assert.equal(model.thinking, DEFAULT_CONFIG.models.builder.thinking);
		assert.equal(model.maxUsdPerCall, DEFAULT_CONFIG.models.builder.maxUsdPerCall);
	});

	test("does not mutate the config defaults", () => {
		const before = structuredClone(DEFAULT_CONFIG.models.builder);
		effectiveModel(makeState({ modelOverrides: { builder: { model: "run/only" } } }), DEFAULT_CONFIG, "builder");
		assert.deepEqual(DEFAULT_CONFIG.models.builder, before);
	});
});

describe("removeWorktree", () => {
	test("is a no-op for in-place runs and leaves the checkout intact", async () => {
		const checkout = path.join(root, "checkout");
		fs.mkdirSync(checkout, { recursive: true });
		const file = path.join(checkout, "keep.txt");
		fs.writeFileSync(file, "keep me", "utf-8");

		await removeWorktree(makeState({ inPlace: true, worktree: checkout, repoRoot: checkout }));

		assert.equal(fs.existsSync(checkout), true);
		assert.equal(fs.readFileSync(file, "utf-8"), "keep me");
	});

	test("resolves for a worktree that no longer exists without running git", async () => {
		const missing = path.join(root, "missing-worktree");
		await removeWorktree(makeState({ worktree: missing, repoRoot: root }));
		assert.equal(fs.existsSync(missing), false);
	});
});

describe("Pause", () => {
	test("is an Error carrying its reason", () => {
		const err = new Pause("budget");
		assert.ok(err instanceof Error);
		assert.ok(err instanceof Pause);
		assert.equal(err.reason, "budget");
		assert.equal(err.message, "budget");
	});

	test("preserves different reasons", () => {
		assert.equal(new Pause("stopped").reason, "stopped");
		assert.equal(new Pause("awaiting plan approval").reason, "awaiting plan approval");
	});
});
