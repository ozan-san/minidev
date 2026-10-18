/**
 * minidev call ledger — the durable record of every agent call on the in-process harness.
 *
 * Each call is one `CallRecord` inside a latest-only conversation document, so a crash leaves a `running` record that
 * the next run can attach to or supersede. All fields are strict JSON (no optional/undefined values — pi-durable
 * rejects them), and every helper is pure so the replay decision can be tested without a Session.
 */
import { defineDoc, type JsonObject } from "@earendil-works/pi-durable";

/**
 * Durable record of one agent call, keyed by `requestId`. Nullable fields are explicit `null` rather than `undefined`
 * because pi-durable documents only accept strict JSON.
 */
export interface CallRecord extends JsonObject {
	/** Base key for the call (`callKey`); retries get an attempt-suffixed `requestId`. */
	requestId: string;
	/** Hash of the call's inputs, so a changed input is a different replay key. */
	inputHash: string;
	/** 1-based attempt number for this call. */
	attempt: number;
	/** Whether the call is still in flight or has reached a terminal state. */
	status: "running" | "settled";
	/** Terminal success flag; meaningful once `status` is `settled`. */
	ok: boolean;
	/** pi-durable submission id once the call was submitted, else `null`. */
	submissionId: string | null;
	/** Agent output text once settled, else `null`. */
	output: string | null;
	/** Cost of the attempt in USD. */
	costUsd: number;
	/** Number of model turns the attempt took. */
	turns: number;
	/** Model id used for the attempt. */
	model: string | null;
	/** Provider stop reason once settled, else `null`. */
	stopReason: string | null;
	/** Error message when the attempt failed, else `null`. */
	error: string | null;
	/** Serialized conversation transcript for the attempt, else `null`. */
	transcript: string | null;
	/** Conversation cost total when the attempt started, used to derive per-call cost. */
	usageBase: number;
	/** Wall-clock time the attempt started (epoch ms). */
	at: number;
}

/** Latest-only conversation document holding every call record for the run. */
export const LedgerDoc = defineDoc<{ calls: CallRecord[] }>({
	kind: "minidev.calls",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ calls: [] }),
});

/** Base identity for a call, independent of the attempt number. */
export function callKey(requestId: string, inputHash: string): string {
	return `${requestId}:${inputHash}`;
}

/** First attempt keeps the base id; retries append `#<attempt>`. */
export function attemptRequestId(base: string, attempt: number): string {
	return attempt <= 1 ? base : `${base}#${attempt}`;
}

/** Find the record for a `requestId`, if any. */
export function findCall(calls: readonly CallRecord[], requestId: string): CallRecord | undefined {
	return calls.find((c) => c.requestId === requestId);
}

/** Replace the record with the same `requestId`, or append it; always returns a new array. */
export function upsertCall(calls: readonly CallRecord[], record: CallRecord): CallRecord[] {
	const index = calls.findIndex((c) => c.requestId === record.requestId);
	if (index === -1) return [...calls, record];
	return calls.map((c, i) => (i === index ? record : c));
}

/** Liveness of the underlying pi-durable submission, as observed by the harness. */
export type LiveState = "none" | "running" | "done" | "failed";

/** What the harness should do with a call given its ledger record and live submission state. */
export type CallDecision = { kind: "replay"; record: CallRecord } | { kind: "attach" } | { kind: "fresh"; attempt: number };

/** Turn a ledger record plus live submission state into a replay, attach, or fresh decision. */
export function decideCall(record: CallRecord | undefined, live: LiveState, replay: boolean): CallDecision {
	// No record yet: first attempt.
	if (!record) return { kind: "fresh", attempt: 1 };
	// Settled and successful with replay enabled: reuse the recorded result.
	if (record.status === "settled" && record.ok && replay) return { kind: "replay", record };
	// Still running (or already done) in pi-durable: attach to the live submission.
	if (record.status === "running" && (live === "running" || live === "done")) return { kind: "attach" };
	// Anything else (failed, cancelled, replay disabled): retry as a new attempt.
	return { kind: "fresh", attempt: record.attempt + 1 };
}

/** Aggregate counts over the ledger. */
export interface LedgerSummary {
	calls: number;
	done: number;
	failed: number;
	running: number;
	lastAt?: number;
}

/** Summarize a ledger: settled successes, settled failures, in-flight calls and the latest `at`. */
export function summarizeLedger(calls: readonly CallRecord[]): LedgerSummary {
	const summary: LedgerSummary = { calls: calls.length, done: 0, failed: 0, running: 0 };
	for (const c of calls) {
		if (c.status === "running") summary.running += 1;
		else if (c.ok) summary.done += 1;
		else summary.failed += 1;
		summary.lastAt = summary.lastAt === undefined ? c.at : Math.max(summary.lastAt, c.at);
	}
	return summary;
}
