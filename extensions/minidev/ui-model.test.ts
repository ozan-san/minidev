import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_ACTIVITY,
	agentSummary,
	budgetLevel,
	collapseActivity,
	pipelineChips,
	progressBar,
	pushActivity,
	renderDetail,
	renderWidget,
	type ActivityEntry,
	type DashboardView,
} from "./ui-model.ts";

type RunState = Parameters<typeof renderWidget>[0]["state"];
type Theme = Parameters<typeof renderWidget>[1];
type AgentRun = RunState["agentRuns"][number];

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

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
	test("header contains key, title and status", () => {
		const out = renderWidget(makeView({ state: makeState({ status: "running" }) }), theme);
		const header = out[0];
		assert.ok(header.includes("minidev"));
		assert.ok(header.includes("MD-1"));
		assert.ok(header.includes("Better UI"));
		assert.ok(header.includes("running"));
	});

	test("pipeline line contains every stage", () => {
		const out = renderWidget(makeView(), theme);
		const pipeline = out[1];
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
});

describe("renderDetail", () => {
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
});
