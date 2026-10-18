import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { type RunState, type Stage } from "./state.ts";
import { fmtUsd } from "./util.ts";
import {
	collapseActivity,
	pushActivity,
	renderDetail,
	renderWidget,
	MAX_ACTIVITY,
	MAX_LOG,
	type ActivityEntry,
	type ActivityKind,
	type DashboardView,
	type LiveAgent,
} from "./ui-model.ts";

const WIDGET = "minidev";
const MAX_VISIBLE = 22;

/** Scrollable overlay showing the full run details and activity log. */
class DetailOverlay implements Component {
	private offset = 0;
	private timer: NodeJS.Timeout;
	private tui: TUI;
	private theme: Theme;
	private getView: () => DashboardView;
	private done: () => void;

	constructor(tui: TUI, theme: Theme, getView: () => DashboardView, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.getView = getView;
		this.done = done;
		this.timer = setInterval(() => this.tui.requestRender(), 1000);
		this.timer.unref();
	}

	dispose(): void {
		clearInterval(this.timer);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const total = renderDetail(this.getView(), this.theme).length;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.done();
			return;
		}
		if (matchesKey(data, "up")) this.offset -= 1;
		else if (matchesKey(data, "down")) this.offset += 1;
		else if (matchesKey(data, "pageUp")) this.offset -= MAX_VISIBLE;
		else if (matchesKey(data, "pageDown")) this.offset += MAX_VISIBLE;
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, total - MAX_VISIBLE)));
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return renderDetail(this.getView(), this.theme)
			.map((line) => truncateToWidth(line, width))
			.slice(this.offset, this.offset + MAX_VISIBLE);
	}
}

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
	private attached = false;
	private ctx: ExtensionContext;

	constructor(ctx: ExtensionContext) {
		this.ctx = ctx;
	}

	get isVisible(): boolean {
		return this.visible;
	}

	/** True while a run is attached (i.e. the panel can still be shown). */
	get isAttached(): boolean {
		return this.attached;
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
		this.attached = true;
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

	/** Remove the widget and status and forget the run — unlike hide(), it cannot be shown again. */
	dismiss(): void {
		this.attached = false;
		this.visible = false;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.agent = undefined;
		this.activity = [];
		this.log = [];
		this.note = "";
		this.waitingSince = undefined;
		// Keep state so an already-open details overlay can finish rendering.
		this.tui = undefined;
		if (this.ctx.hasUI) {
			this.ctx.ui.setWidget(WIDGET, undefined);
			this.ctx.ui.setStatus(WIDGET, undefined);
		}
	}

	show(): void {
		if (!this.isAttached) return;
		this.visible = true;
		this.mount();
		this.refresh();
	}

	toggle(): boolean {
		if (!this.isAttached) return this.visible;
		if (this.visible) this.hide();
		else this.show();
		return this.visible;
	}

	async openDetails(): Promise<void> {
		if (!this.isAttached || !this.ctx.hasUI) return;
		await this.ctx.ui.custom<void>((tui, theme, _kb, done) => new DetailOverlay(tui, theme, () => this.view(), done), {
			overlay: true,
			overlayOptions: { anchor: "center", width: "80%", minWidth: 60, maxHeight: 26 },
		});
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
