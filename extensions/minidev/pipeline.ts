import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAgents } from "./agents.ts";
import { failuresReport, runChecks, type CheckResult } from "./checks.ts";
import * as ST from "./stack.ts";
import { loadConfig, type Config, type Role, type RoleModel } from "./config.ts";
import * as G from "./git.ts";
import * as P from "./prompts.ts";
import { agentHarness, type AgentHarness, type RunnerEvent, type RunAgentResult } from "./harness.ts";
import { inputHash, requestIdFor } from "./harness-util.ts";
import { artifact, saveState, STAGES, type PlanJson, type Review, type RunState, type Stage, type Subtask } from "./state.ts";
import { ticketMarkdown } from "./ticket.ts";
import { shouldDismissPanel } from "./ui-model.ts";
import type { Dashboard } from "./ui.ts";
import { exec, extractJson, fmtUsd, sh, shellQuote, slugify, stripJsonBlocks, writeFile, readFileOr } from "./util.ts";

/** Stops the run but keeps it resumable. */
export class Pause extends Error {
	reason: string;

	constructor(reason: string) {
		super(reason);
		this.reason = reason;
	}
}

export interface LogEntry {
	key: string;
	kind: "stage" | "info" | "warn" | "error" | "plan" | "review" | "done";
	title: string;
	body?: string;
}

export interface PipelineDeps {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	dash: Dashboard;
	signal: AbortSignal;
}

export function effectiveModel(state: RunState | undefined, cfg: Config, role: Role): RoleModel {
	return { ...cfg.models[role], ...(state?.modelOverrides?.[role] ?? {}) };
}

function fill(template: string, vars: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

function guessType(title: string): string {
	return /\b(fix|bug|crash|broken|error|regression)\b/i.test(title) ? "fix" : "feat";
}

export class Pipeline {
	private cfg: Config;
	private warned = false;
	private s: RunState;
	private d: PipelineDeps;
	private agentRuntime?: Promise<AgentHarness>;

	constructor(s: RunState, d: PipelineDeps) {
		this.s = s;
		this.d = d;
		this.cfg = loadConfig(s.repoRoot);
	}

	// ── helpers ────────────────────────────────────────────────────────────

	private log(kind: LogEntry["kind"], title: string, body?: string): void {
		this.d.pi.appendEntry<LogEntry>("minidev", { key: this.s.key, kind, title, body });
		if (!this.d.ctx.hasUI) process.stderr.write(`[minidev ${this.s.key}] ${title}\n`);
	}

	private save(): void {
		saveState(this.s);
		this.d.dash.refresh();
	}

	private checkStop(): void {
		if (this.d.signal.aborted) throw new Pause("stopped");
	}

	private get wt(): string {
		return this.s.worktree as string;
	}

	private agentHarness(): Promise<AgentHarness> {
		this.agentRuntime ??= agentHarness({ runDir: this.s.runDir, registry: this.d.ctx.modelRegistry });
		return this.agentRuntime;
	}

	/** Forward harness events to the dashboard, tracking live cost. */
	private agentSink(baseCost: number, fallbackModel: string): (e: RunnerEvent) => void {
		return (e) => {
			const dash = this.d.dash;
			if (e.type === "tool") dash.push(e.summary, "tool");
			else if (e.type === "retry") dash.push(e.message, "retry");
			else if (e.type === "text") dash.push(e.text.split("\n").find((l) => l.trim()) ?? "", "text");
			else if (e.type === "usage") {
				this.s.costUsd = baseCost + e.costUsd;
				dash.agentUpdate({ costUsd: e.costUsd, turns: e.turns, model: e.model ?? fallbackModel });
			}
		};
	}

	/** Account a finished agent call's cost and append it to the run ledger. */
	private recordAgentRun(role: Role, label: string, startedAt: number, baseCost: number, r: RunAgentResult): void {
		// A replayed call's spend was already counted when it first ran.
		this.s.costUsd = baseCost + (r.replayed ? 0 : r.costUsd);
		this.s.agentRuns.push({
			role, label, model: r.model, costUsd: r.costUsd, turns: r.turns, ok: r.ok, startedAt, endedAt: Date.now(), transcript: r.transcript,
		});
		this.save();
	}

	/** Notify once when spend crosses the configured warning threshold. */
	private warnIfOverBudget(): void {
		const frac = this.s.costUsd / this.s.budgetUsd;
		if (this.warned || frac < this.cfg.budget.warnAt) return;
		this.warned = true;
		this.notify(`Budget ${Math.round(frac * 100)}% used (${fmtUsd(this.s.costUsd)} of ${fmtUsd(this.s.budgetUsd)})`, "warning");
	}

	/** Map an aborted or over-budget call onto a `Pause`. */
	private assertAgentRan(r: RunAgentResult, role: Role, maxUsd: number): RunAgentResult {
		if (r.aborted) throw new Pause("stopped");
		if (r.budgetExceeded) throw new Pause(this.s.costUsd >= this.s.budgetUsd ? "budget" : `per-call cap for ${role} (${fmtUsd(maxUsd)})`);
		return r;
	}

	private async agent(role: Role, label: string, task: string): Promise<RunAgentResult> {
		this.checkStop();
		this.cfg = loadConfig(this.s.repoRoot); // pick up model/budget changes between calls
		const agents = loadAgents(this.s.repoRoot, this.s.stack);
		const def = agents.get(role);
		if (!def) throw new Error(`Agent definition "${role}" not found`);
		const model = effectiveModel(this.s, this.cfg, role);
		const remaining = this.s.budgetUsd - this.s.costUsd;
		if (remaining <= 0) throw new Pause("budget");
		const maxUsd = Math.min(remaining, model.maxUsdPerCall ?? Number.POSITIVE_INFINITY);
		const requestId = requestIdFor(this.s.key, role, label);
		const itemHash = inputHash(def.systemPrompt, task, model.model, model.thinking ?? "");
		const startedAt = Date.now();
		const runIndex = this.s.agentRuns.length + 1;
		const fullLabel = `${String(runIndex).padStart(2, "0")}-${label}`;
		const baseCost = this.s.costUsd;
		this.d.dash.agentStart({ role, label, model: model.model, costUsd: 0, turns: 0, startedAt });

		const r = await (
			await this.agentHarness()
		).run({
			agent: def,
			model,
			task,
			cwd: this.wt,
			workDir: path.join(this.s.runDir, "agents"),
			label: fullLabel,
			requestId,
			inputHash: itemHash,
			replay: this.cfg.durable.replay === "safe",
			signal: this.d.signal,
			maxUsd,
			onEvent: this.agentSink(baseCost, model.model),
		});
		this.d.dash.agentEnd();
		this.recordAgentRun(role, label, startedAt, baseCost, r);
		this.warnIfOverBudget();
		return this.assertAgentRan(r, role, maxUsd);
	}

	private notify(msg: string, type: "info" | "warning" | "error" = "info"): void {
		if (this.d.ctx.hasUI) this.d.ctx.ui.notify(msg, type);
		else process.stderr.write(`[minidev] ${msg}\n`);
	}

	private async checks(which: "subtask" | "final", label: string): Promise<CheckResult[]> {
		this.checkStop();
		const list = ST.effectiveChecks(this.cfg, this.s.stack)[which];
		const hasTests = await ST.hasTests(this.wt, this.s.stack);
		this.d.dash.setNote(`checks: ${list.map((c) => c.name).join(", ")}`);
		const res = await runChecks(list, this.wt, path.join(this.s.runDir, "logs"), label, {
			hasTests,
			signal: this.d.signal,
			onLine: (name, l) => this.d.dash.push(`[${name}] ${l}`, "check"),
		});
		this.checkStop();
		for (const r of res) {
			this.s.checks.push({ name: r.name, ok: r.ok, skipped: r.skipped, blocking: r.blocking, durationMs: r.durationMs, logPath: r.logPath });
		}
		this.save();
		return res;
	}

	private async commit(message: string): Promise<string | null> {
		const sha = await G.commitAll(this.wt, message);
		if (sha) this.d.dash.push(`commit ${sha} ${message}`, "commit");
		return sha;
	}

	private async choose(title: string, options: string[], headless: string): Promise<string> {
		if (!this.d.ctx.hasUI) return headless;
		this.d.dash.waiting(title);
		const pick = await this.d.ctx.ui.select(title, options);
		this.checkStop();
		return pick ?? options[options.length - 1];
	}

	// ── run ────────────────────────────────────────────────────────────────

	async run(): Promise<void> {
		const s = this.s;
		s.status = "running";
		s.pauseReason = undefined;
		s.error = undefined;
		this.d.dash.attach(s);
		this.save();
		try {
			for (const stage of STAGES) {
				if (s.completed.includes(stage)) continue;
				s.stage = stage;
				this.save();
				this.d.dash.stage(stage);
				this.log("stage", `▶ ${stage}`);
				await this.stages[stage]();
				s.completed.push(stage);
				this.save();
			}
			s.status = "done";
			this.save();
			const summary = [
				`Branch: \`${s.branch}\``,
				s.inPlace ? `Checkout (in-place): \`${s.worktree}\`` : `Worktree: \`${s.worktree}\``,
				s.prUrl ? `PR: ${s.prUrl}` : s.pushed ? "Pushed (no PR command ran)" : s.inPlace ? "In-place: commits kept local" : "Not pushed",
				`Cost: ${fmtUsd(s.costUsd)} (${s.agentRuns.length} agent runs)`,
				`Artifacts: \`${s.runDir}\``,
			].join("\n");
			this.log("done", `✓ ${s.key} done`, summary);
			this.notify(`minidev ${s.key} done${s.prUrl ? ` — ${s.prUrl}` : ""}`);
		} catch (err) {
			if (err instanceof Pause || this.d.signal.aborted) {
				s.status = "paused";
				s.pauseReason = err instanceof Pause ? err.reason : "stopped";
				this.log("warn", `⏸ paused at ${s.stage}: ${s.pauseReason}`, `Resume with \`/minidev resume ${s.key}\`${s.pauseReason === "budget" ? ` (raise the cap first: \`/minidev budget <usd>\`)` : ""}`);
				this.notify(`minidev ${s.key} paused: ${s.pauseReason}`, "warning");
			} else {
				s.status = "failed";
				s.error = (err as Error).stack ?? String(err);
				this.log("error", `✗ ${s.stage} failed`, `\`\`\`\n${(err as Error).message}\n\`\`\`\nResume with \`/minidev resume ${s.key}\``);
				this.notify(`minidev ${s.key} failed at ${s.stage}: ${(err as Error).message}`, "error");
			}
			for (const t of s.subtasks) if (t.status === "running") t.status = "pending";
			this.save();
		} finally {
			if (shouldDismissPanel(s.status, this.cfg.ui.dismissOn)) this.d.dash.dismiss();
			else this.d.dash.detach();
		}
	}

	private stages: Record<Stage, () => Promise<void>> = {
		workspace: () => this.workspace(),
		detect: () => this.detect(),
		scout: () => this.scout(),
		plan: () => this.plan(),
		build: () => this.build(),
		test: () => this.test(),
		review: () => this.review(),
		pr: () => this.pr(),
	};

	// ── stages ─────────────────────────────────────────────────────────────

	/**
	 * Decide where the run works: a fresh worktree on a new branch (default), or in-place
	 * (`--in-place`/`git.inPlace`) in the main checkout on the current branch, diffed against the
	 * commit the run started from.
	 */
	private async workspace(): Promise<void> {
		const s = this.s;
		const g = this.cfg.git;
		writeFile(artifact(s, "ticket.md"), ticketMarkdown(s.ticket));
		const inPlace = s.inPlace ?? g.inPlace;
		const base = s.base ?? (await G.detectBase(s.repoRoot, g.remote, g.baseBranch));
		if (!inPlace && g.fetch) {
			this.d.dash.setNote(`git fetch ${g.remote} ${base}`);
			if (!(await G.fetchRemote(s.repoRoot, g.remote, base))) this.d.dash.push(`fetch ${g.remote} failed — using local refs`);
		}
		const plan = G.checkoutPlan({
			inPlace,
			repoRoot: s.repoRoot,
			worktreeRoot: g.worktreeRoot,
			repoName: s.repoName,
			key: s.key,
			branch: inPlace ? "" : (s.branch ?? fill(g.branchTemplate, { key: s.key, slug: slugify(s.title), type: guessType(s.title) }).replace(/[^\w./-]+/g, "-")),
			base,
			baseRef: inPlace ? "" : (s.baseRef ?? (await G.resolveBaseRef(s.repoRoot, g.remote, base))),
			currentBranch: inPlace ? ((await G.currentBranch(s.repoRoot)) ?? "") : "",
			headSha: inPlace ? ((await G.headSha(s.repoRoot)) ?? "") : "",
		});
		s.inPlace = inPlace;
		s.base = plan.base;
		s.baseRef = plan.baseRef;
		s.branch = plan.branch;
		s.worktree = plan.cwd;
		this.save();
		if (plan.mode === "in-place") {
			if (await G.hasChanges(s.repoRoot))
				throw new Error(`in-place run needs a clean checkout: commit or stash your local changes first (${s.repoRoot})`);
			const target = G.pushesInPlace(s.branch, s.base) ? `the PR target is \`${s.base}\`` : `\`${s.base}\` is the base branch, so nothing is pushed and no PR is opened`;
			this.log("info", `in-place on \`${s.branch}\``, `\`${plan.cwd}\` · diff base \`${s.baseRef}\` · ${target}`);
			return;
		}
		const how = await G.ensureWorktree(s.repoRoot, s.worktree, s.branch, s.baseRef);
		const copied = G.copyIntoWorktree(s.repoRoot, s.worktree, g.copyIntoWorktree);
		this.save();
		this.log("info", `worktree ${how}`, `\`${s.worktree}\` on \`${s.branch}\` from \`${s.baseRef}\`${copied.length ? `\nCopied: ${copied.join(", ")}` : ""}`);
	}

	/** Explore the repo, pick the stack mode, run setup (dependency install / project generation). */
	private async detect(): Promise<void> {
		const s = this.s;
		this.d.dash.setNote("exploring repository");
		const derivedData = path.join(s.runDir, "DerivedData");
		let stack = await ST.detectStack(this.wt, {
			forced: this.cfg.stack,
			derivedData,
			choose: this.d.ctx.hasUI
				? async (cands, summary) => {
						const labels = cands.map((c) => ST.STACK_LABELS[c]);
						const pick = await this.choose(`Several stacks match this repo:\n${summary}\n\nWhich mode should minidev use?`, labels, labels[0]);
						return cands[labels.indexOf(pick)];
					}
				: undefined,
		});
		s.stack = stack;
		this.save();

		const setup = ST.effectiveSetup(this.cfg, stack);
		if (setup.length) await this.runSetup(setup, "setup");
		stack = await ST.refreshAfterSetup(this.wt, stack, derivedData);
		s.stack = stack;
		this.save();
		const checks = ST.effectiveChecks(this.cfg, stack);
		const explicit = this.cfg.checks ? " (checks from config)" : this.cfg.stacks?.[stack.id]?.checks ? ` (checks from stacks.${stack.id})` : "";
		this.log("info", `mode: ${stack.label}${explicit}`, ST.describeStack(stack, checks));
		if (!checks.subtask.length && !checks.final.length) this.d.dash.push("no build/test commands detected — the scout will look for them");
	}

	private async runSetup(cmds: string[], label: string): Promise<void> {
		for (const [i, cmd] of cmds.entries()) {
			this.checkStop();
			const res = await runChecks([{ name: `${label}${i + 1}`, command: cmd, timeoutSec: 1800 }], this.wt, path.join(this.s.runDir, "logs"), label, {
				hasTests: false,
				signal: this.d.signal,
				onLine: (_n, l) => this.d.dash.push(`[${label}] ${l}`, "check"),
			});
			this.checkStop();
			const r = res[0];
			if (r.ok) {
				this.d.dash.push(`✓ ${cmd}`);
				continue;
			}
			this.log("warn", `${label} failed: ${cmd}`, `\`\`\`\n${r.tail}\n\`\`\`\nLog: ${r.logPath}`);
			const pick = await this.choose(`Setup command failed: ${cmd}`, ["Continue anyway", "Pause"], "Pause");
			if (pick === "Pause") throw new Pause(`${label} failed: ${cmd}`);
		}
	}

	private async scout(): Promise<void> {
		const s = this.s;
		const r = await this.agent("scout", "scout", P.scoutTask(s, this.cfg));
		if (!r.ok) throw new Error(`scout failed: ${r.error}`);
		writeFile(artifact(s, "context.md"), stripJsonBlocks(r.output));
		this.log("info", `scout ✓ ${fmtUsd(r.costUsd)}`, stripJsonBlocks(r.output));
		try {
			s.scoutCommands = extractJson<{ commands?: ST.ScoutCommands }>(r.output).commands;
		} catch {
			s.scoutCommands = undefined;
		}
		this.save();
		// Fall back to the scout's commands only when nothing was detected or configured.
		const st = s.stack;
		const cmds = s.scoutCommands;
		if (!st || !cmds || this.cfg.checks || this.cfg.stacks?.[st.id]?.checks) return;
		if (!ST.effectiveSetup(this.cfg, st).length && cmds.setup?.length && st.checksSource === "none") {
			st.setup = cmds.setup;
			await this.runSetup(cmds.setup, "scout-setup");
		}
		if (ST.applyScoutCommands(st, cmds)) {
			this.save();
			this.log("info", "using build/test commands proposed by the scout", ST.describeStack(st, ST.effectiveChecks(this.cfg, st)));
		}
	}

	private parsePlan(text: string): PlanJson {
		const plan = extractJson<PlanJson>(text);
		if (!plan || !Array.isArray(plan.subtasks) || plan.subtasks.length === 0) throw new Error("plan JSON has no subtasks");
		plan.subtasks = plan.subtasks.slice(0, this.cfg.limits.maxSubtasks).map((t, i) => ({
			...t,
			id: t.id || `S${i + 1}`,
			title: t.title || `Subtask ${i + 1}`,
			goal: t.goal || t.title || "",
		}));
		return plan;
	}

	private applyPlan(plan: PlanJson, markdown: string): void {
		const s = this.s;
		s.plan = plan;
		s.subtasks = plan.subtasks.map((t) => ({ ...t, status: "pending", attempts: 0 }) as Subtask);
		writeFile(artifact(s, "plan.md"), markdown);
		writeFile(artifact(s, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
		this.save();
	}

	private planMarkdown(plan: PlanJson, prose: string): string {
		const subtasks = plan.subtasks
			.map(
				(t) =>
					`### ${t.id}: ${t.title}\n${t.goal}\n${t.files?.length ? `\nFiles: ${t.files.map((f) => `\`${f}\``).join(", ")}\n` : ""}${t.steps?.length ? `\n${t.steps.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n` : ""}${t.acceptance?.length ? `\nAcceptance:\n${t.acceptance.map((x) => `- ${x}`).join("\n")}\n` : ""}`,
			)
			.join("\n");
		return `${prose}\n\n## Subtasks (${plan.subtasks.length})\n\n${subtasks}`;
	}

	private async runPlanner(feedback?: { previous: string; notes: string }): Promise<void> {
		const r = await this.agent("planner", feedback ? "planner-revise" : "planner", P.plannerTask(this.s, this.cfg, feedback));
		if (!r.ok) throw new Error(`planner failed: ${r.error}`);
		let plan: PlanJson;
		let text = r.output;
		try {
			plan = this.parsePlan(text);
		} catch (err) {
			this.d.dash.push(`plan JSON invalid (${(err as Error).message}) — asking planner to re-emit`);
			const fix = await this.agent(
				"planner",
				"planner-json",
				`Your previous plan output did not contain a valid JSON block (${(err as Error).message}). Re-emit ONLY the final \`\`\`json block in the required shape for this plan:\n\n${text}`,
			);
			plan = this.parsePlan(fix.output);
		}
		const md = this.planMarkdown(plan, stripJsonBlocks(text));
		this.applyPlan(plan, md);
		this.log("plan", `plan ✓ ${plan.subtasks.length} subtasks · ${fmtUsd(r.costUsd)}`, md);
	}

	private async plan(): Promise<void> {
		const s = this.s;
		if (!s.plan) await this.runPlanner();
		if (!this.cfg.gates.plan || s.planApproved) return;
		if (!this.d.ctx.hasUI) throw new Pause("awaiting plan approval");
		for (;;) {
			const pick = await this.choose(
				`Plan for ${s.key} [${s.stack?.label ?? "?"}]: ${s.subtasks.length} subtasks (spent ${fmtUsd(s.costUsd)}). Proceed?`,
				["Approve & build", "Edit plan JSON", "Re-plan with feedback", "Pause"],
				"Pause",
			);
			if (pick === "Approve & build") break;
			if (pick === "Pause") throw new Pause("awaiting plan approval");
			if (pick === "Edit plan JSON") {
				const edited = await this.d.ctx.ui.editor("Edit plan (JSON)", JSON.stringify(s.plan, null, 2));
				if (!edited) continue;
				try {
					const plan = this.parsePlan(`\`\`\`json\n${edited}\n\`\`\``);
					const prose = stripJsonBlocks(readFileOr(artifact(s, "plan.md"), "")).split("\n## Subtasks")[0];
					const md = this.planMarkdown(plan, prose);
					this.applyPlan(plan, md);
					this.log("plan", `plan edited · ${plan.subtasks.length} subtasks`, md);
				} catch (err) {
					this.notify(`Invalid plan JSON: ${(err as Error).message}`, "error");
				}
			}
			if (pick === "Re-plan with feedback") {
				const notes = await this.d.ctx.ui.editor("What should the planner change?", "");
				if (!notes?.trim()) continue;
				await this.runPlanner({ previous: readFileOr(artifact(s, "plan.md"), ""), notes });
			}
		}
		s.planApproved = true;
		this.save();
	}

	/** Run the builder on `t` up to `limits.subtaskAttempts` times; returns the failure report, or undefined when its blocking checks pass. */
	private async runSubtaskAttempts(t: Subtask, resumed: boolean): Promise<string | undefined> {
		let failure: string | undefined;
		for (let i = 0; i < this.cfg.limits.subtaskAttempts; i++) {
			t.attempts++;
			this.save();
			const r = await this.agent(
				"builder",
				`build-${t.id}${t.attempts > 1 ? `-try${t.attempts}` : ""}`,
				P.builderSubtaskTask(this.s, this.cfg, t, failure, resumed && i === 0),
			);
			t.summary = r.output;
			if (!r.ok) {
				failure = `The builder process ended with an error: ${r.error}`;
				continue;
			}
			const res = await this.checks("subtask", `${t.id}-try${t.attempts}`);
			if (res.every((c) => c.ok || !c.blocking)) return undefined;
			failure = failuresReport(res);
		}
		return failure;
	}

	private async build(): Promise<void> {
		const s = this.s;
		for (const t of s.subtasks) {
			if (t.status === "done") continue;
			const resumed = t.attempts > 0 && (await G.hasChanges(this.wt));
			t.status = "running";
			this.save();
			let ok = false;
			while (!ok) {
				const failure = await this.runSubtaskAttempts(t, resumed);
				ok = failure === undefined;
				if (ok) break;
				const pick = await this.choose(
					`${t.id} "${t.title}" still failing after ${t.attempts} attempts`,
					[`Retry ${this.cfg.limits.subtaskAttempts} more times`, "Accept as-is & continue", "Pause"],
					"Pause",
				);
				if (pick === "Pause") {
					t.status = "failed";
					this.log("warn", `${t.id} failing`, failure);
					throw new Pause(`${t.id} failing checks`);
				}
				if (pick === "Accept as-is & continue") break;
			}
			if (this.cfg.git.commitPerSubtask) {
				t.commit = (await this.commit(fill(this.cfg.git.subtaskCommitTemplate, { key: s.key, id: t.id, title: t.title }))) ?? undefined;
			}
			t.status = "done";
			this.save();
			this.log("info", `${t.id} ✓ ${t.title}${t.commit ? ` (${t.commit})` : ""}${ok ? "" : " ⚠ checks failing"}`, t.summary);
		}
		if (!this.cfg.git.commitPerSubtask) await this.commit(fill(this.cfg.git.commitTemplate, { key: s.key, title: s.title }));
	}

	/** Run final checks; on blocking failure, let the builder fix, up to fixRounds. */
	private async finalChecksWithFixes(label: string): Promise<CheckResult[]> {
		const s = this.s;
		for (;;) {
			const res = await this.checks("final", `${label}-${s.fixRounds}`);
			const failing = res.filter((r) => !r.ok && r.blocking);
			if (!failing.length) return res;
			if (s.fixRounds >= this.cfg.limits.fixRounds) {
				const pick = await this.choose(
					`Checks still failing (${failing.map((f) => f.name).join(", ")}) after ${s.fixRounds} fix rounds`,
					["One more fix round", "Continue anyway", "Pause"],
					"Pause",
				);
				if (pick === "Pause") throw new Pause(`checks failing: ${failing.map((f) => f.name).join(", ")}`);
				if (pick === "Continue anyway") return res;
			}
			s.fixRounds++;
			this.save();
			const r = await this.agent("builder", `fix-checks-${s.fixRounds}`, P.fixTask(s, this.cfg, failuresReport(res), "checks"));
			if (r.ok) await this.commit(`${s.key}: fix ${failing.map((f) => f.name).join(", ")}`);
		}
	}

	private async test(): Promise<void> {
		const s = this.s;
		const hasTests = await ST.hasTests(this.wt, this.s.stack);
		const mode = this.cfg.tests.write;
		const write = mode === "always" || (mode === "auto" && hasTests);
		let report = "";
		if (write) {
			const r = await this.agent("tester", "tester", P.testerTask(s, this.cfg, hasTests));
			report = r.output;
			if (r.ok) await this.commit(`${s.key}: add unit tests`);
			this.log("info", `tester ${r.ok ? "✓" : "✗"} ${fmtUsd(r.costUsd)}`, r.output);
		} else {
			report = `No unit tests written (tests.write=${mode}, repo has unit tests: ${hasTests}).`;
			this.log("info", "tester skipped", report);
		}
		const res = await this.finalChecksWithFixes("final");
		const table = res.map((r) => `- ${r.name}: ${r.skipped ? "skipped" : r.ok ? "pass" : r.blocking ? "**FAIL**" : "fail (non-blocking)"}`).join("\n");
		writeFile(artifact(s, "test-report.md"), `${report}\n\n## Checks\n${table}\n`);
		this.log("info", "checks", table);
	}

	private async review(): Promise<void> {
		const s = this.s;
		while (s.reviewRounds <= this.cfg.limits.reviewRounds) {
			const r = await this.agent("reviewer", `review-${s.reviewRounds + 1}`, P.reviewerTask(s));
			let review: Review;
			try {
				review = extractJson<Review>(r.output);
				review.mustFix = Array.isArray(review.mustFix) ? review.mustFix : [];
				if (review.verdict !== "changes") review.verdict = review.mustFix.length ? "changes" : "approve";
			} catch {
				review = { verdict: "approve", summary: "Reviewer did not return a structured verdict; see review.md.", mustFix: [] };
			}
			s.review = review;
			writeFile(artifact(s, "review.md"), r.output);
			this.save();
			this.log("review", `review: ${review.verdict} (${review.mustFix.length} must-fix) · ${fmtUsd(r.costUsd)}`, stripJsonBlocks(r.output));
			if (review.verdict === "approve" || !review.mustFix.length) return;
			if (s.reviewRounds >= this.cfg.limits.reviewRounds) return; // out of rounds: findings go into the PR body
			s.reviewRounds++;
			this.save();
			const fx = await this.agent("builder", `fix-review-${s.reviewRounds}`, P.fixTask(s, this.cfg, P.reviewFindings(review), "review"));
			if (fx.ok) await this.commit(`${s.key}: address review`);
			this.log("info", `review fixes ${fx.ok ? "✓" : "✗"} · ${fmtUsd(fx.costUsd)}`, fx.output);
			await this.finalChecksWithFixes("post-review");
			// Next loop iteration re-reviews only if more review rounds remain.
			if (s.reviewRounds >= this.cfg.limits.reviewRounds) {
				s.review = { ...review, summary: `${review.summary}\n\nMust-fix items were addressed in a follow-up commit.` };
				this.save();
				return;
			}
		}
	}

	private async resolvePrCommand(): Promise<string> {
		const c = this.cfg.pr.command;
		if (c !== "auto") return c;
		const url = (await G.remoteUrl(this.s.repoRoot, this.cfg.git.remote)) ?? "";
		const has = async (bin: string) => (await exec("which", [bin], { cwd: this.wt })).code === 0;
		if (/github/i.test(url) && (await has("gh"))) {
			return "gh pr create --title {title} --body-file {bodyFile} --base {base} --head {branch} {draft}";
		}
		if (/gitlab/i.test(url) && (await has("glab"))) {
			return 'glab mr create --title {title} --description "$(cat {bodyFile})" --target-branch {base} --source-branch {branch} {draft} --yes';
		}
		return "";
	}

	/** The push gate: whether to push and whether to open the PR. Throws Pause when the user keeps the branch local. */
	private async prDecision(title: string, hasCommand: boolean): Promise<{ openPr: boolean; pushOnly: boolean }> {
		if (!this.cfg.gates.pr || this.s.prApproved) return { openPr: this.cfg.pr.push, pushOnly: false };
		if (!this.d.ctx.hasUI) throw new Pause("awaiting PR approval");
		const opts = hasCommand ? ["Push & open PR", "Push only", "Keep local (pause)"] : ["Push", "Keep local (pause)"];
		const pick = await this.choose(`${title} — total ${fmtUsd(this.s.costUsd)}`, opts, "Keep local (pause)");
		if (pick.startsWith("Keep local")) throw new Pause("awaiting PR approval");
		return { openPr: pick === "Push & open PR", pushOnly: !pick.startsWith("Push &") };
	}

	private async pushBranch(): Promise<void> {
		this.d.dash.setNote(`git push ${this.cfg.git.remote} ${this.s.branch}`);
		await G.push(this.wt, this.cfg.git.remote, this.s.branch as string);
		this.s.pushed = true;
		this.save();
	}

	private async openPr(title: string, bodyFile: string, cmdTemplate: string): Promise<void> {
		const cmd = fill(cmdTemplate, {
			title: shellQuote(title),
			bodyFile: shellQuote(bodyFile),
			base: shellQuote(this.s.base as string),
			branch: shellQuote(this.s.branch as string),
			remote: shellQuote(this.cfg.git.remote),
			draft: this.cfg.pr.draft ? "--draft" : "",
		});
		this.d.dash.setNote("opening PR");
		const r = await sh(cmd, { cwd: this.wt, timeoutMs: 120_000 });
		if (r.code !== 0) throw new Error(`PR command failed: ${(r.stderr || r.stdout).trim()}\nCommand: ${cmd}`);
		this.s.prUrl = /(https?:\/\/\S+)/.exec(r.stdout)?.[1] ?? r.stdout.trim();
		this.save();
	}

	private async pr(): Promise<void> {
		const s = this.s;
		if (await G.hasChanges(this.wt)) await this.commit(`${s.key}: remaining changes`);
		const diffStat = await G.diffStat(this.wt, s.baseRef as string);
		if (!diffStat.trim()) throw new Error(`No changes on ${s.branch} relative to ${s.baseRef}`);
		const lintFail = s.checks.filter((c) => !c.ok && !c.blocking && !c.skipped).map((c) => c.name);
		const body = P.prBody(s, {
			diffStat,
			testReport: readFileOr(artifact(s, "test-report.md"), ""),
			lint: lintFail.length ? `⚠️ Non-blocking checks failing: ${[...new Set(lintFail)].join(", ")}` : undefined,
		});
		const bodyFile = artifact(s, "pr-body.md");
		writeFile(bodyFile, body);
		const title = s.plan?.prTitle ? `${s.key}: ${s.plan.prTitle}` : `${s.key}: ${s.title}`;
		const cmdTemplate = await this.resolvePrCommand();
		this.log("info", `PR ready: ${title}`, `${body}\n\n---\nCommits:\n\`\`\`\n${await G.commitLog(this.wt, s.baseRef as string)}\n\`\`\``);

		// In-place runs never push the base branch itself.
		if (s.inPlace && !G.pushesInPlace(s.branch as string, s.base as string)) {
			this.log(
				"warn",
				"in-place run on the base branch — nothing pushed",
				`\`${s.branch}\` is the base branch \`${s.base}\`, so the run kept its commits local (no push, no PR). Work on a feature branch, or run with a worktree, for an automatic PR.`,
			);
			return;
		}

		const gate = await this.prDecision(title, Boolean(cmdTemplate));
		if (gate.pushOnly) {
			await this.pushBranch();
			return;
		}
		if (!this.cfg.pr.push) return;
		await this.pushBranch();
		if (!gate.openPr || !cmdTemplate) return;
		await this.openPr(title, bodyFile, cmdTemplate);
	}
}

export function removeWorktree(state: RunState): Promise<unknown> {
	if (!state.worktree || !fs.existsSync(state.worktree)) return Promise.resolve();
	return exec("git", ["worktree", "remove", "--force", state.worktree], { cwd: state.repoRoot });
}
