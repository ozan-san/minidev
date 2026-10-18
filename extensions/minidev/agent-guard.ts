/**
 * minidev guard — a pi-durable beforeTool hook for in-process subagent runs.
 * The orchestrator owns git; subagents may only edit files inside their worktree.
 *
 * Unlike the old `@earendil-works/pi-coding-agent` extension, this hook runs inside the same `ToolTask` the model's
 * calls flow through, so it reads the worktree scope from the committed `ScopeDoc` document instead of process env.
 */
import * as os from "node:os";
import * as path from "node:path";
import { defineDoc, defineExtension, hook, ToolTask, type Extension } from "@earendil-works/pi-durable";

const GIT_BLOCKED =
	/\bgit\s+(?:-C\s+\S+\s+)?(push|commit|checkout|switch|reset|rebase|merge|cherry-pick|revert|worktree|stash|tag|remote|clean|branch\s+-[dDmM]|config)\b/;
const SHELL_BLOCKED = [
	/\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+(\/|~|\$HOME)(\s|$)/, // rm -rf / or ~
	/\bsudo\b/,
	/\b(gh|glab)\s+(pr|mr|repo|release)\b/,
];

/** Worktree scope the orchestrator commits before a subagent run. */
export interface GuardScope {
	readonly root: string;
	readonly tmp: readonly string[];
}

/** Latest-only conversation document holding the allowed write roots. */
export const ScopeDoc = defineDoc<{ root: string; tmp: string[] }>({
	kind: "minidev.scope",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ root: "", tmp: [] }),
});

/** Pure safety decision for one tool call; ported from the subprocess guard so behavior and messages stay identical. */
export function decideToolCall(
	name: string,
	args: Record<string, unknown>,
	scope: GuardScope | undefined,
): { block: string } | undefined {
	if (name === "bash") {
		const cmd = String(args.command ?? "");
		if (GIT_BLOCKED.test(cmd)) {
			return {
				block: "minidev: git history/branch operations are handled by the orchestrator. Read-only git (status, diff, log, show) is fine.",
			};
		}
		for (const re of SHELL_BLOCKED) {
			if (re.test(cmd)) return { block: `minidev: command not allowed in subagent (${re.source})` };
		}
		return undefined;
	}
	if (name === "write" || name === "edit") {
		if (!scope || !scope.root) return undefined;
		const p = args.path;
		if (typeof p !== "string" || !p) return undefined;
		const abs = path.resolve(scope.root, p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
		const allowed = [scope.root, ...scope.tmp];
		if (!allowed.some((a) => abs === a || abs.startsWith(a + path.sep))) {
			return { block: `minidev: writes are restricted to the worktree (${scope.root})` };
		}
	}
	return undefined;
}

/**
 * Guard extension: only reads the committed scope document through the hook API and never calls Session APIs, so it
 * stays safe inside the tool task's phase and replay.
 */
export function createGuardExtension(): Extension {
	return defineExtension({
		name: "minidev-guard",
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api, context) =>
					decideToolCall(call.name, call.arguments ?? {}, (await api.snapshot(ScopeDoc, api.conversationId, context)) ?? undefined),
			}),
		],
	});
}
