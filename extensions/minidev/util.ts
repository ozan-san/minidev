import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
}

export interface ExecOptions {
	cwd: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
	/** Called with every chunk of combined output. */
	onData?: (chunk: string) => void;
}

/** Run a program (no shell). Kills the whole process group on timeout/abort. */
export function exec(command: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		let settled = false;

		const killGroup = () => {
			try {
				if (proc.pid) process.kill(-proc.pid, "SIGTERM");
			} catch {
				/* already gone */
			}
			setTimeout(() => {
				try {
					if (proc.pid) process.kill(-proc.pid, "SIGKILL");
				} catch {
					/* already gone */
				}
			}, 5000).unref();
		};

		const timer = opts.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					killGroup();
				}, opts.timeoutMs)
			: undefined;

		const onAbort = () => {
			aborted = true;
			killGroup();
		};
		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}

		proc.stdout.on("data", (d: Buffer) => {
			const s = d.toString();
			stdout += s;
			opts.onData?.(s);
		});
		proc.stderr.on("data", (d: Buffer) => {
			const s = d.toString();
			stderr += s;
			opts.onData?.(s);
		});
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			resolve({ code, stdout, stderr, timedOut, aborted });
		};
		proc.on("close", (code) => finish(code ?? 1));
		proc.on("error", (err) => {
			stderr += String(err);
			finish(127);
		});
	});
}

/** Run a shell command line through bash. */
export function sh(command: string, opts: ExecOptions): Promise<ExecResult> {
	return exec("bash", ["-lc", command], opts);
}

/** Run git, throw on failure. */
export async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
	const r = await exec("git", args, { cwd, signal });
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
	return r.stdout.trim();
}

/** Run git, return null on failure. */
export async function gitTry(cwd: string, args: string[]): Promise<string | null> {
	const r = await exec("git", args, { cwd });
	return r.code === 0 ? r.stdout.trim() : null;
}

export function shellQuote(s: string): string {
	if (s === "") return "''";
	if (/^[\w@%+=:,./-]+$/.test(s)) return s;
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

export function slugify(s: string, max = 40): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, max)
			.replace(/-+$/g, "") || "change"
	);
}

export function tail(text: string, lines: number): string {
	const all = text.split("\n");
	return all.length <= lines ? text : `…(${all.length - lines} earlier lines omitted)\n${all.slice(-lines).join("\n")}`;
}

export function ensureDir(dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function writeFile(file: string, content: string): void {
	ensureDir(path.dirname(file));
	fs.writeFileSync(file, content, "utf-8");
}

export function readFileOr(file: string, fallback: string): string {
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return fallback;
	}
}

export function fmtUsd(n: number): string {
	return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function fmtDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

/** Extract the last ```json fenced block (or a bare JSON object) from model output. */
export function extractJson<T = unknown>(text: string): T {
	const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)];
	for (let i = fences.length - 1; i >= 0; i--) {
		try {
			return JSON.parse(fences[i][1]) as T;
		} catch {
			/* try previous */
		}
	}
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1)) as T;
	throw new Error("No JSON block found in output");
}

/** Remove fenced json blocks from text (to keep the human-readable part). */
export function stripJsonBlocks(text: string): string {
	return text.replace(/```json\s*\n[\s\S]*?\n```/g, "").trim();
}

export function deepMerge<T>(base: T, over: unknown): T {
	if (over === undefined || over === null) return base;
	if (Array.isArray(base) || Array.isArray(over) || typeof base !== "object" || typeof over !== "object") {
		return over as T;
	}
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
		out[k] = deepMerge(out[k], v);
	}
	return out as T;
}
