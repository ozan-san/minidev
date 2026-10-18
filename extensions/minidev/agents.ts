import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { USER_DIR } from "./config.ts";

export interface AgentDef {
	name: string;
	description: string;
	/** Tools passed to `pi --tools`; empty = pi defaults. */
	tools: string[];
	systemPrompt: string;
	file: string;
}

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGE_AGENTS = path.join(PACKAGE_ROOT, "agents");

function parse(file: string): AgentDef | undefined {
	const raw = fs.readFileSync(file, "utf-8").replace(/\r\n/g, "\n");
	const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
	const meta: Record<string, string> = {};
	if (m) {
		for (const line of m[1].split("\n")) {
			const kv = /^(\w[\w-]*)\s*:\s*(.*)$/.exec(line);
			if (kv) meta[kv[1]] = kv[2].trim();
		}
	}
	const name = meta.name || path.basename(file, ".md");
	return {
		name,
		description: meta.description ?? "",
		tools: (meta.tools ?? "")
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean),
		systemPrompt: (m ? m[2] : raw).trim(),
		file,
	};
}

/** Package agents, overridden by ~/.minidev/agents/*.md, overridden by <repo>/.minidev/agents/*.md. */
export function loadAgents(repoRoot?: string): Map<string, AgentDef> {
	const dirs = [PACKAGE_AGENTS, path.join(USER_DIR, "agents")];
	if (repoRoot) dirs.push(path.join(repoRoot, ".minidev", "agents"));
	const out = new Map<string, AgentDef>();
	for (const dir of dirs) {
		if (!fs.existsSync(dir)) continue;
		for (const f of fs.readdirSync(dir)) {
			if (!f.endsWith(".md")) continue;
			const def = parse(path.join(dir, f));
			if (def) out.set(def.name, def);
		}
	}
	return out;
}
