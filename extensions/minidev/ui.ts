import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { type RunState, type Stage } from "./state.ts";
import { fmtUsd } from "./util.ts";
import {
	collapseActivity,
	pushActivity,
	renderWidget,
	MAX_ACTIVITY,
	MAX_LOG,
	type ActivityEntry,
	type ActivityKind,
	type DashboardView,
	type LiveAgent,
} from "./ui-model.ts";

const WIDGET = "minidev";

/** Persistent dashboard above the editor + footer status. */
export class Dashboard {
	private tui?: TUI;
	private state?: RunState;
	private agent?: LiveAgent;
	private activity: ActivityEntry[] = [];
	private log: ActivityEntry[] = [];
	private note = "";
	private startedStage = Date.now();
	private timer?: NodeJS.Timeout;
	private waitingSince?: number;
	private visible = true;

	constructor(private ctx: ExtensionContext) {}

	get isVisible(): boolean {
		return this.visible;
	}

	private mount(): void {
		if (this.ctx.mode !== "tui") return;
		this.ctx.ui.setWidget(WIDGET, (tui: TUI, theme: Theme) => {
			this.tui = tui;
			return {
				render: (width: number) => this.render(width, theme),
				invalidate: () => {},
			};
		});
		if (!this.timer) {
			// Tick for elapsed timers.
			this.timer = setInterval(() => this.refresh(), 1000);
			this.timer.unref();
		}
	}

	private unmount(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		if (this.ctx.mode === "tui") this.ctx.ui.setWidget(WIDGET, undefined);
	}

	attach(state: RunState): void {
		this.state = state;
		this.activity = [];
		this.log = [];
		this.note = "";
		this.startedStage = Date.now();
		this.visible = true;
		this.mount();
	}

	detach(keepSummary = true): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.agent = undefined;
		if (!keepSummary) this.hide();
		else this.refresh();
	}

	hide(): void {
		this.visible = false;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		if (this.ctx.hasUI) {
			this.ctx.ui.setWidget(WIDGET, undefined);
			this.ctx.ui.setStatus(WIDGET, undefined);
		}
	}

	show(): void {
		if (!this.state) return;
		this.visible = true;
		this.mount();
		this.refresh();
	}

	toggle(): boolean {
		if (this.visible) this.hide();
		else this.show();
		return this.visible;
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

	push(text: string, kind: ActivityKind = "info"): void {
		const collapsed = collapseActivity(text);
		if (!collapsed) return;
		const entry: ActivityEntry = { kind, text: collapsed, agent: this.agent?.label };
		this.activity = pushActivity(this.activity, entry, MAX_ACTIVITY);
		this.log = pushActivity(this.log, entry, MAX_LOG);
		this.refresh();
	}

	private view(): DashboardView {
		return {
			state: this.state as RunState,
			agent: this.agent,
			activity: this.activity,
			log: this.log,
			note: this.note,
			startedStage: this.startedStage,
			waitingSince: this.waitingSince,
			now: Date.now(),
		};
	}

	refresh(): void {
		const s = this.state;
		if (this.visible && s && this.ctx.hasUI) {
			const pct = s.budgetUsd > 0 ? Math.round((s.costUsd / s.budgetUsd) * 100) : 0;
			this.ctx.ui.setStatus(WIDGET, `minidev ${s.key} · ${s.stage} · ${fmtUsd(s.costUsd)}/${fmtUsd(s.budgetUsd)} (${pct}%)`);
		}
		if (this.visible) this.tui?.requestRender();
	}

	private render(width: number, th: Theme): string[] {
		return renderWidget(this.view(), th).map((line) => truncateToWidth(line, width));
	}
}
