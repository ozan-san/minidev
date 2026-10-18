import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
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

const WIDGET = "minidev";
const MAX_ACTIVITY = 6;

/** Persistent dashboard above the editor + footer status. */
export class Dashboard {
	private tui?: TUI;
	private state?: RunState;
	private agent?: LiveAgent;
	private activity: string[] = [];
	private note = "";
	private startedStage = Date.now();
	private timer?: NodeJS.Timeout;
	private waitingSince?: number;

	constructor(private ctx: ExtensionContext) {}

	attach(state: RunState): void {
		this.state = state;
		if (this.ctx.mode !== "tui") return;
		this.ctx.ui.setWidget(WIDGET, (tui: TUI, theme: Theme) => {
			this.tui = tui;
			return {
				render: (width: number) => this.render(width, theme),
				invalidate: () => {},
			};
		});
		// Tick for elapsed timers.
		this.timer = setInterval(() => this.refresh(), 1000);
		this.timer.unref();
	}

	detach(keepSummary = true): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.agent = undefined;
		if (!keepSummary) this.ctx.ui.setWidget(WIDGET, undefined);
		this.refresh();
	}

	stage(_stage: Stage): void {
		this.waitingSince = undefined;
		this.startedStage = Date.now();
		this.note = "";
		this.activity = [];
		this.refresh();
	}

	/** Blocked on a user decision. */
	waiting(what: string): void {
		this.activity = [];
		this.note = `⏸ waiting for you: ${what.split("\n")[0]}`;
		this.waitingSince = Date.now();
		this.refresh();
	}

	setNote(note: string): void {
		this.waitingSince = undefined;
		this.note = note;
		this.refresh();
	}

	agentStart(a: LiveAgent): void {
		this.waitingSince = undefined;
		this.agent = a;
		this.activity = [];
		this.refresh();
	}

	agentUpdate(patch: Partial<LiveAgent>): void {
		if (this.agent) Object.assign(this.agent, patch);
		this.refresh();
	}

	agentEnd(): void {
		this.agent = undefined;
		this.refresh();
	}

	push(line: string): void {
		this.activity.push(line.replace(/\s+/g, " ").trim());
		if (this.activity.length > MAX_ACTIVITY) this.activity.shift();
		this.refresh();
	}

	refresh(): void {
		const s = this.state;
		if (s && this.ctx.hasUI) {
			const pct = s.budgetUsd > 0 ? Math.round((s.costUsd / s.budgetUsd) * 100) : 0;
			this.ctx.ui.setStatus(WIDGET, `minidev ${s.key} · ${s.stage} · ${fmtUsd(s.costUsd)}/${fmtUsd(s.budgetUsd)} (${pct}%)`);
		}
		this.tui?.requestRender();
	}

	private render(width: number, th: Theme): string[] {
		const s = this.state;
		if (!s) return [];
		const out: string[] = [];
		const line = (t: string) => out.push(truncateToWidth(t, width));
		const statusColor = s.status === "failed" ? "error" : s.status === "paused" ? "warning" : s.status === "done" ? "success" : "accent";

		line(
			`${th.fg("accent", th.bold("minidev"))} ${th.fg("toolTitle", s.key)} ${th.fg("muted", s.title)}${s.stack ? th.fg("dim", ` [${s.stack.label}]`) : ""}  ${th.fg(statusColor, s.status)}${s.pauseReason ? th.fg("warning", ` (${s.pauseReason})`) : ""}`,
		);

		const pipeline = STAGES.map((st) => {
			if (s.completed.includes(st)) return th.fg("success", `✓ ${st}`);
			if (st === s.stage) {
				const icon = s.status === "running" ? "⏳" : s.status === "failed" ? "✗" : "⏸";
				return th.fg(s.status === "failed" ? "error" : "accent", `${icon} ${st}`);
			}
			return th.fg("dim", `· ${st}`);
		}).join(th.fg("dim", "  "));
		line(pipeline);

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
			line(`${th.fg("muted", `subtasks ${done}/${s.subtasks.length}`)} ${chips}`);
		}

		const budget = `${fmtUsd(s.costUsd)} / ${fmtUsd(s.budgetUsd)}`;
		const over = s.costUsd / Math.max(s.budgetUsd, 0.0001);
		line(`${th.fg("muted", "cost")} ${th.fg(over >= 1 ? "error" : over >= 0.8 ? "warning" : "toolOutput", budget)}`);

		if (this.agent) {
			const a = this.agent;
			line(
				`${th.fg("accent", "▶")} ${th.fg("toolTitle", a.label)} ${th.fg("dim", a.model)} ${th.fg("muted", `${a.turns} turns · ${fmtUsd(a.costUsd)} · ${fmtDuration(Date.now() - a.startedAt)}`)}`,
			);
		} else if (s.status === "running" && this.waitingSince) {
			line(th.fg("warning", this.note));
		} else if (s.status === "running") {
			line(`${th.fg("accent", "▶")} ${th.fg("muted", `${this.note || s.stage} · ${fmtDuration(Date.now() - this.startedStage)}`)}`);
		}
		for (const a of this.activity) line(`  ${th.fg("dim", a)}`);
		if (s.prUrl) line(`${th.fg("success", "PR")} ${s.prUrl}`);
		return out;
	}
}
