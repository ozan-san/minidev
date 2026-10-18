import { STAGES, type RunState, type Stage } from "./state.ts";
import { fmtDuration, fmtUsd } from "./util.ts";

export interface LiveAgent {
	role: string;
	label: string;
	model: string;
	costUsd: number;
	turns: number;
	startedAt: number;
}

export type ActivityKind = "tool" | "text" | "retry" | "info" | "check" | "commit";

export interface ActivityEntry {
	kind: ActivityKind;
	text: string;
	agent?: string;
}

export const MAX_ACTIVITY = 6;
export const MAX_LOG = 300;

export interface DashboardView {
	state: RunState;
	agent?: LiveAgent;
	activity: ActivityEntry[];
	log: ActivityEntry[];
	note: string;
	startedStage: number;
	waitingSince?: number;
	now: number;
}

export function collapseActivity(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function pushActivity(list: ActivityEntry[], entry: ActivityEntry, max = MAX_LOG): ActivityEntry[] {
	const next = [...list, entry];
	return next.length > max ? next.slice(next.length - max) : next;
}

export function pipelineChips(
	state: RunState,
): Array<{ stage: Stage; status: "done" | "active" | "pending" | "failed" | "paused" }> {
	return STAGES.map((stage) => {
		if (state.completed.includes(stage)) return { stage, status: "done" as const };
		if (stage === state.stage) {
			if (state.status === "failed") return { stage, status: "failed" as const };
			if (state.status === "paused") return { stage, status: "paused" as const };
			return { stage, status: "active" as const };
		}
		return { stage, status: "pending" as const };
	});
}

export function budgetLevel(costUsd: number, budgetUsd: number): "ok" | "warn" | "over" {
	const ratio = costUsd / Math.max(budgetUsd, 0.0001);
	if (ratio >= 1) return "over";
	if (ratio >= 0.8) return "warn";
	return "ok";
}

export function progressBar(fraction: number, width: number): string {
	const clamped = Math.min(1, Math.max(0, fraction));
	const filled = Math.round(clamped * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

export function agentSummary(
	run: {
		role: string;
		label: string;
		model: string;
		costUsd: number;
		turns: number;
		ok: boolean;
		startedAt: number;
		endedAt?: number;
	},
	now: number,
): string {
	return `${run.role} ${run.label} · ${run.turns} turns · ${fmtUsd(run.costUsd)} · ${fmtDuration((run.endedAt ?? now) - run.startedAt)}${run.ok ? " ✓" : " ✗"}`;
}
