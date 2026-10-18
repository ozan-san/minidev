/**
 * minidev guard — loaded into every subagent process (`pi -e guard.ts`).
 * The orchestrator owns git; subagents may only edit files inside their worktree.
 */
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GIT_BLOCKED =
	/\bgit\s+(?:-C\s+\S+\s+)?(push|commit|checkout|switch|reset|rebase|merge|cherry-pick|revert|worktree|stash|tag|remote|clean|branch\s+-[dDmM]|config)\b/;
const SHELL_BLOCKED = [
	/\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+(\/|~|\$HOME)(\s|$)/, // rm -rf / or ~
	/\bsudo\b/,
	/\b(gh|glab)\s+(pr|mr|repo|release)\b/,
];

export default function (pi: ExtensionAPI) {
	const root = path.resolve(process.env.MINIDEV_WORKTREE || process.cwd());
	const allowed = [root, path.resolve(os.tmpdir()), "/tmp", "/private/tmp"];

	pi.on("tool_call", async (event) => {
		if (event.toolName === "bash") {
			const cmd = String((event.input as { command?: string }).command ?? "");
			if (GIT_BLOCKED.test(cmd)) {
				return {
					block: true,
					reason: "minidev: git history/branch operations are handled by the orchestrator. Read-only git (status, diff, log, show) is fine.",
				};
			}
			for (const re of SHELL_BLOCKED) {
				if (re.test(cmd)) return { block: true, reason: `minidev: command not allowed in subagent (${re.source})` };
			}
		}
		if (event.toolName === "write" || event.toolName === "edit") {
			const input = event.input as { path?: string; file_path?: string };
			const p = input.path ?? input.file_path;
			if (p) {
				const abs = path.resolve(root, p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
				if (!allowed.some((a) => abs === a || abs.startsWith(a + path.sep))) {
					return { block: true, reason: `minidev: writes are restricted to the worktree (${root})` };
				}
			}
		}
		return undefined;
	});
}
