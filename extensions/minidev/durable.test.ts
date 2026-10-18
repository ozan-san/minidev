import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendJournal,
	inFlightOwners,
	inputHash,
	journalFile,
	readJournal,
	reapOrphanedAgents,
	replayResult,
	requestIdFor,
	summarizeJournal,
	type JournalEntry,
	type JournalType,
} from "./durable.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "minidev-durable-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let seq = 0;
function entry(over: Partial<JournalEntry> & { type: JournalType }): JournalEntry {
	seq += 1;
	return { seq, ts: 1000 + seq, ...over };
}

describe("journalFile", () => {
	test("joins the run dir with journal.jsonl", () => {
		assert.equal(journalFile("/runs/repo/K"), path.join("/runs/repo/K", "journal.jsonl"));
	});
});

describe("requestIdFor", () => {
	test("is deterministic and keyed by key, role and item", () => {
		assert.equal(requestIdFor("MD-1", "builder", "build-S1"), "MD-1:builder:build-S1");
		assert.equal(requestIdFor("MD-1", "builder", "build-S1"), requestIdFor("MD-1", "builder", "build-S1"));
		assert.notEqual(requestIdFor("MD-1", "builder", "build-S1"), requestIdFor("MD-2", "builder", "build-S1"));
	});
});

describe("inputHash", () => {
	test("is stable for identical inputs and 16 hex chars", () => {
		const h = inputHash("sys", "task", "model", "high");
		assert.equal(h, inputHash("sys", "task", "model", "high"));
		assert.match(h, /^[0-9a-f]{16}$/);
	});

	test("changes when task, system prompt, model or thinking change", () => {
		const base = inputHash("sys", "task", "model", "high");
		assert.notEqual(base, inputHash("sys", "task-2", "model", "high"));
		assert.notEqual(base, inputHash("sys-2", "task", "model", "high"));
		assert.notEqual(base, inputHash("sys", "task", "model-2", "high"));
		assert.notEqual(base, inputHash("sys", "task", "model", "low"));
	});
});

describe("readJournal", () => {
	test("returns [] for a missing file", () => {
		assert.deepEqual(readJournal(path.join(root, "missing", "journal.jsonl")), []);
	});

	test("returns [] for an unreadable path instead of throwing", () => {
		assert.deepEqual(readJournal(root), []);
	});

	test("parses valid JSONL lines and skips malformed lines", () => {
		const file = path.join(root, "mixed", "journal.jsonl");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			[
				JSON.stringify({ seq: 1, ts: 1, type: "run_started" }),
				"not json at all",
				"",
				JSON.stringify({ seq: 2, ts: 2, type: "checkpoint", item: "stage:scout" }),
			].join("\n") + "\n",
			"utf-8",
		);
		const entries = readJournal(file);
		assert.equal(entries.length, 2);
		assert.equal(entries[0].type, "run_started");
		assert.equal(entries[1].item, "stage:scout");
	});
});

describe("appendJournal / readJournal", () => {
	test("assigns increasing seq, keeps the injected now as ts and creates nested dirs", () => {
		const file = path.join(root, "nested", "a", "b", "journal.jsonl");
		const first = appendJournal(file, { type: "run_started", session: "s1" }, 111);
		const second = appendJournal(file, { type: "run_finished", session: "s1", ok: true }, 222);
		assert.equal(first.seq, 1);
		assert.equal(first.ts, 111);
		assert.equal(second.seq, 2);
		assert.equal(second.ts, 222);
		const entries = readJournal(file);
		assert.deepEqual(entries.map((e) => e.seq), [1, 2]);
		assert.deepEqual(entries.map((e) => e.ts), [111, 222]);
	});
});

describe("replayResult", () => {
	const requestId = "MD-1:builder:build-S1";
	const hash = "abc123";
	const query = { requestId, inputHash: hash, session: "current" };

	test("returns the last matching successful entry", () => {
		const entries = [
			entry({ type: "agent_finished", requestId, inputHash: hash, session: "old", ok: true, output: "first" }),
			entry({ type: "agent_finished", requestId, inputHash: hash, session: "older", ok: true, output: "second" }),
		];
		assert.equal(replayResult(entries, query)?.output, "second");
	});

	test("returns undefined when ok is false, hash differs, requestId differs or session matches", () => {
		assert.equal(
			replayResult([entry({ type: "agent_finished", requestId, inputHash: hash, session: "old", ok: false })], query),
			undefined,
		);
		assert.equal(
			replayResult([entry({ type: "agent_finished", requestId, inputHash: "other", session: "old", ok: true })], query),
			undefined,
		);
		assert.equal(
			replayResult([entry({ type: "agent_finished", requestId: "other", inputHash: hash, session: "old", ok: true })], query),
			undefined,
		);
		assert.equal(
			replayResult([entry({ type: "agent_finished", requestId, inputHash: hash, session: "current", ok: true })], query),
			undefined,
		);
	});

	test("returns an earlier entry when the newest same-request entry failed", () => {
		const entries = [
			entry({ type: "agent_finished", requestId, inputHash: hash, session: "old", ok: true, output: "good" }),
			entry({ type: "agent_finished", requestId, inputHash: hash, session: "old", ok: false }),
		];
		assert.equal(replayResult(entries, query)?.output, "good");
	});
});

describe("inFlightOwners", () => {
	test("reports a started request with no finish, with its pid and item", () => {
		const entries = [
			entry({ type: "agent_started", requestId: "r1", item: "builder:S1", pid: 4242 }),
		];
		assert.deepEqual(inFlightOwners(entries), [{ requestId: "r1", pid: 4242, item: "builder:S1" }]);
	});

	test("drops a request once agent_finished arrives", () => {
		const entries = [
			entry({ type: "agent_started", requestId: "r1", item: "builder:S1", pid: 4242 }),
			entry({ type: "agent_finished", requestId: "r1", item: "builder:S1", ok: true }),
		];
		assert.deepEqual(inFlightOwners(entries), []);
	});

	test("ignores started entries without a positive pid", () => {
		const entries = [
			entry({ type: "agent_started", requestId: "r1", pid: 0 }),
			entry({ type: "agent_started", requestId: "r2" }),
			entry({ type: "agent_started", requestId: "r3", pid: -5 }),
		];
		assert.deepEqual(inFlightOwners(entries), []);
	});
});

describe("summarizeJournal", () => {
	test("counts entries, reports lastSeq and only successful finishes as completed", () => {
		const entries = [
			entry({ type: "run_started", ts: 10 }),
			entry({ type: "checkpoint", item: "stage:scout" }),
			entry({ type: "checkpoint", item: "stage:scout" }),
			entry({ type: "checkpoint", item: "stage:plan" }),
			entry({ type: "agent_started", requestId: "r1", item: "builder:S1", pid: 7 }),
			entry({ type: "agent_finished", requestId: "r1", item: "builder:S1", ok: true }),
			entry({ type: "agent_finished", requestId: "r2", item: "builder:S2", ok: false }),
			entry({ type: "run_finished", ts: 99 }),
		];
		const summary = summarizeJournal(entries);
		assert.equal(summary.entries, 8);
		assert.equal(summary.lastSeq, entries.at(-1)!.seq);
		assert.deepEqual(summary.checkpoints, ["stage:scout", "stage:plan"]);
		assert.deepEqual(summary.inFlight, []);
		assert.equal(summary.completed, 1);
		assert.equal(summary.lastAt, 99);
	});

	test("lists in-flight items and handles an empty journal", () => {
		const summary = summarizeJournal([
			entry({ type: "agent_started", requestId: "r1", item: "builder:S1", pid: 9 }),
			entry({ type: "agent_started", requestId: "r2", pid: 10 }),
		]);
		assert.deepEqual(summary.inFlight, ["builder:S1", "r2"]);
		assert.deepEqual(summarizeJournal([]), {
			entries: 0,
			lastSeq: 0,
			checkpoints: [],
			inFlight: [],
			completed: 0,
			lastAt: undefined,
		});
	});
});

describe("reapOrphanedAgents", () => {
	test("kills only live in-flight pids and returns exactly those pids", () => {
		const runDir = path.join(root, "reap");
		const file = journalFile(runDir);
		appendJournal(file, { type: "agent_started", requestId: "r1", item: "a", pid: 100 });
		appendJournal(file, { type: "agent_started", requestId: "r2", item: "b", pid: 200 });
		appendJournal(file, { type: "agent_started", requestId: "r3", item: "c", pid: 300 });
		appendJournal(file, { type: "agent_finished", requestId: "r3", ok: true });
		const alive = new Set([100, 200, 300]);
		const killed: number[] = [];
		const result = reapOrphanedAgents(runDir, {
			isAlive: (pid) => alive.has(pid),
			kill: (pid) => killed.push(pid),
			isOurs: () => true,
		});
		assert.deepEqual(result, [100, 200]);
		assert.deepEqual(killed, [100, 200]);
	});

	test("does not kill a live pid that belongs to an unrelated process", () => {
		const runDir = path.join(root, "reap-unrelated");
		appendJournal(journalFile(runDir), { type: "agent_started", requestId: "r1", pid: 111 });
		appendJournal(journalFile(runDir), { type: "agent_started", requestId: "r2", pid: 222 });
		const killed: number[] = [];
		const result = reapOrphanedAgents(runDir, {
			isAlive: () => true,
			kill: (pid) => killed.push(pid),
			isOurs: (pid) => pid === 222,
		});
		assert.deepEqual(result, [222]);
		assert.deepEqual(killed, [222]);
	});

	test("does not kill dead pids", () => {
		const runDir = path.join(root, "reap-dead");
		appendJournal(journalFile(runDir), { type: "agent_started", requestId: "r1", pid: 555 });
		const killed: number[] = [];
		const result = reapOrphanedAgents(runDir, {
			isAlive: () => false,
			kill: (pid) => killed.push(pid),
		});
		assert.deepEqual(result, []);
		assert.deepEqual(killed, []);
	});

	test("kills nothing when the journal is empty or every started entry has a finish", () => {
		const emptyDir = path.join(root, "reap-empty");
		fs.mkdirSync(emptyDir, { recursive: true });
		const killed: number[] = [];
		assert.deepEqual(reapOrphanedAgents(emptyDir, { isAlive: () => true, kill: (pid) => killed.push(pid) }), []);

		const doneDir = path.join(root, "reap-done");
		appendJournal(journalFile(doneDir), { type: "agent_started", requestId: "r1", pid: 777 });
		appendJournal(journalFile(doneDir), { type: "agent_finished", requestId: "r1", ok: true });
		assert.deepEqual(reapOrphanedAgents(doneDir, { isAlive: () => true, kill: (pid) => killed.push(pid) }), []);
		assert.deepEqual(killed, []);
	});
});
