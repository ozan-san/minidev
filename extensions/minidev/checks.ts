import * as fs from "node:fs";
import * as path from "node:path";
import type { Check } from "./config.ts";
import { ensureDir, sh, tail } from "./util.ts";

export interface CheckResult {
	name: string;
	command: string;
	ok: boolean;
	skipped: boolean;
	blocking: boolean;
	code: number;
	timedOut: boolean;
	durationMs: number;
	logPath: string;
	/** Last lines of output, for feeding back to agents. */
	tail: string;
}

/** Gradle prints the useful part (e: file:line errors, "What went wrong") — pull it to the top. */
function extractErrors(output: string): string {
	const lines = output.split("\n");
	const picked = lines.filter((l) =>
		/^(e: |w: .*error|.*error:|FAILURE:|\* What went wrong|> Task .* FAILED|.*Exception|\s+at .*Test|.*FAILED$|Execution failed)/.test(l),
	);
	return picked.slice(0, 80).join("\n");
}

export async function runChecks(
	checks: Check[],
	cwd: string,
	logDir: string,
	label: string,
	opts: { hasTests: boolean; signal?: AbortSignal; onLine?: (check: string, line: string) => void },
): Promise<CheckResult[]> {
	ensureDir(logDir);
	const results: CheckResult[] = [];
	for (const c of checks) {
		const blocking = c.blocking !== false;
		const logPath = path.join(logDir, `${label}-${c.name}.log`);
		if (c.when === "hasTests" && !opts.hasTests) {
			results.push({ name: c.name, command: c.command, ok: true, skipped: true, blocking, code: 0, timedOut: false, durationMs: 0, logPath, tail: "" });
			continue;
		}
		const started = Date.now();
		let partial = "";
		const r = await sh(c.command, {
			cwd,
			signal: opts.signal,
			timeoutMs: (c.timeoutSec ?? 1800) * 1000,
			onData: (chunk) => {
				partial += chunk;
				const lines = partial.split("\n");
				partial = lines.pop() ?? "";
				const last = lines.filter((l) => l.trim()).pop();
				if (last) opts.onLine?.(c.name, last);
			},
		});
		const output = `$ ${c.command}\n${r.stdout}\n${r.stderr}`;
		fs.writeFileSync(logPath, output, "utf-8");
		const errors = extractErrors(output);
		results.push({
			name: c.name,
			command: c.command,
			ok: r.code === 0,
			skipped: false,
			blocking,
			code: r.code,
			timedOut: r.timedOut,
			durationMs: Date.now() - started,
			logPath,
			tail: `${errors ? `Key error lines:\n${errors}\n\n` : ""}Last output:\n${tail(output, 120)}`,
		});
		if (r.aborted) break;
		// Stop at the first blocking failure: later checks (tests, lint) are meaningless if the build is broken.
		if (r.code !== 0 && blocking) break;
	}
	return results;
}

export function failuresReport(results: CheckResult[]): string {
	return results
		.filter((r) => !r.ok && r.blocking)
		.map(
			(r) =>
				`### Check "${r.name}" failed (exit ${r.code}${r.timedOut ? ", timed out" : ""})\nCommand: \`${r.command}\`\nFull log: ${r.logPath}\n\n\`\`\`\n${r.tail}\n\`\`\``,
		)
		.join("\n\n");
}
