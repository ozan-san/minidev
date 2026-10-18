/**
 * minidev agent harness — one pi-durable `Harness` per run, in process.
 *
 * Every agent call reuses the run's reserved root conversation: `reset()` starts a fresh model context, `configure()`
 * sets model/thinking/tools/instructions/cwd, and the call's task is submitted as a durable submission keyed by
 * `requestId`. That makes a call replayable (settled + ok), re-attachable after a crash (submission still live), or a
 * new attempt (anything else), and every call leaves a `CallRecord` in the `minidev.calls` document.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	Harness,
	ROOT_CONVERSATION_ID,
	createRegistry,
	createSession,
	watchEvents,
	type Conversation,
	type EntryId,
	type EntryRecord,
	type Registry,
	type Session,
	type SettledSubmissionRecord,
	type SubmissionId,
	type SubmissionRecord,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createGuardExtension, ScopeDoc } from "./agent-guard.ts";
import { createSearchTools } from "./agent-tools.ts";
import type { AgentDef } from "./agents.ts";
import type { RoleModel } from "./config.ts";
import {
	callCost,
	countAssistants,
	assistantMessage,
	lastAssistant,
	loadProjectContext,
	sessionDir,
	summarizeTool,
	toolSelection,
	totalCost,
} from "./harness-util.ts";
import { modelsFromRegistry, resolveModelRef, type ModelRegistryLike, type ParsedModelRef } from "./harness-models.ts";
import {
	LedgerDoc,
	attemptRequestId,
	callKey,
	decideCall,
	findCall,
	upsertCall,
	type CallRecord,
	type LiveState,
} from "./ledger.ts";
import { ensureDir } from "./util.ts";

export type RunnerEvent =
	| { type: "tool"; name: string; summary: string }
	| { type: "text"; text: string }
	| { type: "usage"; costUsd: number; turns: number; model?: string }
	| { type: "retry"; message: string };

export interface RunAgentOptions {
	agent: AgentDef;
	model: RoleModel;
	task: string;
	cwd: string;
	/** Directory for transcripts and prompt files. */
	workDir: string;
	label: string;
	/** Stable identity of this call across resumes. */
	requestId: string;
	/** Hash of the call's inputs; changing them makes a new replay key. */
	inputHash: string;
	/** Reuse a settled successful call instead of running it again. */
	replay: boolean;
	signal?: AbortSignal;
	/** Remaining USD this call may spend. */
	maxUsd: number;
	onEvent?: (e: RunnerEvent) => void;
}

export interface RunAgentResult {
	ok: boolean;
	output: string;
	costUsd: number;
	turns: number;
	model: string;
	stopReason?: string;
	error?: string;
	budgetExceeded: boolean;
	aborted: boolean;
	transcript: string;
	/** True when the result was served from the ledger instead of a new submission. */
	replayed?: boolean;
}

export interface AgentHarnessOptions {
	runDir: string;
	registry: ModelRegistryLike;
}

/** What `finalize()` needs to turn a settled submission into a result and a ledger record. */
interface FinalizeArgs {
	o: RunAgentOptions;
	base: string;
	attempt: number;
	submissionId: SubmissionId;
	transcript: string;
	usageBase: number;
	settled: SettledSubmissionRecord;
	budgetExceeded: boolean;
	aborted: boolean;
}

/** A failed `RunAgentResult` with no output, cost or turns — the shape every early failure path returns. */
function failedResult(model: string, transcript: string, error: string): RunAgentResult {
	return { ok: false, output: "", costUsd: 0, turns: 0, model, error, budgetExceeded: false, aborted: false, transcript };
}

/** Blank ledger record for one attempt; callers override the fields they know. */
function blankCall(o: RunAgentOptions, base: string, attempt: number, usageBase: number): CallRecord {
	return {
		requestId: base,
		inputHash: o.inputHash,
		attempt,
		status: "running",
		ok: false,
		submissionId: null,
		output: null,
		costUsd: 0,
		turns: 0,
		model: null,
		stopReason: null,
		error: null,
		transcript: null,
		usageBase,
		at: Date.now(),
	};
}

/** The ledger stores submission ids as strings (strict JSON); pi-durable ids are branded numbers. */
function storedId(id: SubmissionId): string {
	return String(id);
}

/** Parse a ledger `submissionId` back into a pi-durable id. */
function parseId(value: string | null): SubmissionId | undefined {
	if (value === null) return undefined;
	const id = Number(value);
	// `SubmissionId` is a branded number, so a valid numeric ledger value is a submission id.
	return Number.isInteger(id) ? (id as SubmissionId) : undefined;
}

/** A promise plus its resolver, for waking a `Promise.race` from an event listener. */
function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** One open pi-durable Harness per run, driven call by call. */
export class AgentHarness {
	// Fields are declared explicitly (not as constructor parameter properties): the project runs `node --test` in
	// strip-only TypeScript mode, which cannot parse parameter properties, so the module must stay loadable there.
	private readonly harness: Harness;
	private readonly registry: Registry;
	private readonly registryLike: ModelRegistryLike;
	private readonly models: Models;
	private readonly runDir: string;
	private rootConversation?: Conversation;

	private constructor(harness: Harness, registry: Registry, registryLike: ModelRegistryLike, models: Models, runDir: string) {
		this.harness = harness;
		this.registry = registry;
		this.registryLike = registryLike;
		this.models = models;
		this.runDir = runDir;
	}

	static async open(o: AgentHarnessOptions): Promise<AgentHarness> {
		const storage = await openNodeJsonlStorage(sessionDir(o.runDir), BACKGROUND_CONTEXT);
		const models = modelsFromRegistry(o.registry);
		const registry = createRegistry();
		registry.install(CodingTools);
		registry.install(createSearchTools());
		registry.install(createGuardExtension());
		const harness = await Harness.open(
			storage,
			{
				models,
				registry,
				env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
				// Compaction is disabled: every call starts from a `reset()`, so no context ever needs compacting.
				settings: { compaction: { enabled: false } },
			},
			BACKGROUND_CONTEXT,
		);
		return new AgentHarness(harness, registry, o.registry, models, o.runDir);
	}

	private async root(): Promise<Conversation> {
		this.rootConversation ??= await this.harness.root(BACKGROUND_CONTEXT);
		return this.rootConversation;
	}

	private async ledger(): Promise<CallRecord[]> {
		const conversation = await this.root();
		return (await this.harness.snapshot(LedgerDoc, conversation.id, BACKGROUND_CONTEXT))?.calls ?? [];
	}

	private async writeCall(record: CallRecord): Promise<void> {
		const conversation = await this.root();
		await conversation.commit(async (tx) => {
			// Re-read the draft inside the commit: another writer may have changed the ledger since our last read.
			const doc = await tx.doc(LedgerDoc, conversation.id);
			doc.calls = upsertCall(doc.calls, record);
		}, BACKGROUND_CONTEXT);
	}

	private async locate(record: CallRecord): Promise<{ state: LiveState; submissionId?: SubmissionId }> {
		const conversation = await this.root();
		const id =
			parseId(record.submissionId) ??
			(
				await this.harness.commit(
					(tx) => tx.submissionByRequest(conversation.id, attemptRequestId(record.requestId, record.attempt)),
					BACKGROUND_CONTEXT,
				)
			)?.id;
		if (id === undefined) return { state: "none" };
		const submission = await this.harness.submission(id, BACKGROUND_CONTEXT);
		if (!submission) return { state: "none" };
		const status: SubmissionRecord = await submission.status(BACKGROUND_CONTEXT);
		const state: LiveState =
			status.status === "queued" || status.status === "placed" ? "running" : status.status === "done" ? "done" : "failed";
		return { state, submissionId: id };
	}

	private allTools(): ToolRegistration[] {
		return this.registry.snapshot().tools().map((t) => t.tool);
	}

	private async prepare(o: RunAgentOptions, ref: ParsedModelRef): Promise<void> {
		const conversation = await this.root();
		await conversation.commit(async (tx) => {
			const doc = await tx.doc(ScopeDoc, conversation.id);
			doc.root = o.cwd;
			doc.tmp = [os.tmpdir(), "/tmp", "/private/tmp"];
		}, BACKGROUND_CONTEXT);
		await conversation.reset(undefined, BACKGROUND_CONTEXT);
		await conversation.configure(
			{
				model: ref,
				thinkingLevel: o.model.thinking ?? "off",
				instructions: [o.agent.systemPrompt, loadProjectContext(o.cwd)].filter(Boolean).join("\n\n"),
				cwd: o.cwd,
				tools: toolSelection(this.allTools(), o.agent.tools),
			},
			BACKGROUND_CONTEXT,
		);
	}

	private async entry(id: EntryId): Promise<EntryRecord | undefined> {
		return this.harness.commit((tx) => tx.entry(AssistantEntry, id), BACKGROUND_CONTEXT);
	}

	private async finalize(args: FinalizeArgs): Promise<RunAgentResult> {
		const { o, base, attempt, submissionId, transcript, usageBase, settled, budgetExceeded, aborted } = args;
		const view = await (await this.root()).context(BACKGROUND_CONTEXT);
		const costUsd = callCost(view.entries);
		const turns = countAssistants(view.entries);
		const last = lastAssistant(view.entries);
		const answerId = settled.status === "done" ? settled.answer : undefined;
		const answerEntry = answerId === undefined ? undefined : await this.entry(answerId);
		const answer = (answerEntry ? lastAssistant([answerEntry]) : undefined) ?? last;

		const stopReason = answer?.stopReason;
		const ok =
			settled.status === "done" && !budgetExceeded && !aborted && stopReason !== "error" && stopReason !== "aborted";
		const unanswered =
			settled.status === "unanswered"
				? `${settled.reason}${settled.detail ? `: ${JSON.stringify(settled.detail)}` : ""}`
				: undefined;
		const error = ok
			? undefined
			: ((answer?.error ?? unanswered ?? last?.error) || "agent run did not produce an answer");
		const output = answer?.text ?? "";
		const model = answer?.model ?? o.model.model;

		const lines = view.entries.map((e) => JSON.stringify({ kind: e.kind, model: e.model, data: e.data }));
		fs.writeFileSync(transcript, lines.length ? `${lines.join("\n")}\n` : "", "utf-8");

		await this.writeCall({
			...blankCall(o, base, attempt, usageBase),
			status: "settled",
			ok,
			submissionId: storedId(submissionId),
			output,
			costUsd,
			turns,
			model,
			stopReason: stopReason ?? null,
			error: error ?? null,
			transcript,
			at: Date.now(),
		});

		return {
			ok,
			output,
			costUsd,
			turns,
			model,
			stopReason,
			error,
			budgetExceeded,
			aborted,
			transcript,
			replayed: false,
		};
	}

	async run(o: RunAgentOptions): Promise<RunAgentResult> {
		ensureDir(o.workDir);
		const safe = o.label.replace(/[^\w.-]+/g, "_");
		fs.writeFileSync(path.join(o.workDir, `${safe}.system.md`), o.agent.systemPrompt, "utf-8");
		fs.writeFileSync(path.join(o.workDir, `${safe}.task.md`), o.task, "utf-8");
		const transcript = path.join(o.workDir, `${safe}.jsonl`);

		const ref = resolveModelRef(this.registryLike, o.model.model);
		if (!ref) {
			fs.writeFileSync(transcript, "", "utf-8");
			return failedResult(o.model.model, transcript, `model not available: ${o.model.model}`);
		}

		const base = callKey(o.requestId, o.inputHash);
		const calls = await this.ledger();
		const record = findCall(calls, base);
		const { state: live, submissionId: liveSubmissionId } = record
			? await this.locate(record)
			: { state: "none" as LiveState };
		const decision = decideCall(record, live, o.replay);

		if (decision.kind === "replay") {
			return {
				ok: true,
				output: decision.record.output ?? "",
				costUsd: decision.record.costUsd,
				turns: decision.record.turns,
				model: decision.record.model ?? o.model.model,
				stopReason: decision.record.stopReason ?? undefined,
				error: decision.record.error ?? undefined,
				budgetExceeded: false,
				aborted: false,
				transcript,
				replayed: true,
			};
		}

		let attempt: number;
		let usageBase: number;
		let submissionId: SubmissionId | undefined;
		if (decision.kind === "attach" && record) {
			attempt = record.attempt;
			usageBase = record.usageBase;
			submissionId = parseId(record.submissionId) ?? liveSubmissionId;
		} else {
			attempt = decision.kind === "fresh" ? decision.attempt : (record?.attempt ?? 0) + 1;
			usageBase = 0;
		}

		if (submissionId === undefined) {
			// A fresh attempt: baseline the usage, reset+configure the conversation, then admit the task durably.
			usageBase = totalCost(await this.harness.usage(BACKGROUND_CONTEXT));
			await this.prepare(o, ref);
			const running = blankCall(o, base, attempt, usageBase);
			await this.writeCall(running);
			const submitted = await (await this.root()).submit(
				{ type: "input", content: o.task, requestId: attemptRequestId(base, attempt) },
				BACKGROUND_CONTEXT,
			);
			submissionId = submitted.id;
			await this.writeCall({ ...running, submissionId: storedId(submissionId) });
		}

		const submission = await this.harness.submission(submissionId, BACKGROUND_CONTEXT);
		if (!submission) {
			const error = `submission not found: ${storedId(submissionId)}`;
			await this.writeCall({
				...blankCall(o, base, attempt, usageBase),
				status: "settled",
				error,
				output: "",
				model: o.model.model,
				transcript,
			});
			return failedResult(o.model.model, transcript, error);
		}

		const stream = await watchEvents(this.harness, (await this.root()).id, BACKGROUND_CONTEXT);
		let liveTurns = 0;
		let budgetExceeded = false;
		let aborted = false;
		const breached = deferred();
		const stopped = deferred();

		// The listener runs on the commit line, so it must never call a Session or conversation API (that would
		// deadlock); it only records live state, emits dashboard events and wakes the race below.
		const onAbort = () => stopped.resolve();
		if (o.signal?.aborted) onAbort();
		else o.signal?.addEventListener("abort", onAbort, { once: true });

		stream.start(async (events) => {
			for (const e of events) {
				switch (e.type) {
					case "usage_changed": {
						const costUsd = totalCost(e.usage) - usageBase;
						o.onEvent?.({ type: "usage", costUsd, turns: liveTurns, model: o.model.model });
						if (costUsd >= o.maxUsd && !budgetExceeded) {
							budgetExceeded = true;
							breached.resolve();
						}
						break;
					}
					case "tool_execution_start":
						o.onEvent?.({ type: "tool", name: e.toolName, summary: summarizeTool(e.toolName, e.args) });
						break;
					case "auto_retry_start":
						o.onEvent?.({ type: "retry", message: `retry ${e.attempt}: ${e.errorMessage}` });
						break;
					case "message_end": {
						if (assistantMessage(e.entry)) {
							liveTurns += 1;
							o.onEvent?.({ type: "text", text: lastAssistant([e.entry])?.text ?? "" });
						}
						break;
					}
				}
			}
		});

		try {
			const outcome = await Promise.race([
				submission.wait(BACKGROUND_CONTEXT).then((settled) => ({ kind: "settled" as const, settled })),
				breached.promise.then(() => ({ kind: "budget" as const })),
				stopped.promise.then(() => ({ kind: "aborted" as const })),
			]);
			let settled: SettledSubmissionRecord;
			if (outcome.kind === "settled") {
				settled = outcome.settled;
				aborted = o.signal?.aborted === true;
			} else {
				aborted = outcome.kind === "aborted";
				await (await this.root()).abort(BACKGROUND_CONTEXT);
				settled = await submission.wait(BACKGROUND_CONTEXT);
			}
			return await this.finalize({
				o,
				base,
				attempt,
				submissionId,
				transcript,
				usageBase,
				settled,
				budgetExceeded,
				aborted,
			});
		} finally {
			await stream.stop().catch(() => undefined);
			o.signal?.removeEventListener("abort", onAbort);
		}
	}

	/** Read the run's call ledger without submitting anything. */
	async readCalls(): Promise<CallRecord[]> {
		return this.ledger();
	}

	async close(): Promise<void> {
		await this.harness.close(BACKGROUND_CONTEXT);
	}
}

const open = new Map<string, Promise<AgentHarness>>();

/** Open (or reuse) the process-wide harness for a run directory. */
export function agentHarness(o: AgentHarnessOptions): Promise<AgentHarness> {
	const key = path.resolve(o.runDir);
	const cached = open.get(key);
	if (cached) return cached;
	const pending = AgentHarness.open(o).catch((err: unknown) => {
		open.delete(key);
		throw err;
	});
	open.set(key, pending);
	return pending;
}

/** Close and forget the harness of one run directory. */
export async function closeHarness(runDir: string): Promise<void> {
	const key = path.resolve(runDir);
	const pending = open.get(key);
	open.delete(key);
	if (!pending) return;
	try {
		await (await pending).close();
	} catch {
		// A harness that failed to open or already closed has nothing left to release.
	}
}

/** Close every open harness, for extension shutdown. */
export async function closeHarnesses(): Promise<void> {
	await Promise.all([...open.keys()].map((key) => closeHarness(key)));
}

/** Read a run's call ledger, reusing the cached harness or opening the session briefly. */
export async function readLedger(runDir: string): Promise<CallRecord[]> {
	const cached = open.get(path.resolve(runDir));
	if (cached) {
		try {
			return await (await cached).readCalls();
		} catch {
			return [];
		}
	}
	let session: Session | undefined;
	try {
		session = createSession(await openNodeJsonlStorage(sessionDir(runDir), BACKGROUND_CONTEXT));
		return (await session.snapshot(LedgerDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT))?.calls ?? [];
	} catch {
		return [];
	} finally {
		await session?.close(BACKGROUND_CONTEXT).catch(() => undefined);
	}
}

// Single import site for the pipeline: call identity, the ledger type and its summary.
export { inputHash, requestIdFor } from "./harness-util.ts";
export { summarizeLedger, type CallRecord, type LedgerSummary } from "./ledger.ts";
