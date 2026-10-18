/**
 * Agent prompts = role contract + stack guidance.
 *
 *   agents/<role>.md            stack-agnostic contract (tools, rules, output format the orchestrator parses)
 *   agents/stacks/<stack>.md    per-stack guidance, split by "## All roles" / "## Scout" / "## Planner" / …
 *
 * Overrides (whole file replaced, later wins):
 *   ~/.minidev/agents/<role>.md        <repo>/.minidev/agents/<role>.md
 *   ~/.minidev/stacks/<stack>.md       <repo>/.minidev/stacks/<stack>.md
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ROLES, USER_DIR, type Role } from "./config.ts";
import type { StackInfo } from "./stack.ts";

export interface AgentDef {
	name: string;
	description: string;
	/** Tools passed to `pi --tools`; empty = pi defaults. */
	tools: string[];
	systemPrompt: string;
	/** Files the prompt was composed from (for debugging). */
	sources: string[];
}

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGE_AGENTS = path.join(PACKAGE_ROOT, "agents");

function lastExisting(candidates: string[]): string | undefined {
	return candidates.filter((f) => fs.existsSync(f)).pop();
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
	const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw.replace(/\r\n/g, "\n"));
	const meta: Record<string, string> = {};
	if (!m) return { meta, body: raw.trim() };
	for (const line of m[1].split("\n")) {
		const kv = /^(\w[\w-]*)\s*:\s*(.*)$/.exec(line);
		if (kv) meta[kv[1]] = kv[2].trim();
	}
	return { meta, body: m[2].trim() };
}

/** Split a stack doc into { all, <role>... } by level-2 headings. Text before the first "##" counts as "all". */
export function parseStackDoc(raw: string): Record<string, string> {
	const { body } = parseFrontmatter(raw);
	const out: Record<string, string> = {};
	const parts = body.split(/^## +/m);
	const intro = parts
		.shift()!
		.replace(/^# .*\n?/, "")
		.trim();
	if (intro) out.all = intro;
	for (const part of parts) {
		const nl = part.indexOf("\n");
		const heading = (nl < 0 ? part : part.slice(0, nl)).trim().toLowerCase();
		const text = (nl < 0 ? "" : part.slice(nl + 1)).trim();
		const key = /^all\b/.test(heading) ? "all" : (ROLES.find((r) => heading.startsWith(r)) ?? heading);
		out[key] = [out[key], text].filter(Boolean).join("\n\n");
	}
	return out;
}

export function stackDocFile(stackId: string, repoRoot?: string): string | undefined {
	return lastExisting([
		path.join(PACKAGE_AGENTS, "stacks", `${stackId}.md`),
		path.join(USER_DIR, "stacks", `${stackId}.md`),
		...(repoRoot ? [path.join(repoRoot, ".minidev", "stacks", `${stackId}.md`)] : []),
	]);
}

export function loadAgents(repoRoot: string | undefined, stack: StackInfo | undefined): Map<Role, AgentDef> {
	const docFile = stackDocFile(stack?.id ?? "generic", repoRoot) ?? stackDocFile("generic", repoRoot);
	const doc = docFile ? parseStackDoc(fs.readFileSync(docFile, "utf-8")) : {};
	const out = new Map<Role, AgentDef>();
	for (const role of ROLES) {
		const file = lastExisting([
			path.join(PACKAGE_AGENTS, `${role}.md`),
			path.join(USER_DIR, "agents", `${role}.md`),
			...(repoRoot ? [path.join(repoRoot, ".minidev", "agents", `${role}.md`)] : []),
		]);
		if (!file) continue;
		const { meta, body } = parseFrontmatter(fs.readFileSync(file, "utf-8"));
		const guidance = [doc.all, doc[role]].filter(Boolean).join("\n\n");
		const facts = stack?.facts.length ? `\n\nDetected about this repo:\n${stack.facts.map((f) => `- ${f}`).join("\n")}` : "";
		const systemPrompt = guidance || facts ? `${body}\n\n---\n\n# Stack guidance: ${stack?.label ?? "Generic"}\n\n${guidance}${facts}` : body;
		out.set(role, {
			name: meta.name || role,
			description: meta.description ?? "",
			tools: (meta.tools ?? "")
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean),
			systemPrompt,
			sources: [file, ...(docFile ? [docFile] : [])],
		});
	}
	return out;
}
