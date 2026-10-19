import type { Config } from "./config.ts";
import type { PlanJson, Review, RunState, Subtask } from "./state.ts";
import { effectiveChecks } from "./stack.ts";
import { artifact } from "./state.ts";
import { fmtUsd } from "./util.ts";

/** Push embedded markdown headings below the PR body's own "###" level. */
const demote = (md: string) => md.replace(/^(#{1,3}) /gm, (_m, h: string) => `${"#".repeat(Math.min(h.length + 3, 6))} `);

const files = (s: RunState) => ({
	ticket: artifact(s, "ticket.md"),
	context: artifact(s, "context.md"),
	plan: artifact(s, "plan.md"),
	planJson: artifact(s, "plan.json"),
});

const cmds = (list: { command: string; blocking?: boolean }[]) =>
	list
		.filter((c) => c.blocking !== false)
		.map((c) => `\`${c.command}\``)
		.join(", ");
const subtaskCheckCmds = (s: RunState, cfg: Config) =>
	cmds(effectiveChecks(cfg, s.stack).subtask) || "nothing (no build command known — verify your change yourself as described in the task)";
const finalCheckCmds = (s: RunState, cfg: Config) => cmds(effectiveChecks(cfg, s.stack).final) || "nothing (no checks known)";

const stackLine = (s: RunState) => (s.stack ? `Project mode: ${s.stack.label}\n` : "");

/** "Working directory …" line for the code-writing stages; in-place runs edit the user's own checkout. */
const cwdLine = (s: RunState) =>
	s.inPlace
		? `Working directory (in-place run: the main checkout on branch ${s.branch} — change only what the task needs, everything else in this checkout is the user's): ${s.worktree}`
		: `Working directory (git worktree): ${s.worktree}`;

export function scoutTask(s: RunState, cfg: Config): string {
	const f = files(s);
	const checks = effectiveChecks(cfg, s.stack);
	const known = [...checks.subtask, ...checks.final].map((c) => `- ${c.name}: \`${c.command}\``);
	return `Investigate this repository for the ticket below. Working directory: ${s.worktree}
${stackLine(s)}${known.length ? `Build/test commands minidev already detected (confirm or correct them in your JSON):\n${[...new Set(known)].join("\n")}\n` : "minidev could NOT detect build/test commands for this repo — finding them is part of your job (see the JSON block).\n"}

Ticket (also at ${f.ticket}):
---
# ${s.key}: ${s.title}
${s.ticket.body}
---

Return your findings in the required format.`;
}

export function plannerTask(s: RunState, cfg: Config, feedback?: { previous: string; notes: string }): string {
	const f = files(s);
	return `Create the implementation plan for this ticket. Working directory: ${s.worktree}
${stackLine(s)}
Read these first:
- Ticket: ${f.ticket}
- Scout findings: ${f.context}

Constraints:
- At most ${cfg.limits.maxSubtasks} subtasks.
- After each subtask the orchestrator runs: ${subtaskCheckCmds(s, cfg)} — every subtask must leave it passing.
- Final checks after all subtasks: ${finalCheckCmds(s, cfg)}.
- Test writing happens in a separate stage (from "testPlan").
${
	feedback
		? `
The user reviewed your previous plan and asked for changes.

Previous plan:
${feedback.previous}

User feedback:
${feedback.notes}

Produce a complete revised plan (same output format).`
		: ""
}`;
}

function subtaskBlock(t: Subtask): string {
	return [
		`### ${t.id}: ${t.title}`,
		`Goal: ${t.goal}`,
		t.files?.length ? `Files:\n${t.files.map((x) => `- ${x}`).join("\n")}` : "",
		t.steps?.length ? `Steps:\n${t.steps.map((x, i) => `${i + 1}. ${x}`).join("\n")}` : "",
		t.acceptance?.length ? `Acceptance:\n${t.acceptance.map((x) => `- ${x}`).join("\n")}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

export function builderSubtaskTask(
	s: RunState,
	cfg: Config,
	t: Subtask,
	previousFailure?: string,
	partialWork?: boolean,
): string {
	const f = files(s);
	const plan = s.plan as PlanJson;
	const done = s.subtasks.filter((x) => x.status === "done");
	const later = s.subtasks.filter((x) => x.status !== "done" && x.id !== t.id);
	return `Implement ONE subtask of the plan for ticket ${s.key}: "${s.title}".
${cwdLine(s)}
${stackLine(s)}
Overall goal: ${plan.summary}
Full plan (read only if you need more context): ${f.plan}
Ticket: ${f.ticket}

${done.length ? `Already done (do not redo):\n${done.map((x) => `- ${x.id}: ${x.title}${x.summary ? ` — ${firstLine(x.summary)}` : ""}`).join("\n")}\n` : ""}${later.length ? `Later subtasks (do NOT implement these now):\n${later.map((x) => `- ${x.id}: ${x.title}`).join("\n")}\n` : ""}
## Your subtask
${subtaskBlock(t)}

After you finish, the orchestrator runs ${subtaskCheckCmds(s, cfg)}; it must pass.
${partialWork ? `\nNote: ${s.inPlace ? "the checkout" : "the worktree"} may contain partial uncommitted work from an interrupted attempt at this subtask — check \`git status\`/\`git diff\` and continue from it.\n` : ""}${
		previousFailure
			? `
## Previous attempt failed
Your previous attempt left the changes below in place, but the checks failed. Fix the problems (do not start over unless needed):

${previousFailure}
`
			: ""
	}`;
}

export function fixTask(s: RunState, cfg: Config, problems: string, kind: "checks" | "review"): string {
	const f = files(s);
	return `Fix ${kind === "checks" ? "failing checks" : "code review findings"} on the branch for ticket ${s.key}: "${s.title}".
${cwdLine(s)}
Ticket: ${f.ticket}
Plan: ${f.plan}
See what the branch changed with: git diff ${s.baseRef}...HEAD (plus uncommitted changes via git diff)

## Problems to fix
${problems}

Fix only these problems with minimal changes. When done, the orchestrator runs: ${finalCheckCmds(s, cfg)}.`;
}

export function testerTask(s: RunState, cfg: Config, hasTests: boolean): string {
	const f = files(s);
	const tp = s.plan?.testPlan;
	const allowDeps = cfg.tests.write === "always" && !hasTests;
	const testCmd = effectiveChecks(cfg, s.stack).final.find((c) => /test/i.test(c.name));
	return `Write unit tests for the change on this branch (ticket ${s.key}: "${s.title}").
${cwdLine(s)}
${stackLine(s)}${testCmd ? `Full test command (the orchestrator runs it afterwards): \`${testCmd.command}\`\n` : ""}Base: ${s.baseRef} — see changes with: git diff ${s.baseRef}...HEAD
Ticket: ${f.ticket}
Plan: ${f.plan}

Test plan from the planner:
${tp?.unitTests?.length ? tp.unitTests.map((x) => `- ${x}`).join("\n") : "- (none given — cover the main new/changed logic)"}

${hasTests ? "The repo already has unit tests; follow their setup and style." : allowDeps ? "The repo has no unit tests yet. You MAY add a minimal test setup using the stack's standard framework (prefer anything already declared in the project's dependencies)." : "The repo has no unit tests set up. Only add tests if a test framework/target is already configured; otherwise report that and stop."}`;
}

export function reviewerTask(s: RunState): string {
	const f = files(s);
	return `Review the branch for ticket ${s.key}: "${s.title}".
${cwdLine(s)}
${stackLine(s)}Diff: git diff ${s.baseRef}...HEAD
Ticket: ${f.ticket}
Plan: ${f.plan}
${s.checks.length ? `\nAutomated checks (latest):\n${latestChecks(s)}\n` : ""}
Give your verdict in the required format.`;
}

export function reviewFindings(r: Review): string {
	return r.mustFix.map((m, i) => `${i + 1}. ${m.file ? `\`${m.file}\`: ` : ""}${m.issue}${m.fix ? `\n   Fix: ${m.fix}` : ""}`).join("\n");
}

function latestChecks(s: RunState): string {
	const latest = new Map<string, (typeof s.checks)[number]>();
	for (const c of s.checks) latest.set(c.name, c);
	return [...latest.values()].map((c) => `- ${c.name}: ${c.skipped ? "skipped" : c.ok ? "pass" : "FAIL"}`).join("\n");
}

export function prBody(s: RunState, opts: { diffStat: string; testReport: string; lint?: string }): string {
	const plan = s.plan;
	const lines: string[] = [];
	lines.push(`## ${s.key}: ${s.title}`, "");
	if (s.stack) lines.push(`<sub>${s.stack.label}</sub>`, "");
	if (s.ticket.url) lines.push(`Ticket: ${s.ticket.url}`, "");
	if (plan?.summary) lines.push(plan.summary, "");
	lines.push("### Changes");
	for (const t of s.subtasks) lines.push(`- ${t.status === "done" ? "✅" : "⚠️"} **${t.id}** ${t.title}${t.commit ? ` (${t.commit})` : ""}`);
	lines.push("", "### Checks", latestChecks(s) || "- none");
	if (opts.lint) lines.push("", opts.lint);
	if (opts.testReport.trim()) lines.push("", "### Tests", demote(opts.testReport.trim()));
	if (plan?.testPlan?.manualChecks?.length) {
		lines.push("", "### Manual QA");
		for (const m of plan.testPlan.manualChecks) lines.push(`- [ ] ${m}`);
	}
	if (s.review) {
		lines.push("", `### Automated review: ${s.review.verdict}`, s.review.summary);
		if (s.review.suggestions?.length) for (const x of s.review.suggestions) lines.push(`- ${x}`);
	}
	if (plan?.risks?.length) {
		lines.push("", "### Risks");
		for (const r of plan.risks) lines.push(`- ${r}`);
	}
	lines.push("", "<details><summary>Diff stat</summary>", "", "```", opts.diffStat, "```", "</details>");
	const models = [...new Set(s.agentRuns.map((r) => `${r.role}: ${r.model}`))].join(", ");
	lines.push("", `<sub>Generated by minidev · ${models} · cost ${fmtUsd(s.costUsd)}</sub>`);
	return `${lines.join("\n")}\n`;
}

function firstLine(s: string): string {
	return (
		s
			.split("\n")
			.map((l) => l.replace(/^[#\-*\s]+/, "").trim())
			.find((l) => l && !/^done$/i.test(l)) ?? ""
	).slice(0, 140);
}
