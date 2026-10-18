import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
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

export interface JournalSummary {
	entries: number;
	lastSeq: number;
	checkpoints: string[];
	inFlight: string[];
	completed: number;
	lastAt?: number;
}

export function journalFile(runDir: string): string {
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

export function readJournal(file: string): JournalEntry[] {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
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

export function appendJournal(file: string, entry: Omit<JournalEntry, "seq" | "ts">, now: number = Date.now()): JournalEntry {
	const last = readJournal(file).at(-1);
	const seq = (last?.seq ?? 0) + 1;
	const full: JournalEntry = { ...entry, seq, ts: now };
	try {
		ensureDir(path.dirname(file));
		fs.appendFileSync(file, `${JSON.stringify(full)}\n`, "utf-8");
	} catch {
		/* journal writes must never fail a run */
	}
	return full;
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
		checkpoints: entries.filter((e) => e.type === "checkpoint" && e.item).map((e) => e.item as string),
		inFlight: inFlightOwners(entries).map((o) => o.item ?? o.requestId),
		completed: entries.filter((e) => e.type === "agent_finished" && e.ok).length,
		lastAt: entries.at(-1)?.ts,
	};
}

export function reapOrphanedAgents(
	runDir: string,
	opts?: { isAlive?: (pid: number) => boolean; kill?: (pid: number) => void },
): number[] {
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
	const killed: number[] = [];
	for (const owner of inFlightOwners(readJournal(journalFile(runDir)))) {
		if (isAlive(owner.pid)) {
			kill(owner.pid);
			killed.push(owner.pid);
		}
	}
	return killed;
}
