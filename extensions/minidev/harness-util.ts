/**
 * Pure helpers shared by the in-process agent harness.
 *
 * Everything here is synchronous and depends only on `node:*` and types, so it can be unit-tested without booting the
 * host pi packages: request identity, usage accounting, entry inspection, tool selection and project context loading.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EntryRecord, ToolRegistration, UsageState } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Stable identity of one agent call, independent of its inputs. */
export function requestIdFor(key: string, role: string, item: string): string {
	return `${key}:${role}:${item}`;
}

/** Hash of a call's inputs, so a changed input is a different replay key. */
export function inputHash(...parts: Array<string | undefined>): string {
	return createHash("sha256")
		.update(parts.map((p) => p ?? "").join("\u0000"))
		.digest("hex")
		.slice(0, 16);
}

/** One-line human summary of a tool call, for live progress events. */
export function summarizeTool(name: string, args: Record<string, unknown>): string {
	const p = (args.path ?? args.file_path ?? "") as string;
	switch (name) {
		case "bash":
			return `$ ${String(args.command ?? "").split("\n")[0]}`;
		case "read":
		case "write":
		case "edit":
		case "ls":
			return `${name} ${p}`;
		case "grep":
			return `grep /${args.pattern ?? ""}/ ${p}`;
		case "find":
			return `find ${args.pattern ?? ""} ${p}`;
		default:
			return `${name} ${JSON.stringify(args).slice(0, 80)}`;
	}
}

/** Directory pi-durable stores a run's conversation in. */
export function sessionDir(runDir: string): string {
	return path.join(runDir, "session");
}

/** Sum every model and tool usage bucket into a single USD total. */
export function totalCost(usage: UsageState): number {
	let sum = 0;
	for (const bucket of [usage.models, usage.tools]) {
		for (const key of Object.keys(bucket)) {
			sum += bucket[key]?.cost?.total ?? 0;
		}
	}
	return sum;
}

/** First assistant message contributed by an entry, if any. */
export function assistantMessage(entry: EntryRecord): AssistantMessage | undefined {
	return entry.model?.find((m): m is AssistantMessage => m.role === "assistant");
}

/** Number of entries that carry an assistant message. */
export function countAssistants(entries: readonly EntryRecord[]): number {
	return entries.reduce((n, e) => (assistantMessage(e) ? n + 1 : n), 0);
}

/** Total model cost across every assistant entry. */
export function callCost(entries: readonly EntryRecord[]): number {
	return entries.reduce((sum, e) => sum + (assistantMessage(e)?.usage.cost.total ?? 0), 0);
}

/** Distilled view of the most recent assistant entry. */
export interface LastAssistant {
	text: string;
	stopReason?: string;
	error?: string;
	model?: string;
}

/** Last assistant entry's text, stop reason, error and model, or `undefined` when there is none. */
export function lastAssistant(entries: readonly EntryRecord[]): LastAssistant | undefined {
	let result: LastAssistant | undefined;
	for (const entry of entries) {
		const message = assistantMessage(entry);
		if (!message) continue;
		result = {
			text: message.content
				.filter((b): b is Extract<AssistantMessage["content"][number], { type: "text" }> => b.type === "text")
				.map((b) => b.text)
				.join("\n")
				.trim(),
			stopReason: message.stopReason,
			error: message.errorMessage,
			model: `${message.provider}/${message.model}`,
		};
	}
	return result;
}

/**
 * Pick the tools offered to a role. An empty `wanted` means everything; otherwise only the named tools. `bash` is
 * always included because `grep`/`find`/`ls` are implemented on top of it, so every role needs it enabled.
 */
export function toolSelection(all: readonly ToolRegistration[], wanted: readonly string[]): ToolRegistration[] {
	if (wanted.length === 0) return [...all];
	const selected = all.filter((t) => wanted.includes(t.name));
	if (!selected.some((t) => t.name === "bash")) {
		const bash = all.find((t) => t.name === "bash");
		if (bash) selected.push(bash);
	}
	return selected;
}

/**
 * Load the project guidance a child `pi` process would otherwise auto-discover. Reads `AGENTS.md` then `CLAUDE.md`,
 * skipping missing or empty files; missing both yields `""`.
 */
export function loadProjectContext(cwd: string): string {
	const blocks: string[] = [];
	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		const file = path.join(cwd, name);
		if (!fs.existsSync(file)) continue;
		const text = fs.readFileSync(file, "utf-8").trim();
		if (!text) continue;
		blocks.push(`# ${name}\n\n${text}`);
	}
	return blocks.join("\n\n");
}
