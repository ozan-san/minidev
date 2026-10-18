import * as fs from "node:fs";
import * as path from "node:path";
import type { Role, RoleModel } from "./config.ts";
import type { ScoutCommands, StackInfo } from "./stack.ts";
import type { Ticket } from "./ticket.ts";
import { ensureDir, writeFile } from "./util.ts";

export const STAGES = ["workspace", "detect", "scout", "plan", "build", "test", "review", "pr"] as const;
export type Stage = (typeof STAGES)[number];

export interface Subtask {
	id: string;
	title: string;
	goal: string;
	files?: string[];
	steps?: string[];
	acceptance?: string[];
	status: "pending" | "running" | "done" | "failed";
	attempts: number;
	commit?: string;
	summary?: string;
}

export interface PlanJson {
	summary: string;
	type?: string;
	branchSlug?: string;
	prTitle?: string;
	subtasks: Array<Omit<Subtask, "status" | "attempts">>;
	testPlan?: { unitTests?: string[]; manualChecks?: string[] };
	risks?: string[];
}

export interface AgentRun {
	role: Role;
	label: string;
	model: string;
	costUsd: number;
	turns: number;
	ok: boolean;
	startedAt: number;
	endedAt?: number;
	transcript: string;
}

export interface CheckRecord {
	name: string;
	ok: boolean;
	skipped?: boolean;
	blocking: boolean;
	durationMs: number;
	logPath?: string;
}

export interface Review {
	verdict: "approve" | "changes";
	summary: string;
	mustFix: Array<{ file?: string; issue: string; fix?: string }>;
	suggestions?: string[];
}

export type RunStatus = "running" | "paused" | "failed" | "done";

export interface RunState {
	version: 1;
	key: string;
	title: string;
	ticket: Ticket;
	repoRoot: string;
	repoName: string;
	runDir: string;
	worktree?: string;
	branch?: string;
	/** Base branch name, e.g. "main". */
	base?: string;
	/** Ref the branch was cut from / diffed against, e.g. "origin/main". */
	baseRef?: string;
	/** Detected project mode (set in the detect stage). */
	stack?: StackInfo;
	/** Commands proposed by the scout. */
	scoutCommands?: ScoutCommands;
	stage: Stage;
	completed: Stage[];
	status: RunStatus;
	pauseReason?: string;
	error?: string;
	budgetUsd: number;
	costUsd: number;
	plan?: PlanJson;
	planApproved?: boolean;
	prApproved?: boolean;
	/** Per-run model overrides (set via /minidev models → "this run only"). */
	modelOverrides?: Partial<Record<Role, RoleModel>>;
	subtasks: Subtask[];
	agentRuns: AgentRun[];
	checks: CheckRecord[];
	review?: Review;
	reviewRounds: number;
	fixRounds: number;
	prUrl?: string;
	pushed?: boolean;
	createdAt: number;
	updatedAt: number;
}

export function runDirFor(runsDir: string, repoName: string, key: string): string {
	return path.join(runsDir, repoName, key);
}

export function saveState(state: RunState): void {
	state.updatedAt = Date.now();
	writeFile(path.join(state.runDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

export function loadState(runDir: string): RunState | undefined {
	try {
		return JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf-8")) as RunState;
	} catch {
		return undefined;
	}
}

export function listRuns(runsDir: string, repoName: string): RunState[] {
	const dir = path.join(runsDir, repoName);
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.map((k) => loadState(path.join(dir, k)))
		.filter((s): s is RunState => !!s)
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function artifact(state: RunState, name: string): string {
	return path.join(ensureDir(state.runDir), name);
}
