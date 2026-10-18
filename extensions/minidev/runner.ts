import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PACKAGE_ROOT, type AgentDef } from "./agents.ts";
import type { RoleModel } from "./config.ts";
import { ensureDir } from "./util.ts";

export type RunnerEvent =
	| { type: "started"; pid: number }
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
	signal?: AbortSignal;
	/** Remaining USD this call may spend before it is killed. */
	maxUsd: number;
	isolate: boolean;
	extraArgs: string[];
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
	/** True when the result was served from the durable journal instead of a new process. */
	replayed?: boolean;
}

const GUARD = path.join(PACKAGE_ROOT, "guard", "guard.ts");

function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/") && fs.existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	const exe = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(exe)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function summarizeTool(name: string, args: Record<string, unknown>): string {
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

export async function runAgent(o: RunAgentOptions): Promise<RunAgentResult> {
	ensureDir(o.workDir);
	const safe = o.label.replace(/[^\w.-]+/g, "_");
	const promptFile = path.join(o.workDir, `${safe}.system.md`);
	const taskFile = path.join(o.workDir, `${safe}.task.md`);
	const transcript = path.join(o.workDir, `${safe}.jsonl`);
	fs.writeFileSync(promptFile, o.agent.systemPrompt, "utf-8");
	fs.writeFileSync(taskFile, o.task, "utf-8");

	const args = ["--mode", "json", "-p", "--no-session", "--model", o.model.model];
	if (o.model.thinking) args.push("--thinking", o.model.thinking);
	if (o.agent.tools.length) args.push("--tools", o.agent.tools.join(","));
	if (o.isolate) args.push("--no-extensions", "-e", GUARD);
	args.push(...o.extraArgs, "--append-system-prompt", promptFile, `Task:\n${o.task}`);

	const result: RunAgentResult = {
		ok: false,
		output: "",
		costUsd: 0,
		turns: 0,
		model: o.model.model,
		budgetExceeded: false,
		aborted: false,
		transcript,
	};
	const out = fs.createWriteStream(transcript);
	let stderr = "";

	const code = await new Promise<number>((resolve) => {
		const inv = piInvocation(args);
		const proc = spawn(inv.command, inv.args, {
			cwd: o.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, MINIDEV_CHILD: "1", MINIDEV_WORKTREE: o.cwd },
		});
		o.onEvent?.({ type: "started", pid: proc.pid ?? 0 });
		let buf = "";
		const kill = () => {
			proc.kill("SIGTERM");
			setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 5000).unref();
		};
		const onLine = (line: string) => {
			if (!line.trim()) return;
			out.write(`${line}\n`);
			let ev: any;
			try {
				ev = JSON.parse(line);
			} catch {
				return;
			}
			if (ev.type === "tool_execution_start") {
				o.onEvent?.({ type: "tool", name: ev.toolName, summary: summarizeTool(ev.toolName, ev.args ?? {}) });
			} else if (ev.type === "auto_retry_start") {
				o.onEvent?.({ type: "retry", message: `retry ${ev.attempt}/${ev.maxAttempts}: ${ev.errorMessage}` });
			} else if (ev.type === "message_end" && ev.message?.role === "assistant") {
				const msg = ev.message;
				result.turns++;
				result.costUsd += msg.usage?.cost?.total ?? 0;
				if (msg.model) result.model = `${msg.provider ?? ""}/${msg.model}`.replace(/^\//, "");
				result.stopReason = msg.stopReason;
				if (msg.errorMessage) result.error = msg.errorMessage;
				const text = (msg.content ?? [])
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n")
					.trim();
				if (text) {
					result.output = text;
					o.onEvent?.({ type: "text", text });
				}
				o.onEvent?.({ type: "usage", costUsd: result.costUsd, turns: result.turns, model: result.model });
				if (result.costUsd >= o.maxUsd) {
					result.budgetExceeded = true;
					kill();
				}
			}
		};
		proc.stdout.on("data", (d: Buffer) => {
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const l of lines) onLine(l);
		});
		proc.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		proc.on("close", (c) => {
			if (buf.trim()) onLine(buf);
			resolve(c ?? 0);
		});
		proc.on("error", (err) => {
			stderr += String(err);
			resolve(1);
		});
		if (o.signal) {
			const onAbort = () => {
				result.aborted = true;
				kill();
			};
			if (o.signal.aborted) onAbort();
			else o.signal.addEventListener("abort", onAbort, { once: true });
		}
	});
	out.end();

	result.ok =
		code === 0 &&
		!result.budgetExceeded &&
		!result.aborted &&
		result.stopReason !== "error" &&
		result.stopReason !== "aborted";
	if (!result.ok && !result.error) {
		result.error = result.budgetExceeded
			? `budget exceeded (${result.costUsd.toFixed(4)} ≥ ${o.maxUsd.toFixed(4)})`
			: result.aborted
				? "aborted"
				: stderr.trim().slice(-2000) || `exit code ${code}`;
	}
	return result;
}
