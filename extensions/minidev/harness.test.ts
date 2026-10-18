import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRegistryLike } from "./harness-models.ts";
import { sessionDir } from "./harness-util.ts";
import { AgentHarness, agentHarness, closeHarness, closeHarnesses, readLedger } from "./harness.ts";

/**
 * Registry with no models: opening a harness never calls a model, and these tests only open, read the ledger and close.
 */
const emptyRegistry = {
	find: () => undefined,
	getAll: () => [],
	getAvailable: () => [],
	getModelsOfType: () => [],
	getModelOfType: () => undefined,
	getAvailableOfType: async () => [],
	getProvider: () => undefined,
	getProviderAuth: async () => undefined,
	refresh: async () => ({}),
	stream: () => {
		throw new Error("unexpected stream");
	},
	complete: async () => {
		throw new Error("unexpected complete");
	},
	streamSimple: () => {
		throw new Error("unexpected streamSimple");
	},
} as unknown as ModelRegistryLike;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "minidev-harness-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function runDir(name: string): string {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

describe("readLedger", () => {
	test("resolves to an empty ledger for a fresh run directory", async () => {
		assert.deepEqual(await readLedger(path.join(root, "never-opened")), []);
	});
});

describe("harness cache", () => {
	test("closeHarnesses resolves on an empty cache", async () => {
		await closeHarnesses();
	});

	test("closeHarness resolves for an unknown run directory", async () => {
		await closeHarness(path.join(root, "unknown"));
	});

	test("agentHarness caches one harness per resolved run directory", async () => {
		const dir = runDir("cached");
		const first = await agentHarness({ runDir: dir, registry: emptyRegistry });
		const second = await agentHarness({ runDir: path.join(dir, "."), registry: emptyRegistry });
		assert.equal(first, second);
		await closeHarness(dir);
	});
});

describe("AgentHarness", () => {
	test("open + readCalls + close round-trips an empty ledger", async () => {
		const dir = runDir("round-trip");
		const harness = await AgentHarness.open({ runDir: dir, registry: emptyRegistry });
		assert.deepEqual(await harness.readCalls(), []);
		await harness.close();
		assert.deepEqual(await readLedger(dir), []);
	});

	test("reads the ledger from the run's session directory", async () => {
		const dir = runDir("session-dir");
		const harness = await AgentHarness.open({ runDir: dir, registry: emptyRegistry });
		assert.ok(fs.existsSync(sessionDir(dir)), "expected the JSONL session directory to exist");
		await harness.close();
	});

	test("a missing model fails fast without touching the ledger", async () => {
		const dir = runDir("missing-model");
		const harness = await AgentHarness.open({ runDir: dir, registry: emptyRegistry });
		const r = await harness.run({
			agent: { name: "builder", description: "", tools: [], systemPrompt: "sys", sources: [] },
			model: { model: "nope/missing" },
			task: "t",
			cwd: dir,
			workDir: dir,
			label: "01-test",
			requestId: "r",
			inputHash: "h",
			replay: false,
			maxUsd: 1,
		});
		assert.equal(r.ok, false);
		assert.equal(r.output, "");
		assert.equal(r.costUsd, 0);
		assert.equal(r.turns, 0);
		assert.equal(r.model, "nope/missing");
		assert.match(r.error ?? "", /model not available/);
		assert.equal(r.budgetExceeded, false);
		assert.equal(r.aborted, false);
		assert.equal(r.transcript, path.join(dir, "01-test.jsonl"));
		assert.equal(fs.readFileSync(r.transcript, "utf-8"), "");
		assert.deepEqual(await harness.readCalls(), []);
		await harness.close();
	});
});
