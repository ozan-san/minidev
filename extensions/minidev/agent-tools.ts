/**
 * minidev search tools — `grep`, `find`, and `ls` as pi-durable tools over the built-in `bash` tool.
 *
 * pi-durable only ships `read`, `write`, `edit`, and `bash`, while the role prompts and `agents/*.md` frontmatter ask for
 * `read, grep, find, ls, bash, edit, write`. These tools translate a model call into a shell command and reuse `bash`
 * (and its output limits, environment and guard hooks) through a nested `executeTool("bash", ...)` call, so no prompt
 * changes are needed.
 */
import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { shellQuote } from "./util.ts";

/** `ls`, one entry per line, directories suffixed with `/`. */
export function lsCommand(a: { path?: string }): string {
	return `ls -1Ap -- ${shellQuote(a.path ?? ".")}`;
}

/** `find` by name glob, bounded depth and skipping `.git` and `node_modules`. */
export function findCommand(a: { pattern: string; path?: string }): string {
	return `find ${shellQuote(a.path ?? ".")} -maxdepth 6 -name ${shellQuote(a.pattern)} -not -path '*/.git/*' -not -path '*/node_modules/*'`;
}

/** `grep`/`rg`, line-oriented with file and line number, falling back to `grep -rnE` when ripgrep is absent. */
export function grepCommand(a: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean }): string {
	const flags = `${a.ignoreCase ? " -i" : ""}`;
	const rgGlob = a.glob ? ` -g ${shellQuote(a.glob)}` : "";
	const grepGlob = a.glob ? ` --include ${shellQuote(a.glob)}` : "";
	return `if command -v rg >/dev/null 2>&1; then rg --line-number --no-heading --color never --max-count 200${flags}${rgGlob} -- ${shellQuote(a.pattern)} ${shellQuote(a.path ?? ".")}; else grep -rnE${flags}${grepGlob} -- ${shellQuote(a.pattern)} ${shellQuote(a.path ?? ".")}; fi`;
}

/**
 * Run one command through the `bash` tool as a nested call and flatten its result to model text. A grep/find with no
 * matches exits 1; report that as text. A real failure reports the error diagnostics. Any other error (such as `bash`
 * not being enabled) is returned as text so the conversation can continue.
 */
async function runShell(command: string, api: ToolExecutionApi, context: Context): Promise<string> {
	try {
		const r = await api.executeTool("bash", { command }, context);
		const out = r.structuredOutput as { output?: string; exitCode?: number } | undefined;
		if (out?.exitCode === 1) return "(no matches)";
		if (r.isError) {
			const errors = r.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
			return errors.length ? errors.join("\n") : (out?.output ?? "(no output)");
		}
		return out?.output ?? "(no output)";
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

const grep = defineTool({
	name: "grep",
	description: "Search file contents with a regex (ripgrep, falling back to grep -rnE). Returns matching file:line:text lines.",
	parameters: Type.Object({
		pattern: Type.String(),
		path: Type.Optional(Type.String()),
		glob: Type.Optional(Type.String()),
		ignoreCase: Type.Optional(Type.Boolean()),
	}),
	replay: "safe",
	execute: async (args, api, context) => {
		api.output(await runShell(grepCommand(args), api, context));
		return {};
	},
});

const find = defineTool({
	name: "find",
	description: "Find files by name glob under a directory (node_modules and .git are skipped).",
	parameters: Type.Object({
		pattern: Type.String(),
		path: Type.Optional(Type.String()),
	}),
	replay: "safe",
	execute: async (args, api, context) => {
		api.output(await runShell(findCommand(args), api, context));
		return {};
	},
});

const ls = defineTool({
	name: "ls",
	description: "List a directory (directories end with /).",
	parameters: Type.Object({
		path: Type.Optional(Type.String()),
	}),
	replay: "safe",
	execute: async (args, api, context) => {
		api.output(await runShell(lsCommand(args), api, context));
		return {};
	},
});

/** The `grep`, `find`, and `ls` tools, all backed by the `bash` tool. */
export function createSearchTools(): Extension {
	return defineExtension({ name: "minidev-search", tools: [grep, find, ls] });
}
