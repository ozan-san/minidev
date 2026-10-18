import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_ACTIVITY,
	STAGE_COLORS,
	agentSummary,
	budgetLevel,
	collapseActivity,
	frameLines,
	pipelineChips,
	progressBar,
	pushActivity,
	renderDetail,
	renderWidget,
	shouldDismissPanel,
	textWidth,
	truncateVisible,
	type ActivityEntry,
	type DashboardView,
} from "./ui-model.ts";
import type { UiDismiss } from "./config.ts";
import { STAGES, type RunStatus } from "./state.ts";

type RunState = Parameters<typeof renderWidget>[0]["state"];
type Theme = Parameters<typeof renderWidget>[1];
type AgentRun = RunState["agentRuns"][number];

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

/** Theme stub that records every (token, text) pair so tests can inspect coloring. */
function recordingTheme(): { theme: Theme; calls: Array<{ token: string; text: string }> } {
	const calls: Array<{ token: string; text: string }> = [];
	const rec = {
		fg: (token: string, text: string) => {
			calls.push({ token, text });
			return text;
		},
		bold: (text: string) => text,
	} as unknown as Theme;
	return { theme: rec, calls };
}

/** Token used to color the top border drawn by frameLines. */
function borderToken(calls: Array<{ token: string; text: string }>): string | undefined {
	return calls.find((c) => c.text.startsWith("╭"))?.token;
}

function makeState(over: Partial<RunState> = {}): RunState {
	return {
		version: 1,
		key: "MD-1",
		title: "Better UI",
		ticket: { key: "MD-1", title: "Better UI", body: "", source: "s" },
		repoRoot: "/repo",
		repoName: "repo",
		runDir: "/repo/.minidev/runs/repo/MD-1",
		stage: "workspace",
		completed: [],
		status: "running",
		budgetUsd: 10,
		costUsd: 0,
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

function makeView(over: Partial<DashboardView> = {}): DashboardView {
	return {
		state: makeState(),
		activity: [],
		log: [],
		note: "",
		startedStage: 0,
		now: 1000,
		...over,
	};
}

function makeAgentRun(over: Partial<AgentRun> = {}): AgentRun {
	return {
		role: "builder",
		label: "builder-1",
		model: "sonnet",
		costUsd: 0.5,
		turns: 3,
		ok: true,
		startedAt: 1000,
		endedAt: 6000,
		transcript: "",
		...over,
	};
}

describe("collapseActivity", () => {
	test("collapses internal whitespace and newlines and trims", () => {
		assert.equal(collapseActivity("  hello   world\n\tagain  "), "hello world again");
	});

	test("returns an empty string for blank input", () => {
		assert.equal(collapseActivity("   \n\t "), "");
	});
});

describe("pushActivity", () => {
	test("appends entries in order", () => {
		const a: ActivityEntry = { kind: "info", text: "a" };
		const b: ActivityEntry = { kind: "info", text: "b" };
		assert.deepEqual(pushActivity([], a), [a]);
		assert.deepEqual(pushActivity([a], b), [a, b]);
	});

	test("trims to max keeping the newest entries", () => {
		const list: ActivityEntry[] = [
			{ kind: "info", text: "1" },
			{ kind: "info", text: "2" },
		];
		const next = pushActivity(list, { kind: "info", text: "3" }, 2);
		assert.deepEqual(
			next.map((e) => e.text),
			["2", "3"],
		);
	});

	test("does not mutate the input array", () => {
		const list: ActivityEntry[] = [{ kind: "info", text: "1" }];
		pushActivity(list, { kind: "info", text: "2" }, 1);
		assert.deepEqual(
			list.map((e) => e.text),
			["1"],
		);
	});
});

describe("pipelineChips", () => {
	const stages = ["workspace", "detect", "scout", "plan", "build", "test", "review", "pr"] as const;

	test("covers all eight stages in order", () => {
		assert.deepEqual(
			pipelineChips(makeState()).map((c) => c.stage),
			[...stages],
		);
	});

	test("marks completed and current running stages", () => {
		const chips = pipelineChips(makeState({ stage: "plan", completed: ["workspace", "detect"] }));
		const byStage = Object.fromEntries(chips.map((c) => [c.stage, c.status]));
		assert.equal(byStage.workspace, "done");
		assert.equal(byStage.detect, "done");
		assert.equal(byStage.scout, "pending");
		assert.equal(byStage.plan, "active");
		assert.equal(byStage.pr, "pending");
	});

	test("marks the current stage paused", () => {
		const chips = pipelineChips(makeState({ stage: "build", status: "paused" }));
		assert.equal(chips.find((c) => c.stage === "build")?.status, "paused");
	});

	test("marks the current stage failed", () => {
		const chips = pipelineChips(makeState({ stage: "test", status: "failed" }));
		assert.equal(chips.find((c) => c.stage === "test")?.status, "failed");
	});

	test("marks every stage done when the run is complete", () => {
		const chips = pipelineChips(makeState({ stage: "pr", status: "done", completed: [...stages] }));
		assert.ok(chips.every((c) => c.status === "done"));
	});
});

describe("budgetLevel", () => {
	test("classifies ratios below 0.8 as ok", () => {
		assert.equal(budgetLevel(0.5, 1), "ok");
	});

	test("classifies ratios at or above 0.8 as warn", () => {
		assert.equal(budgetLevel(0.8, 1), "warn");
	});

	test("classifies ratios at or above 1 as over", () => {
		assert.equal(budgetLevel(1, 1), "over");
	});
});

describe("shouldDismissPanel", () => {
	const statuses: RunStatus[] = ["running", "paused", "failed", "done"];

	test("with done, only a successful run is dismissed", () => {
		assert.equal(shouldDismissPanel("done", "done"), true);
		assert.equal(shouldDismissPanel("running", "done"), false);
		assert.equal(shouldDismissPanel("paused", "done"), false);
		assert.equal(shouldDismissPanel("failed", "done"), false);
	});

	test("with terminal, every non-running status is dismissed", () => {
		assert.equal(shouldDismissPanel("done", "terminal"), true);
		assert.equal(shouldDismissPanel("paused", "terminal"), true);
		assert.equal(shouldDismissPanel("failed", "terminal"), true);
		assert.equal(shouldDismissPanel("running", "terminal"), false);
	});

	test("with never, no status is dismissed", () => {
		for (const status of statuses) assert.equal(shouldDismissPanel(status, "never"), false);
	});

	test("returns a boolean and is free of side effects", () => {
		const policies: UiDismiss[] = ["done", "terminal", "never"];
		for (const status of statuses) {
			for (const policy of policies) {
				const first = shouldDismissPanel(status, policy);
				assert.equal(typeof first, "boolean");
				assert.equal(shouldDismissPanel(status, policy), first);
			}
		}
	});
});

describe("STAGE_COLORS", () => {
	test("covers every stage in order with eight distinct colors", () => {
		assert.deepEqual(Object.keys(STAGE_COLORS), [...STAGES]);
		const values = Object.values(STAGE_COLORS);
		assert.equal(values.length, 8);
		assert.equal(new Set(values).size, 8);
	});
});

describe("textWidth", () => {
	test("counts the characters of plain text", () => {
		assert.equal(textWidth(""), 0);
		assert.equal(textWidth("hello"), 5);
	});

	test("ignores ANSI SGR escape sequences", () => {
		assert.equal(textWidth("\u001b[31mab\u001b[0m"), 2);
		assert.equal(textWidth("\u001b[1;32mabc\u001b[0m"), 3);
	});
});

describe("truncateVisible", () => {
	test("returns the input unchanged when it fits", () => {
		assert.equal(truncateVisible("hello", 5), "hello");
		assert.equal(truncateVisible("hi", 10), "hi");
		assert.equal(truncateVisible("\u001b[31mab\u001b[0m", 2), "\u001b[31mab\u001b[0m");
	});

	test("clips colored text to the max visible cells and stays reset-terminated", () => {
		const clipped = truncateVisible("\u001b[31mhello\u001b[0m", 3);
		assert.equal(textWidth(clipped), 3);
		assert.ok(clipped.endsWith("\u001b[0m"));
	});

	test("returns an empty string for a non-positive max", () => {
		assert.equal(truncateVisible("hello", 0), "");
		assert.equal(truncateVisible("hello", -1), "");
	});
});

describe("frameLines", () => {
	test("draws a top and bottom rail and side rails on every body line", () => {
		const out = frameLines(["a", "bb"], theme, { color: "border" });
		assert.ok(out[0].startsWith("╭"));
		assert.ok(out.at(-1)!.startsWith("╰"));
		for (const line of out.slice(1, -1)) {
			assert.ok(line.startsWith("│"));
			assert.ok(line.endsWith("│"));
		}
	});

	test("pads every line to the given width", () => {
		const out = frameLines(["a", "bb"], theme, { color: "border", width: 20 });
		for (const line of out) assert.equal(textWidth(line), 20);
	});

	test("hugs the widest content line when no width is given", () => {
		const out = frameLines(["a", "bbb"], theme, { color: "border" });
		// inner = 3, so the whole frame is 3 + 4 cells wide.
		for (const line of out) assert.equal(textWidth(line), 7);
	});

	test("clips content wider than width - 4 instead of wrapping", () => {
		const out = frameLines(["0123456789"], theme, { color: "border", width: 8 });
		assert.equal(out.length, 3);
		for (const line of out) assert.equal(textWidth(line), 8);
		assert.ok(out[1].includes("0123"));
		assert.ok(!out[1].includes("456789"));
	});

	test("tints the frame with the requested color", () => {
		const { theme: rec, calls } = recordingTheme();
		frameLines(["a"], rec, { color: "warning" });
		assert.equal(borderToken(calls), "warning");
	});
});

describe("progressBar", () => {
	test("renders filled and empty cells for a fraction", () => {
		assert.equal(progressBar(0.5, 10), "█████░░░░░");
	});

	test("clamps fractions below zero and above one", () => {
		assert.equal(progressBar(-1, 4), "░░░░");
		assert.equal(progressBar(2, 4), "████");
	});

	test("returns an empty string for width zero", () => {
		assert.equal(progressBar(0.5, 0), "");
	});
});

describe("agentSummary", () => {
	test("includes label, turns, cost, duration and an ok marker", () => {
		const line = agentSummary(makeAgentRun(), 1000);
		assert.ok(line.includes("builder-1"));
		assert.ok(line.includes("3 turns"));
		assert.ok(line.includes("$0.50"));
		assert.ok(line.includes("5s"));
		assert.ok(line.includes("✓"));
	});

	test("uses the failure marker and now when the run has not ended", () => {
		const line = agentSummary(makeAgentRun({ ok: false, endedAt: undefined }), 4000);
		assert.ok(line.includes("✗"));
		assert.ok(line.includes("3s"));
	});
});

describe("renderWidget", () => {
	test("header contains key, title, status and version label", () => {
		const out = renderWidget(
			makeView({ state: makeState({ status: "running" }), version: "v0.1.0 (abc1234)" }),
			theme,
		);
		const header = out[1];
		assert.ok(header.includes("minidev"));
		assert.ok(header.includes("MD-1"));
		assert.ok(header.includes("Better UI"));
		assert.ok(header.includes("running"));
		assert.ok(header.includes("v0.1.0 (abc1234)"));
	});

	test("header omits the version label when unset", () => {
		const header = renderWidget(makeView({ state: makeState({ status: "running" }) }), theme)[1];
		assert.ok(!header.includes("v0.1.0"));
	});

	test("pipeline line contains every stage", () => {
		const out = renderWidget(makeView(), theme);
		const pipeline = out[2];
		for (const stage of ["workspace", "detect", "scout", "plan", "build", "test", "review", "pr"]) {
			assert.ok(pipeline.includes(stage), `missing ${stage}`);
		}
	});

	test("shows subtask chips during the build stage", () => {
		const state = makeState({
			stage: "build",
			subtasks: [
				{ id: "s1", title: "one", goal: "", status: "done", attempts: 1 },
				{ id: "s2", title: "two", goal: "", status: "pending", attempts: 0 },
			],
		});
		const line = renderWidget(makeView({ state }), theme).find((l) => l.includes("subtasks"));
		assert.ok(line);
		assert.ok(line.includes("1/2"));
		assert.ok(line.includes("s1"));
		assert.ok(line.includes("s2"));
	});

	test("shows the active agent, activity text and kind icons", () => {
		const activity: ActivityEntry[] = [
			{ kind: "text", text: "thinking" },
			{ kind: "retry", text: "retrying" },
		];
		const view = makeView({
			state: makeState({ status: "running" }),
			agent: { role: "builder", label: "builder-1", model: "sonnet", costUsd: 0.5, turns: 3, startedAt: 0 },
			activity,
			log: activity,
			now: 5000,
		});
		const out = renderWidget(view, theme).join("\n");
		assert.ok(out.includes("builder-1"));
		assert.ok(out.includes("» thinking"));
		assert.ok(out.includes("↻ retrying"));
	});

	test("appends an earlier hint when the log is longer than the activity", () => {
		const view = makeView({
			activity: [{ kind: "info", text: "newest" }],
			log: [
				{ kind: "info", text: "a" },
				{ kind: "info", text: "b" },
				{ kind: "info", text: "c" },
				{ kind: "info", text: "newest" },
			],
		});
		const line = renderWidget(view, theme).find((l) => l.includes("earlier"));
		assert.ok(line);
		assert.ok(line.includes("3 earlier"));
	});

	test("only prints the last MAX_ACTIVITY entries", () => {
		const activity = Array.from({ length: MAX_ACTIVITY + 3 }, (_, i): ActivityEntry => ({ kind: "info", text: `e${i}` }));
		const out = renderWidget(makeView({ activity, log: activity }), theme).join("\n");
		assert.ok(out.includes(`e${activity.length - 1}`));
		assert.ok(!out.includes("e0"));
	});

	test("includes the PR URL when set", () => {
		const out = renderWidget(makeView({ state: makeState({ prUrl: "https://example.com/pr/1" }) }), theme).join("\n");
		assert.ok(out.includes("https://example.com/pr/1"));
	});

	test("emits no ANSI escapes with a plain theme", () => {
		const out = renderWidget(makeView({ state: makeState({ prUrl: "https://example.com/pr/1" }) }), theme).join("\n");
		assert.ok(!out.includes("\u001b"));
	});

	test("wraps the output in a frame bordered by side rails", () => {
		const out = renderWidget(makeView({ state: makeState({ status: "running" }) }), theme);
		assert.ok(out[0].startsWith("╭"));
		assert.ok(out.at(-1)!.startsWith("╰"));
		for (const line of out.slice(1, -1)) {
			assert.ok(line.startsWith("│"));
			assert.ok(line.endsWith("│"));
		}
	});

	test("colors the frame with the current stage's palette entry", () => {
		const state = makeState({ stage: "test" });
		const { theme: rec, calls } = recordingTheme();
		renderWidget(makeView({ state }), rec);
		assert.equal(borderToken(calls), STAGE_COLORS[state.stage]);
	});

	test("recolors the frame when the stage changes", () => {
		const first = recordingTheme();
		const second = recordingTheme();
		renderWidget(makeView({ state: makeState({ stage: "workspace" }) }), first.theme);
		renderWidget(makeView({ state: makeState({ stage: "pr" }) }), second.theme);
		assert.equal(borderToken(first.calls), STAGE_COLORS.workspace);
		assert.equal(borderToken(second.calls), STAGE_COLORS.pr);
		assert.notEqual(borderToken(first.calls), borderToken(second.calls));
	});

	test("keeps the header, pipeline, cost and activity content inside the frame", () => {
		const view = makeView({
			state: makeState({ status: "running", costUsd: 2.5, budgetUsd: 10 }),
			activity: [{ kind: "text", text: "working" }],
			log: [{ kind: "text", text: "working" }],
		});
		const out = renderWidget(view, theme).join("\n");
		assert.ok(out.includes("minidev"));
		assert.ok(out.includes("workspace") && out.includes("pr"));
		assert.ok(out.includes("cost"));
		assert.ok(out.includes("working"));
	});
});

describe("renderDetail", () => {
	test("header line includes the version label", () => {
		const out = renderDetail(makeView({ version: "v0.1.0 (abc1234)" }), theme);
		assert.ok(out[1].includes("minidev"));
		assert.ok(out[1].includes("v0.1.0 (abc1234)"));
		assert.ok(out[1].includes("MD-1"));
	});

	test("includes Subtasks, Agents, Checks and Activity sections", () => {
		const state = makeState({
			subtasks: [{ id: "s1", title: "one", goal: "", status: "running", attempts: 2 }],
			agentRuns: [makeAgentRun()],
			checks: [{ name: "unit", ok: true, blocking: true, durationMs: 1200 }],
		});
		const out = renderDetail(makeView({ state }), theme).join("\n");
		assert.ok(out.includes("Subtasks 0/1"));
		assert.ok(out.includes("Agents (1)"));
		assert.ok(out.includes("Checks"));
		assert.ok(out.includes("Activity"));
	});

	test("includes each agent run summary", () => {
		const state = makeState({ agentRuns: [makeAgentRun({ label: "builder-1" })] });
		const out = renderDetail(makeView({ state }), theme).join("\n");
		assert.ok(out.includes("builder-1"));
		assert.ok(out.includes("3 turns"));
	});

	test("includes worktree and runDir artifact lines", () => {
		const state = makeState({ worktree: "/tmp/wt", runDir: "/tmp/run" });
		const out = renderDetail(makeView({ state }), theme).join("\n");
		assert.ok(out.includes("/tmp/wt"));
		assert.ok(out.includes("/tmp/run"));
	});

	test("returns a non-empty array for a paused state with a pause reason", () => {
		const state = makeState({ status: "paused", pauseReason: "needs approval" });
		const out = renderDetail(makeView({ state }), theme);
		assert.ok(out.length > 0);
		assert.ok(out.join("\n").includes("needs approval"));
	});

	test("frames the detail with the current stage color", () => {
		const state = makeState({ stage: "review" });
		const { theme: rec, calls } = recordingTheme();
		const out = renderDetail(makeView({ state }), rec);
		assert.ok(out[0].startsWith("╭"));
		assert.ok(out.at(-1)!.startsWith("╰"));
		assert.equal(borderToken(calls), STAGE_COLORS.review);
	});

	test("keeps the Subtasks, Agents, Checks, Activity and Artifacts sections", () => {
		const state = makeState({
			subtasks: [{ id: "s1", title: "one", goal: "", status: "running", attempts: 2 }],
			agentRuns: [makeAgentRun()],
			checks: [{ name: "unit", ok: true, blocking: true, durationMs: 1200 }],
		});
		const out = renderDetail(makeView({ state }), theme).join("\n");
		assert.ok(out.includes("Subtasks"));
		assert.ok(out.includes("Agents"));
		assert.ok(out.includes("Checks"));
		assert.ok(out.includes("Activity"));
		assert.ok(out.includes("Artifacts"));
	});
});
