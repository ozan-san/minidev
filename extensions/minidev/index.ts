/**
 * minidev — ticket → PR pipeline for pi.
 *
 *   /minidev run [ISSUE-KEY | ticket.md | title]   start a run (opens an editor for ticket details)
 *   /minidev resume [KEY]                          continue a paused/failed run
 *   /minidev approve [KEY]                         approve a pending plan/PR gate and resume
 *   /minidev status                                list runs for this repo
 *   /minidev stop                                  stop the active run (resumable)
 *   /minidev models [role model[:thinking]]        show / change per-role models
 *   /minidev budget <usd> [default]                change the active run's (or default) budget
 *   /minidev clean <KEY>                           remove a run's worktree
 *   /minidev config                                show effective config
 */
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { loadConfig, PROJECT_CONFIG, ROLES, saveUserConfig, THINKING_LEVELS, USER_CONFIG, type Role, type RoleModel, type Thinking } from "./config.ts";
import { mainRepoRoot } from "./git.ts";
import { effectiveModel, Pipeline, removeWorktree, type LogEntry } from "./pipeline.ts";
import { listRuns, loadState, runDirFor, saveState, type RunState } from "./state.ts";
import { ISSUE_KEY_RE, parseTicketText, resolveTicket, sanitizeKey, TICKET_TEMPLATE, type Ticket } from "./ticket.ts";
import { Dashboard } from "./ui.ts";
import { fmtUsd } from "./util.ts";

interface Active {
	state: RunState;
	controller: AbortController;
	done: Promise<void>;
}

const SUBCOMMANDS = ["run", "resume", "approve", "status", "stop", "models", "budget", "clean", "config"];

export default function minidev(pi: ExtensionAPI) {
	// Never register inside our own subagent processes.
	if (process.env.MINIDEV_CHILD) return;

	let active: Active | undefined;

	// ── transcript rendering for pipeline log entries (not sent to the model) ──
	pi.registerEntryRenderer<LogEntry>("minidev", (entry, { expanded }, theme) => {
		const d = entry.data;
		if (!d) return undefined;
		const color =
			d.kind === "error" ? "error" : d.kind === "warn" ? "warning" : d.kind === "done" ? "success" : d.kind === "stage" ? "accent" : "toolTitle";
		const box = new Box(1, 0);
		box.addChild(new Text(`${theme.fg("dim", `minidev ${d.key}`)} ${theme.fg(color, d.title)}`, 0, 0));
		if (d.body?.trim()) {
			const always = d.kind === "plan" || d.kind === "done" || d.kind === "error" || d.kind === "warn";
			let body = d.body.trim();
			if (!expanded && !always) {
				const lines = body.split("\n");
				if (lines.length > 6) body = `${lines.slice(0, 6).join("\n")}\n\n*… ${lines.length - 6} more lines (Ctrl+O to expand)*`;
			}
			box.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
		}
		return box;
	});

	pi.on("session_shutdown", () => {
		active?.controller.abort();
	});

	// ── helpers ──────────────────────────────────────────────────────────────

	async function repoOrFail(ctx: ExtensionContext): Promise<string | undefined> {
		const root = await mainRepoRoot(ctx.cwd);
		if (!root) ctx.ui.notify("minidev: run pi inside the git repository you want to change", "error");
		return root ?? undefined;
	}

	/** Starts a run in the background. Headless (pi -p / json) callers await the returned promise. */
	function start(state: RunState, ctx: ExtensionContext): Promise<void> {
		const controller = new AbortController();
		const dash = new Dashboard(ctx);
		const pipeline = new Pipeline(state, { pi, ctx, dash, signal: controller.signal });
		const done = pipeline.run().finally(() => {
			if (active?.state === state) active = undefined;
		});
		active = { state, controller, done };
		return done;
	}

	async function intake(arg: string, ctx: ExtensionCommandContext): Promise<Ticket | undefined> {
		const a = arg.trim();
		if (a) {
			const t = await resolveTicket(a);
			if (t) return t;
		}
		if (!ctx.hasUI) {
			if (!a) return undefined;
			return { ...parseTicketText(a), source: "inline" };
		}
		let prefill: string;
		if (ISSUE_KEY_RE.test(a)) {
			ctx.ui.notify(`No ticket source for ${a} yet — paste the ticket details`, "info");
			prefill = TICKET_TEMPLATE(a);
		} else if (a) {
			prefill = TICKET_TEMPLATE().replace("Title: ", `Title: ${a}`);
		} else {
			prefill = TICKET_TEMPLATE();
		}
		const text = await ctx.ui.editor("Ticket details (Key optional, Title required)", prefill);
		if (!text?.trim()) return undefined;
		const parsed = parseTicketText(text);
		if (!parsed.body && !parsed.title) return undefined;
		return { ...parsed, source: "manual" };
	}

	async function cmdRun(arg: string, ctx: ExtensionCommandContext): Promise<void> {
		if (active) return ctx.ui.notify(`minidev: ${active.state.key} is running — /minidev stop first`, "warning");
		const repoRoot = await repoOrFail(ctx);
		if (!repoRoot) return;
		const ticket = await intake(arg, ctx);
		if (!ticket) return ctx.ui.notify("minidev: no ticket given", "warning");
		ticket.key = sanitizeKey(ticket.key);

		const cfg = loadConfig(repoRoot);
		const repoName = path.basename(repoRoot);
		const runDir = runDirFor(cfg.runsDir, repoName, ticket.key);
		const existing = loadState(runDir);
		if (existing) {
			const pick = ctx.hasUI
				? await ctx.ui.select(`A run for ${ticket.key} exists (${existing.status} at ${existing.stage})`, ["Resume it", "Cancel"])
				: "Resume it";
			if (pick === "Resume it") return resume(existing, ctx);
			return;
		}
		const now = Date.now();
		const state: RunState = {
			version: 1,
			key: ticket.key,
			title: ticket.title,
			ticket,
			repoRoot,
			repoName,
			runDir,
			stage: "workspace",
			completed: [],
			status: "running",
			budgetUsd: cfg.budget.maxUsdPerRun,
			costUsd: 0,
			subtasks: [],
			agentRuns: [],
			checks: [],
			reviewRounds: 0,
			fixRounds: 0,
			createdAt: now,
			updatedAt: now,
		};
		saveState(state);
		const models = ROLES.map((r) => `${r}=${effectiveModel(state, cfg, r).model.replace(/^openrouter\//, "")}`).join(" · ");
		ctx.ui.notify(`minidev ${state.key}: "${state.title}" · budget ${fmtUsd(state.budgetUsd)}\n${models}`, "info");
		const done = start(state, ctx);
		if (!ctx.hasUI) await done;
	}

	async function resume(state: RunState, ctx: ExtensionContext): Promise<void> {
		if (active) return ctx.ui.notify(`minidev: ${active.state.key} is running`, "warning");
		if (state.status === "done") return ctx.ui.notify(`minidev: ${state.key} is already done${state.prUrl ? ` (${state.prUrl})` : ""}`, "info");
		if (state.costUsd >= state.budgetUsd) {
			return ctx.ui.notify(`minidev: ${state.key} spent ${fmtUsd(state.costUsd)} of ${fmtUsd(state.budgetUsd)} — raise with /minidev budget <usd> ${state.key}`, "warning");
		}
		const done = start(state, ctx);
		if (!ctx.hasUI) await done;
	}

	async function pickRun(arg: string, ctx: ExtensionCommandContext, filter?: (s: RunState) => boolean): Promise<RunState | undefined> {
		const repoRoot = await repoOrFail(ctx);
		if (!repoRoot) return undefined;
		const cfg = loadConfig(repoRoot);
		const runs = listRuns(cfg.runsDir, path.basename(repoRoot)).filter(filter ?? (() => true));
		if (arg) {
			const found = runs.find((r) => r.key === arg) ?? loadState(runDirFor(cfg.runsDir, path.basename(repoRoot), sanitizeKey(arg)));
			if (!found) ctx.ui.notify(`minidev: no run ${arg}`, "error");
			return found;
		}
		if (!runs.length) {
			ctx.ui.notify("minidev: no runs for this repo", "info");
			return undefined;
		}
		if (runs.length === 1 || !ctx.hasUI) return runs[0];
		const labels = runs.map((r) => `${r.key} · ${r.status} @ ${r.stage} · ${fmtUsd(r.costUsd)} · ${r.title}`);
		const pick = await ctx.ui.select("Select run", labels);
		return pick ? runs[labels.indexOf(pick)] : undefined;
	}

	function parseModelRef(ref: string, ctx: ExtensionContext): RoleModel | undefined {
		let thinking: Thinking | undefined;
		const m = /^(.*?):(off|minimal|low|medium|high|xhigh|max)$/.exec(ref.trim());
		let id = ref.trim();
		if (m) {
			id = m[1];
			thinking = m[2] as Thinking;
		}
		const available = ctx.modelRegistry.getAvailable();
		const exact = available.find((x) => `${x.provider}/${x.id}` === id) ?? available.find((x) => x.id === id);
		if (!exact) return undefined;
		return { model: `${exact.provider}/${exact.id}`, thinking };
	}

	async function cmdModels(arg: string, ctx: ExtensionCommandContext): Promise<void> {
		const repoRoot = (await mainRepoRoot(ctx.cwd)) ?? undefined;
		const cfg = loadConfig(repoRoot);
		const runState = active?.state;
		const table = ROLES.map((r) => {
			const m = effectiveModel(runState, cfg, r);
			return `${r.padEnd(9)} ${m.model}${m.thinking ? `:${m.thinking}` : ""}${runState?.modelOverrides?.[r] ? " (this run)" : ""}`;
		}).join("\n");

		const [roleArg, refArg] = arg.split(/\s+/).filter(Boolean);
		if (roleArg && refArg) {
			if (!ROLES.includes(roleArg as Role)) return ctx.ui.notify(`Unknown role ${roleArg}. Roles: ${ROLES.join(", ")}`, "error");
			const rm = parseModelRef(refArg, ctx);
			if (!rm) return ctx.ui.notify(`Model not found or no credentials: ${refArg}`, "error");
			saveUserConfig({ models: { [roleArg]: rm } });
			return ctx.ui.notify(`minidev: ${roleArg} → ${rm.model}${rm.thinking ? `:${rm.thinking}` : ""} (saved to ${USER_CONFIG})`, "info");
		}
		if (!ctx.hasUI) return ctx.ui.notify(table, "info");

		const role = (await ctx.ui.select(`minidev models\n${table}\n\nChange which role?`, [...ROLES])) as Role | undefined;
		if (!role) return;
		const current = effectiveModel(runState, cfg, role);
		const known = [...new Set([...ROLES.map((r) => cfg.models[r].model), current.model])];
		const choice = await ctx.ui.select(`Model for ${role} (now ${current.model})`, [...known, "Browse all available…", "Type a model id…"]);
		if (!choice) return;
		let modelRef: string | undefined = choice;
		if (choice === "Browse all available…") {
			const all = ctx.modelRegistry
				.getAvailable()
				.map((x) => `${x.provider}/${x.id}`)
				.sort();
			modelRef = await ctx.ui.select(`All available models (${all.length})`, all);
		} else if (choice === "Type a model id…") {
			modelRef = await ctx.ui.input("Model id", "openrouter/vendor/model");
		}
		if (!modelRef) return;
		const rm = parseModelRef(modelRef, ctx);
		if (!rm) return ctx.ui.notify(`Model not found or no credentials: ${modelRef}`, "error");
		const thinking = await ctx.ui.select(`Thinking level for ${role}`, [...THINKING_LEVELS]);
		if (thinking) rm.thinking = thinking as Thinking;

		const scopes = runState ? [`This run only (${runState.key})`, "Save as default"] : ["Save as default"];
		const scope = scopes.length > 1 ? await ctx.ui.select("Apply to", scopes) : scopes[0];
		if (!scope) return;
		if (scope.startsWith("This run") && runState) {
			runState.modelOverrides = { ...(runState.modelOverrides ?? {}), [role]: rm };
			saveState(runState);
		} else {
			saveUserConfig({ models: { [role]: rm } });
		}
		ctx.ui.notify(`minidev: ${role} → ${rm.model}${rm.thinking ? `:${rm.thinking}` : ""} (applies from the next ${role} call)`, "info");
	}

	async function cmdBudget(arg: string, ctx: ExtensionCommandContext): Promise<void> {
		const [amount, target] = arg.split(/\s+/).filter(Boolean);
		const usd = Number(amount);
		if (!amount || !Number.isFinite(usd) || usd <= 0) {
			const cfg = loadConfig((await mainRepoRoot(ctx.cwd)) ?? undefined);
			const cur = active ? `\nactive ${active.state.key}: ${fmtUsd(active.state.costUsd)} / ${fmtUsd(active.state.budgetUsd)}` : "";
			return ctx.ui.notify(`minidev budget: default ${fmtUsd(cfg.budget.maxUsdPerRun)} per run${cur}\nUsage: /minidev budget <usd> [KEY|default]`, "info");
		}
		if (target === "default") {
			saveUserConfig({ budget: { maxUsdPerRun: usd } });
			return ctx.ui.notify(`minidev: default budget ${fmtUsd(usd)} per run`, "info");
		}
		const state = target ? (active?.state.key === target ? active.state : await pickRun(target, ctx)) : (active?.state ?? (await pickRun("", ctx)));
		if (!state) return;
		state.budgetUsd = usd;
		saveState(state);
		ctx.ui.notify(`minidev: ${state.key} budget ${fmtUsd(usd)} (spent ${fmtUsd(state.costUsd)})`, "info");
	}

	async function cmdStatus(ctx: ExtensionCommandContext): Promise<void> {
		const repoRoot = await repoOrFail(ctx);
		if (!repoRoot) return;
		const cfg = loadConfig(repoRoot);
		const runs = listRuns(cfg.runsDir, path.basename(repoRoot));
		if (!runs.length) return ctx.ui.notify("minidev: no runs for this repo", "info");
		const lines = runs.map((r) => {
			const done = r.subtasks.filter((t) => t.status === "done").length;
			return `${active?.state.key === r.key ? "▶ " : ""}${r.key} · ${r.status}${r.pauseReason ? ` (${r.pauseReason})` : ""} @ ${r.stage} · ${done}/${r.subtasks.length} subtasks · ${fmtUsd(r.costUsd)}/${fmtUsd(r.budgetUsd)}${r.prUrl ? ` · ${r.prUrl}` : ""}\n   ${r.title}`;
		});
		pi.appendEntry<LogEntry>("minidev", { key: path.basename(repoRoot), kind: "info", title: `${runs.length} run(s)`, body: lines.map((l) => `- ${l}`).join("\n") });
	}

	// ── commands ─────────────────────────────────────────────────────────────

	pi.registerCommand("minidev", {
		description: "Ticket → PR pipeline: run | resume | approve | status | stop | models | budget | clean | config",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) return SUBCOMMANDS.filter((s) => s.startsWith(parts[0] ?? "")).map((s) => ({ value: s, label: s }));
			if (parts[0] === "models" && parts.length === 2) return ROLES.filter((r) => r.startsWith(parts[1])).map((r) => ({ value: `models ${r}`, label: r }));
			return null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const sp = trimmed.indexOf(" ");
			const sub = (sp < 0 ? trimmed : trimmed.slice(0, sp)) || "run";
			const rest = sp < 0 ? "" : trimmed.slice(sp + 1).trim();
			switch (sub) {
				case "run":
					return cmdRun(rest, ctx);
				case "resume": {
					const s = await pickRun(rest, ctx, (r) => r.status !== "done");
					if (s) await resume(s, ctx);
					return;
				}
				case "approve": {
					const s = await pickRun(rest, ctx, (r) => r.status === "paused" && /approval/.test(r.pauseReason ?? ""));
					if (!s) return;
					if (/plan/.test(s.pauseReason ?? "")) s.planApproved = true;
					else if (/PR/.test(s.pauseReason ?? "")) s.prApproved = true;
					else return ctx.ui.notify(`minidev: ${s.key} is not waiting for approval`, "info");
					saveState(s);
					return resume(s, ctx);
				}
				case "status":
					return cmdStatus(ctx);
				case "stop":
					if (!active) return ctx.ui.notify("minidev: nothing running", "info");
					ctx.ui.notify(`minidev: stopping ${active.state.key}…`, "info");
					active.controller.abort();
					await active.done;
					return;
				case "models":
					return cmdModels(rest, ctx);
				case "budget":
					return cmdBudget(rest, ctx);
				case "clean": {
					const s = await pickRun(rest, ctx);
					if (!s) return;
					if (active?.state.key === s.key) return ctx.ui.notify("minidev: stop the run first", "warning");
					if (ctx.hasUI && !(await ctx.ui.confirm("Remove worktree?", `${s.worktree}\n(branch ${s.branch} and run artifacts are kept)`))) return;
					await removeWorktree(s);
					s.worktree = undefined;
					s.completed = s.completed.filter((x) => x !== "workspace");
					saveState(s);
					return ctx.ui.notify(`minidev: removed worktree for ${s.key}`, "info");
				}
				case "config": {
					const repoRoot = (await mainRepoRoot(ctx.cwd)) ?? undefined;
					pi.appendEntry<LogEntry>("minidev", {
						key: "config",
						kind: "info",
						title: `effective config (defaults ← ${USER_CONFIG}${repoRoot ? ` ← ${path.join(repoRoot, PROJECT_CONFIG)}` : ""})`,
						body: `\`\`\`json\n${JSON.stringify(loadConfig(repoRoot), null, 2)}\n\`\`\``,
					});
					return;
				}
				default:
					// `/minidev ABC-123` or `/minidev some title` → run
					return cmdRun(trimmed, ctx);
			}
		},
	});

	pi.registerCommand("ticket", {
		description: "minidev: start a ticket → PR run (alias for /minidev run)",
		handler: (args, ctx) => cmdRun(args, ctx),
	});
}
