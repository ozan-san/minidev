import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
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

export function renderWidget(v: DashboardView, th: Theme): string[] {
	const s = v.state;
	const out: string[] = [];
	const statusColor =
		s.status === "failed" ? "error" : s.status === "paused" ? "warning" : s.status === "done" ? "success" : "accent";

	out.push(
		`${th.fg("accent", th.bold("minidev"))} ${th.fg("toolTitle", s.key)} ${th.fg("muted", s.title)}${s.stack ? th.fg("dim", ` [${s.stack.label}]`) : ""}  ${th.fg(statusColor, s.status)}${s.pauseReason ? th.fg("warning", ` (${s.pauseReason})`) : ""}`,
	);

	const pipeline = pipelineChips(s)
		.map(({ stage, status }) => {
			if (status === "done") return th.fg("success", `✓ ${stage}`);
			if (status === "failed") return th.fg("error", `✗ ${stage}`);
			if (status === "paused") return th.fg("warning", `⏸ ${stage}`);
			if (status === "active") return th.fg("accent", `⏳ ${stage}`);
			return th.fg("dim", `· ${stage}`);
		})
		.join(th.fg("dim", "  "));
	out.push(pipeline);

	if (s.subtasks.length && (s.stage === "build" || s.completed.includes("build"))) {
		const done = s.subtasks.filter((t) => t.status === "done").length;
		const chips = s.subtasks
			.map((t) =>
				t.status === "done"
					? th.fg("success", t.id)
					: t.status === "running"
						? th.fg("accent", `[${t.id}]`)
						: t.status === "failed"
							? th.fg("error", t.id)
							: th.fg("dim", t.id),
			)
			.join(" ");
		out.push(`${th.fg("muted", `subtasks ${done}/${s.subtasks.length}`)} ${chips}`);
	}

	const ratio = s.costUsd / Math.max(s.budgetUsd, 0.0001);
	const pct = Math.round(ratio * 100);
	const level = budgetLevel(s.costUsd, s.budgetUsd);
	const costColor = level === "ok" ? "toolOutput" : level === "warn" ? "warning" : "error";
	out.push(
		`${th.fg("muted", "cost")} ${th.fg(costColor, `${progressBar(ratio, 10)} ${fmtUsd(s.costUsd)} / ${fmtUsd(s.budgetUsd)} (${pct}%)`)}`,
	);

	const last = v.activity[v.activity.length - 1];
	if (v.agent) {
		const a = v.agent;
		out.push(
			`${th.fg("accent", "▶")} ${th.fg("toolTitle", a.label)} ${th.fg("dim", `${a.role} ${a.model}`)} ${th.fg("muted", `${a.turns} turns · ${fmtUsd(a.costUsd)} · ${fmtDuration(v.now - a.startedAt)}`)}`,
		);
		if (last) out.push(th.fg("dim", `   ↳ ${last.text}`));
	} else if (s.status === "running" && v.waitingSince) {
		out.push(th.fg("warning", v.note));
	} else if (s.status === "running") {
		out.push(`${th.fg("accent", "▶")} ${th.fg("muted", `${v.note || s.stage} · ${fmtDuration(v.now - v.startedStage)}`)}`);
	}

	const icons: Record<ActivityKind, string> = {
		tool: "",
		text: "» ",
		retry: "↻ ",
		check: "",
		commit: "● ",
		info: "",
	};
	for (const e of v.activity.slice(-MAX_ACTIVITY)) {
		out.push(`  ${th.fg("dim", icons[e.kind] + e.text)}`);
	}

	if (v.log.length > v.activity.length) {
		out.push(th.fg("dim", `  … ${v.log.length - v.activity.length} earlier · /minidev ui details`));
	}

	if (s.prUrl) out.push(`${th.fg("success", "PR")} ${s.prUrl}`);
	return out;
}

export function renderDetail(v: DashboardView, th: Theme): string[] {
	const s = v.state;
	const out: string[] = [];
	const statusColor =
		s.status === "failed" ? "error" : s.status === "paused" ? "warning" : s.status === "done" ? "success" : "accent";

	out.push(
		`${th.fg("accent", th.bold(`minidev ${s.key}`))} ${th.fg("muted", s.title)}${s.stack ? th.fg("dim", ` [${s.stack.label}]`) : ""}`,
	);
	out.push(
		`${th.fg(statusColor, s.status)} ${th.fg("dim", "@")} ${th.fg("toolTitle", s.stage)}${s.pauseReason ? th.fg("warning", ` (${s.pauseReason})`) : ""}${s.error ? th.fg("error", ` — ${s.error.split("\n")[0]}`) : ""}`,
	);

	const pipeline = pipelineChips(s)
		.map(({ stage, status }) => {
			if (status === "done") return th.fg("success", `✓ ${stage}`);
			if (status === "failed") return th.fg("error", `✗ ${stage}`);
			if (status === "paused") return th.fg("warning", `⏸ ${stage}`);
			if (status === "active") return th.fg("accent", `⏳ ${stage}`);
			return th.fg("dim", `· ${stage}`);
		})
		.join(th.fg("dim", "  "));
	out.push(pipeline);

	const ratio = s.costUsd / Math.max(s.budgetUsd, 0.0001);
	const pct = Math.round(ratio * 100);
	const level = budgetLevel(s.costUsd, s.budgetUsd);
	const costColor = level === "ok" ? "toolOutput" : level === "warn" ? "warning" : "error";
	out.push(
		`${th.fg("muted", "cost")} ${th.fg(costColor, `${progressBar(ratio, 10)} ${fmtUsd(s.costUsd)} / ${fmtUsd(s.budgetUsd)} (${pct}%)`)}`,
	);

	if (s.subtasks.length) {
		const done = s.subtasks.filter((t) => t.status === "done").length;
		out.push("", `${th.fg("muted", `Subtasks ${done}/${s.subtasks.length}`)}`);
		for (const t of s.subtasks) {
			const color: ThemeColor =
				t.status === "done"
					? "success"
					: t.status === "running"
						? "accent"
						: t.status === "failed"
							? "error"
							: "dim";
			const icon = t.status === "done" ? "✓" : t.status === "running" ? "▶" : t.status === "failed" ? "✗" : "·";
			out.push(`  ${th.fg(color, icon)} ${t.id} ${t.title} · ${t.attempts} attempts${t.commit ? ` · ${t.commit}` : ""}`);
		}
	}

	out.push("", `${th.fg("muted", `Agents (${s.agentRuns.length + (v.agent ? 1 : 0)})`)}`);
	for (const run of s.agentRuns) {
		out.push(`  ${th.fg(run.ok ? "success" : "error", agentSummary(run, v.now))}`);
	}
	if (v.agent) {
		out.push(
			`${th.fg("accent", "▶")} ${th.fg("toolTitle", `${v.agent.role} ${v.agent.label}`)} ${th.fg("muted", `${v.agent.turns} turns · ${fmtUsd(v.agent.costUsd)} · ${fmtDuration(v.now - v.agent.startedAt)}`)}`,
		);
	}
	if (!s.agentRuns.length && !v.agent) out.push(th.fg("dim", "  (none yet)"));

	if (s.checks.length) {
		out.push(`${th.fg("muted", "Checks")}`);
		for (const r of s.checks) {
			const color: ThemeColor = r.skipped ? "dim" : r.ok ? "success" : "error";
			out.push(
				`  ${th.fg(color, `${r.ok ? "✓" : "✗"} ${r.name}${r.skipped ? " (skipped)" : ""} · ${fmtDuration(r.durationMs)}`)}`,
			);
		}
	}

	out.push("", `${th.fg("muted", `Activity (${v.log.length})`)}`);
	for (const e of v.log.slice(-200)) {
		let color: ThemeColor = "dim";
		let icon = "";
		switch (e.kind) {
			case "text":
				color = "toolOutput";
				icon = "» ";
				break;
			case "retry":
				color = "warning";
				icon = "↻ ";
				break;
			case "check":
				color = "toolOutput";
				icon = e.text.includes("✗") ? "✗ " : "✓ ";
				break;
			case "commit":
				color = "accent";
				icon = "● ";
				break;
			case "tool":
			case "info":
				break;
		}
		out.push(`  ${th.fg(color, icon + e.text)}`);
	}

	out.push("", `${th.fg("muted", "Artifacts")}`);
	if (s.worktree) out.push(`  ${th.fg("dim", s.worktree)}`);
	if (s.runDir) out.push(`  ${th.fg("dim", s.runDir)}`);
	if (s.prUrl) out.push(`  ${th.fg("dim", s.prUrl)}`);

	out.push("", th.fg("dim", "esc close · ↑/↓ line · pgUp/pgDn page"));
	return out;
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
