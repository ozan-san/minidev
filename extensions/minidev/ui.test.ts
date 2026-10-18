import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { RunState } from "./state.ts";

// ui.ts only needs these two helpers from pi-tui at runtime; stub them so the
// Dashboard can be tested without the host terminal packages installed.
const piTuiStub = `data:text/javascript,${encodeURIComponent(
	"export const matchesKey = (data, key) => data === key; export const truncateToWidth = (text, width) => (text.length > width ? text.slice(0, width) : text);",
)}`;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-tui") return { url: piTuiStub, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});

const { Dashboard } = await import("./ui.ts");

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const tui = { requestRender: () => {} } as unknown as TUI;

const visibleWidth = (text: string): number => text.replace(/\u001b\[[0-9;]*m/g, "").length;

function makeState(over: Partial<RunState> = {}): RunState {
	return {
		version: 1,
		key: "MD-1",
		title: "Better UI",
		ticket: { key: "MD-1", title: "Better UI", body: "", source: "s" },
		repoRoot: "/repo",
		repoName: "repo",
		runDir: "/repo/.minidev/runs/repo/MD-1",
		stage: "pr",
		completed: ["workspace", "detect", "scout", "plan", "build", "test", "review", "pr"],
		status: "done",
		budgetUsd: 10,
		costUsd: 1,
		subtasks: [],
		agentRuns: [],
		checks: [],
		reviewRounds: 0,
		fixRounds: 0,
		createdAt: 1,
		updatedAt: 1,
		...over,
	};
}

describe("Dashboard dismissal", () => {
	test("an already-open details overlay still renders after dismiss", async () => {
		let overlay: Component | undefined;
		let customCalls = 0;
		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: {
				setWidget: () => {},
				setStatus: () => {},
				custom: async (factory: (tui: TUI, theme: Theme, kb: unknown, done: () => void) => Component) => {
					customCalls += 1;
					overlay = factory(tui, theme, undefined, () => {});
				},
			},
		} as unknown as ExtensionContext;

		const dash = new Dashboard(ctx);
		assert.equal(dash.isAttached, false);

		dash.attach(makeState());
		assert.equal(dash.isAttached, true);

		await dash.openDetails();
		const open = overlay;
		assert.ok(open);
		assert.equal(customCalls, 1);

		dash.dismiss();
		assert.equal(dash.isAttached, false);
		assert.equal(dash.isVisible, false);

		const handleInput = open.handleInput?.bind(open);
		assert.ok(handleInput);
		assert.doesNotThrow(() => open.render(80));
		const overlayLines = open.render(80);
		assert.ok(overlayLines.length > 0);
		for (const line of overlayLines) {
			assert.ok(visibleWidth(line) <= 80, `overlay line wider than 80: ${JSON.stringify(line)}`);
		}
		assert.doesNotThrow(() => handleInput("up"));

		// A dismissed panel cannot be resurrected or opened again.
		dash.show();
		assert.equal(dash.isVisible, false);
		assert.equal(dash.toggle(), false);
		await dash.openDetails();
		assert.equal(customCalls, 1);
	});
});

describe("Dashboard widget", () => {
	test("renders framed lines that fit the terminal width", () => {
		let widget: Component | undefined;
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				setWidget: (_key: string, factory?: (tui: TUI, theme: Theme) => Component) => {
					if (factory) widget = factory(tui, theme);
				},
				setStatus: () => {},
				custom: async () => {},
			},
		} as unknown as ExtensionContext;

		const dash = new Dashboard(ctx);
		dash.attach(makeState());
		assert.ok(widget);
		const lines = widget.render(72);
		assert.ok(lines.length > 0);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= 72, `widget line wider than 72: ${JSON.stringify(line)}`);
		}
		dash.dismiss();
	});
});

describe("Dashboard lifecycle", () => {
	function makeCtx() {
		const setWidget: Array<((tui: TUI, theme: Theme) => Component) | undefined> = [];
		const setStatus: Array<string | undefined> = [];
		let widget: Component | undefined;
		let customCalls = 0;
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				setWidget: (_key: string, factory?: (tui: TUI, theme: Theme) => Component) => {
					setWidget.push(factory);
					if (factory) widget = factory(tui, theme);
				},
				setStatus: (_key: string, value?: string) => {
					setStatus.push(value);
				},
				custom: async () => {
					customCalls += 1;
				},
			},
		} as unknown as ExtensionContext;
		return { ctx, setWidget, setStatus, widget: () => widget, customCalls: () => customCalls };
	}

	test("hide() then show() re-registers exactly one widget", () => {
		const h = makeCtx();
		const dash = new Dashboard(h.ctx);
		dash.attach(makeState());
		assert.equal(h.setWidget.length, 1);
		assert.equal(typeof h.setWidget[0], "function");

		dash.hide();
		assert.equal(dash.isVisible, false);
		assert.equal(h.setWidget.at(-1), undefined);

		const before = h.setWidget.length;
		dash.show();
		assert.equal(dash.isVisible, true);
		assert.equal(h.setWidget.length, before + 1);
		assert.equal(typeof h.setWidget.at(-1), "function");
		assert.ok(h.widget());
		dash.dismiss();
	});

	test("dismiss() clears widget and status and cannot be resurrected", async () => {
		const h = makeCtx();
		const dash = new Dashboard(h.ctx);
		dash.attach(makeState());

		dash.dismiss();
		assert.equal(dash.isAttached, false);
		assert.equal(dash.isVisible, false);
		assert.equal(h.setWidget.at(-1), undefined);
		assert.deepEqual(h.setStatus, [undefined]);

		const widgets = h.setWidget.length;
		const statuses = h.setStatus.length;
		dash.show();
		assert.equal(h.setWidget.length, widgets);
		assert.equal(h.setStatus.length, statuses);
		assert.equal(dash.toggle(), false);
		assert.equal(h.setWidget.length, widgets);
		await dash.openDetails();
		assert.equal(h.customCalls(), 0);
	});
});
