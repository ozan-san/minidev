import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	attemptRequestId,
	callKey,
	decideCall,
	findCall,
	summarizeLedger,
	upsertCall,
	type CallRecord,
} from "./ledger.ts";

function rec(overrides: Partial<CallRecord> = {}): CallRecord {
	return {
		requestId: "req:builder:item",
		inputHash: "abcd",
		attempt: 1,
		status: "settled",
		ok: true,
		submissionId: null,
		output: null,
		costUsd: 0,
		turns: 0,
		model: null,
		stopReason: null,
		error: null,
		transcript: null,
		usageBase: 0,
		at: 1,
		...overrides,
	};
}

describe("callKey", () => {
	test("joins requestId and inputHash", () => {
		assert.equal(callKey("a", "b"), "a:b");
	});
});

describe("attemptRequestId", () => {
	test("keeps the base id for the first (and zeroth) attempt", () => {
		assert.equal(attemptRequestId("base", 1), "base");
		assert.equal(attemptRequestId("base", 0), "base");
	});

	test("suffixes later attempts", () => {
		assert.equal(attemptRequestId("base", 2), "base#2");
		assert.equal(attemptRequestId("base", 7), "base#7");
	});
});

describe("findCall / upsertCall", () => {
	test("findCall returns the matching record or undefined", () => {
		const calls = [rec({ requestId: "a" }), rec({ requestId: "b" })];
		assert.equal(findCall(calls, "b")?.requestId, "b");
		assert.equal(findCall(calls, "c"), undefined);
	});

	test("upsertCall replaces by requestId without mutating the input", () => {
		const original = [rec({ requestId: "a", attempt: 1 }), rec({ requestId: "b", attempt: 1 })];
		const updated = upsertCall(original, rec({ requestId: "a", attempt: 2 }));
		assert.equal(updated.length, 2);
		assert.equal(findCall(updated, "a")?.attempt, 2);
		assert.equal(findCall(original, "a")?.attempt, 1);
		assert.notEqual(updated, original);
	});

	test("upsertCall appends a new record without mutating the input", () => {
		const original = [rec({ requestId: "a" })];
		const updated = upsertCall(original, rec({ requestId: "b" }));
		assert.deepEqual(updated.map((c) => c.requestId), ["a", "b"]);
		assert.equal(original.length, 1);
	});
});

describe("decideCall", () => {
	test("no record starts the first attempt", () => {
		assert.deepEqual(decideCall(undefined, "none", true), { kind: "fresh", attempt: 1 });
	});

	test("settled+ok replays when replay is enabled", () => {
		const record = rec();
		assert.deepEqual(decideCall(record, "none", true), { kind: "replay", record });
	});

	test("settled+ok without replay starts a new attempt", () => {
		assert.deepEqual(decideCall(rec({ attempt: 2 }), "none", false), { kind: "fresh", attempt: 3 });
	});

	test("running record attaches while the submission is live", () => {
		assert.deepEqual(decideCall(rec({ status: "running", ok: false }), "running", true), { kind: "attach" });
		assert.deepEqual(decideCall(rec({ status: "running", ok: false }), "done", true), { kind: "attach" });
	});

	test("running record with no live submission retries", () => {
		const record = rec({ status: "running", ok: false, attempt: 1 });
		assert.deepEqual(decideCall(record, "none", true), { kind: "fresh", attempt: 2 });
		assert.deepEqual(decideCall(record, "failed", true), { kind: "fresh", attempt: 2 });
	});

	test("settled failure starts a new attempt", () => {
		assert.deepEqual(decideCall(rec({ ok: false, attempt: 2 }), "failed", true), { kind: "fresh", attempt: 3 });
	});
});

describe("summarizeLedger", () => {
	test("empty ledger reports zero calls and no lastAt", () => {
		assert.deepEqual(summarizeLedger([]), { calls: 0, done: 0, failed: 0, running: 0 });
	});

	test("counts done, failed and running and reports the newest at", () => {
		const calls = [
			rec({ requestId: "a", status: "settled", ok: true, at: 10 }),
			rec({ requestId: "b", status: "settled", ok: false, at: 30 }),
			rec({ requestId: "c", status: "running", ok: false, at: 20 }),
		];
		assert.deepEqual(summarizeLedger(calls), { calls: 3, done: 1, failed: 1, running: 1, lastAt: 30 });
	});
});
