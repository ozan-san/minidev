/**
 * Durable run journal.
 *
 * The journal is stored with `@earendil-works/pi-durable`: one JSONL-backed Session per run, and every entry is an
 * append-only commit. That gives minidev crash-safe writes (a half-written entry is never observed), monotonic entry
 * identity from pi-durable's storage, and replay on `/minidev resume` without hand-rolling a JSONL file.
 *
 * The public functions keep the shape the pipeline needs: an append, a read, a replay lookup, a summary, and orphan
 * reaping. Pure helpers (`requestIdFor`, `inputHash`, `replayResult`, ...) stay synchronous and dependency-free so they
 * remain easy to test.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, defineEntry, type ConversationId, type Session } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { ensureDir } from "./util.ts";

export type JournalType =
	| "run_started"
	| "run_resumed"
	| "run_finished"
	| "checkpoint"
	| "agent_started"
	| "agent_finished";

export interface JournalEntry {
	seq: number;
	ts: number;
	type: JournalType;
	session?: string;
	item?: string;
	requestId?: string;
	inputHash?: string;
	role?: string;
	model?: string;
	pid?: number;
	ok?: boolean;
	costUsd?: number;
	turns?: number;
	stopReason?: string;
	error?: string;
	output?: string;
	transcript?: string;
	note?: string;
}

/** Entry payload stored in pi-durable; `seq` comes from append order. */
type JournalData = {
	ts: number;
	type: JournalType;
	session?: string;
	item?: string;
	requestId?: string;
	inputHash?: string;
	role?: string;
	model?: string;
	pid?: number;
	ok?: boolean;
	costUsd?: number;
	turns?: number;
	stopReason?: string;
	error?: string;
	output?: string;
	transcript?: string;
	note?: string;
};

export interface JournalSummary {
	entries: number;
	lastSeq: number;
	checkpoints: string[];
	inFlight: string[];
	completed: number;
	lastAt?: number;
}

const JournalEntryKind = defineEntry<JournalData>("minidev.journal");
const PAGE = 500;

/** Directory pi-durable stores a run's journal in. */
export function journalDir(runDir: string): string {
	return path.join(runDir, "journal");
}

/** Legacy flat journal written by minidev before the move to pi-durable. */
function legacyJournalFile(runDir: string): string {
	return path.join(runDir, "journal.jsonl");
}

export function requestIdFor(key: string, role: string, item: string): string {
	return `${key}:${role}:${item}`;
}

export function inputHash(...parts: Array<string | undefined>): string {
	return createHash("sha256")
		.update(parts.map((p) => p ?? "").join("\u0000"))
		.digest("hex")
		.slice(0, 16);
}

export function replayResult(
	entries: JournalEntry[],
	q: { requestId: string; inputHash: string; session?: string },
): JournalEntry | undefined {
	return entries
		.filter(
			(e) =>
				e.type === "agent_finished" &&
				e.ok === true &&
				e.requestId === q.requestId &&
				e.inputHash === q.inputHash &&
				e.session !== q.session,
		)
		.pop();
}

export function inFlightOwners(entries: JournalEntry[]): Array<{ requestId: string; pid: number; item?: string }> {
	const latest = new Map<string, { requestId: string; entry: JournalEntry }>();
	for (const e of entries) {
		if (!e.requestId) continue;
		latest.set(e.requestId, { requestId: e.requestId, entry: e });
	}
	const owners: Array<{ requestId: string; pid: number; item?: string }> = [];
	for (const { requestId, entry: e } of latest.values()) {
		if (e.type === "agent_started" && typeof e.pid === "number" && e.pid > 0) {
			owners.push({ requestId, pid: e.pid, item: e.item });
		}
	}
	return owners;
}

export function summarizeJournal(entries: JournalEntry[]): JournalSummary {
	return {
		entries: entries.length,
		lastSeq: entries.at(-1)?.seq ?? 0,
		checkpoints: [...new Set(entries.filter((e) => e.type === "checkpoint" && e.item).map((e) => e.item as string))],
		inFlight: inFlightOwners(entries).map((o) => o.item ?? o.requestId),
		completed: entries.filter((e) => e.type === "agent_finished" && e.ok).length,
		lastAt: entries.at(-1)?.ts,
	};
}

// ── pi-durable backed storage ───────────────────────────────────────────────

interface JournalStore {
	session: Session;
	conversationId: ConversationId;
	/** Serializes appends so the queue order is the journal order. */
	queue: Promise<unknown>;
	/** Seq the next append gets; keeps append O(1) instead of rescanning. */
	nextSeq: number;
}

const stores = new Map<string, Promise<JournalStore>>();

function toEntries(records: ReadonlyArray<{ data?: unknown }>): JournalEntry[] {
	const entries: JournalEntry[] = [];
	for (const record of records) {
		const data = record.data as JournalData | undefined;
		if (!data) continue;
		entries.push({ ...data, seq: entries.length + 1 });
	}
	return entries;
}

async function scanAll(session: Session, conversationId: ConversationId): Promise<JournalEntry[]> {
	const out: JournalEntry[] = [];
	let cursor: unknown;
	for (;;) {
		const page = await session.commit(
			(tx) => tx.scanEntries({ conversationId, order: "ascending" }, PAGE, cursor as never),
			BACKGROUND_CONTEXT,
		);
		out.push(...toEntries(page.items));
		if (!page.next) break;
		cursor = page.next;
	}
	return out.map((e, i) => ({ ...e, seq: i + 1 }));
}

function readLegacy(runDir: string): JournalEntry[] {
	const file = legacyJournalFile(runDir);
	let text: string;
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch {
		return [];
	}
	const entries: JournalEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as JournalEntry);
		} catch {
			/* skip malformed line */
		}
	}
	return entries;
}

async function openStore(runDir: string): Promise<JournalStore> {
	const dir = journalDir(runDir);
	ensureDir(dir);
	const session = createSession(await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT));

	const conversationId = await session.commit(async (tx) => {
		const page = await tx.scanConversations({}, 1);
		const existing = page.items[0];
		if (existing) return existing.id;
		const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
		return created.id;
	}, BACKGROUND_CONTEXT);

	const store: JournalStore = { session, conversationId, queue: Promise.resolve(), nextSeq: 1 };

	// One-time import of a legacy journal.jsonl, so runs started before the pi-durable move keep their replay history.
	const existing = await scanAll(session, conversationId);
	if (existing.length === 0) {
		const legacy = readLegacy(runDir);
		if (legacy.length) {
			await session.commit(async (tx) => {
				for (const entry of legacy) {
					const { seq: _seq, ...data } = entry;
					await tx.appendEntry(JournalEntryKind, conversationId, { data });
				}
			}, BACKGROUND_CONTEXT);
			try {
				fs.renameSync(legacyJournalFile(runDir), `${legacyJournalFile(runDir)}.imported`);
			} catch {
				/* best effort */
			}
		}
	}

	store.nextSeq = (await scanAll(session, conversationId)).length + 1;
	return store;
}

function storeFor(runDir: string): Promise<JournalStore> {
	const key = path.resolve(runDir);
	let store = stores.get(key);
	if (!store) {
		store = openStore(key).catch((err) => {
			stores.delete(key);
			throw err;
		});
		stores.set(key, store);
	}
	return store;
}

/** Append one entry. Writes are serialized; a failed write never fails the run. */
export async function appendJournal(
	runDir: string,
	entry: Omit<JournalEntry, "seq" | "ts">,
	now: number = Date.now(),
): Promise<JournalEntry | undefined> {
	try {
		const store = await storeFor(runDir);
		const run = store.queue.then(async () => {
			const seq = store.nextSeq++;
			const data: JournalData = { ...entry, ts: now };
			await store.session.commit((tx) => tx.appendEntry(JournalEntryKind, store.conversationId, { data }), BACKGROUND_CONTEXT);
			return { ...data, seq } satisfies JournalEntry;
		});
		store.queue = run.catch(() => undefined);
		return await run;
	} catch {
		return undefined;
	}
}

/** Read the run's journal in append order. Missing or broken storage reads as empty. */
export async function readJournal(runDir: string): Promise<JournalEntry[]> {
	try {
		const store = await storeFor(runDir);
		return await scanAll(store.session, store.conversationId);
	} catch {
		return [];
	}
}

/** Close and forget the cached Session for one run directory. */
export async function closeJournal(runDir: string): Promise<void> {
	const key = path.resolve(runDir);
	const pending = stores.get(key);
	stores.delete(key);
	if (!pending) return;
	try {
		const store = await pending;
		await store.queue;
		await store.session.close(BACKGROUND_CONTEXT);
	} catch {
		/* already failed or never opened */
	}
}

/** Close every cached journal, e.g. on session shutdown. */
export async function closeJournals(): Promise<void> {
	await Promise.all([...stores.keys()].map((key) => closeJournal(key)));
}

export async function reapOrphanedAgents(
	runDir: string,
	opts?: {
		isAlive?: (pid: number) => boolean;
		kill?: (pid: number) => void;
		isOurs?: (pid: number) => boolean;
	},
): Promise<number[]> {
	const isAlive =
		opts?.isAlive ??
		((pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		});
	const kill =
		opts?.kill ??
		((pid: number) => {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				/* gone */
			}
		});
	// A recorded pid may have been recycled by an unrelated same-user process, or
	// may belong to a subagent a concurrent pi session is actively running for the
	// same run key. Only reap processes whose command line proves they belong to
	// this run (the subagent is spawned with its system prompt under this runDir).
	const isOurs =
		opts?.isOurs ??
		((pid: number) => {
			try {
				const cmd = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
					encoding: "utf-8",
					stdio: ["ignore", "pipe", "ignore"],
				});
				return cmd.includes(runDir);
			} catch {
				return false;
			}
		});
	const killed: number[] = [];
	for (const owner of inFlightOwners(await readJournal(runDir))) {
		if (isAlive(owner.pid) && isOurs(owner.pid)) {
			kill(owner.pid);
			killed.push(owner.pid);
		}
	}
	return killed;
}
