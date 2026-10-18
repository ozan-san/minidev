import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deepMerge, ensureDir, expandHome } from "./util.ts";

export const ROLES = ["scout", "planner", "builder", "tester", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];

export interface RoleModel {
	/** Model reference as accepted by `pi --model`, e.g. "openrouter/deepseek/deepseek-v4.1-flash". */
	model: string;
	thinking?: Thinking;
	/** Optional cap for a single invocation of this role. */
	maxUsdPerCall?: number;
}

export interface Check {
	name: string;
	/** Shell command, run with bash -lc in the worktree. */
	command: string;
	/** Failing a non-blocking check is reported but does not trigger fixes or stop the run. */
	blocking?: boolean;
	/** "hasTests": only run when the repo contains unit tests (pattern depends on the detected stack). */
	when?: "always" | "hasTests";
	timeoutSec?: number;
}

export type StackSetting = "auto" | "android" | "ios" | "typescript" | "generic";

/** When the run panel is dismissed automatically: after a successful run ("done"), after any run that ends ("terminal"), or never ("never"). */
export type UiDismiss = "done" | "terminal" | "never";

export interface ChecksConfig {
	/** Run after every builder subtask. Failures are fed back to the builder. */
	subtask?: Check[];
	/** Run after testing and after review fixes. */
	final?: Check[];
}

export interface Config {
	/** Project mode. "auto" explores the repo at the start of a run (see stack.ts). */
	stack: StackSetting;
	models: Record<Role, RoleModel>;
	budget: {
		/** Hard cap for one ticket run (all agents). The run pauses when reached. */
		maxUsdPerRun: number;
		/** Warn when this fraction of the budget is spent. */
		warnAt: number;
	};
	gates: {
		/** Ask for approval after planning. */
		plan: boolean;
		/** Ask for approval before pushing / opening the PR. */
		pr: boolean;
	};
	git: {
		remote: string;
		/** Base branch; detected from <remote>/HEAD when empty. */
		baseBranch: string;
		fetch: boolean;
		/** Placeholders: {key} {slug} {type} */
		branchTemplate: string;
		/** Placeholders: {key} {title} */
		commitTemplate: string;
		/** Placeholders: {key} {id} {title} */
		subtaskCommitTemplate: string;
		commitPerSubtask: boolean;
		/** Worktrees go to <worktreeRoot>/<repoName>/<key>. */
		worktreeRoot: string;
		/** Untracked files copied from the main checkout into the worktree (e.g. Android local.properties). */
		copyIntoWorktree: string[];
	};
	pr: {
		push: boolean;
		/**
		 * Command that opens the PR after pushing. "auto" = gh (GitHub) / glab (GitLab) if installed,
		 * "" = push only. Placeholders (shell-quoted): {title} {bodyFile} {base} {branch} {remote} {draft}
		 */
		command: string;
		/** Open the PR as a draft instead of ready for review. Default: false. */
		draft: boolean;
	};
	/**
	 * Explicit checks — override everything detected. Usually set per repo in .minidev.json.
	 * Leave unset to use stack detection (or `stacks.<id>.checks`).
	 */
	checks?: ChecksConfig;
	/** Explicit setup commands for a fresh worktree (dependency install, project generation). */
	setup?: string[];
	/** Per-stack overrides, handy in ~/.minidev/config.json (e.g. your usual Gradle tasks). */
	stacks?: Partial<Record<Exclude<StackSetting, "auto">, { checks?: ChecksConfig; setup?: string[] }>>;
	tests: {
		/** Whether the tester agent writes new unit tests. "auto": only if the repo already has unit tests (stack-aware). */
		write: "auto" | "always" | "never";
	};
	durable: {
		/** Replay settled successful agent submissions when a run is resumed. */
		replay: "safe" | "off";
	};
	ui: {
		/** See UiDismiss. "done" (default) removes the panel when a run succeeds; paused/failed runs keep it so you can resume. */
		dismissOn: UiDismiss;
	};
	limits: {
		maxSubtasks: number;
		/** Builder attempts per subtask (incl. retries after failed subtask checks). */
		subtaskAttempts: number;
		/** Fix rounds after failing final checks. */
		fixRounds: number;
		/** Review → fix rounds. */
		reviewRounds: number;
	};
	/** Where run artifacts (ticket, plan, logs, transcripts, state) are stored. */
	runsDir: string;
}

export const DEFAULT_CONFIG: Config = {
	stack: "auto",
	models: {
		scout: { model: "openrouter/deepseek/deepseek-v4.1-flash", thinking: "medium" },
		planner: { model: "openrouter/anthropic/claude-opus-5.5", thinking: "high" },
		builder: { model: "openrouter/deepseek/deepseek-v4.1-flash", thinking: "high" },
		tester: { model: "openrouter/deepseek/deepseek-v4.1-flash", thinking: "high" },
		reviewer: { model: "openrouter/anthropic/claude-opus-5.5", thinking: "medium" },
	},
	budget: { maxUsdPerRun: 10, warnAt: 0.8 },
	gates: { plan: true, pr: true },
	git: {
		remote: "origin",
		baseBranch: "",
		fetch: true,
		branchTemplate: "{type}/{key}-{slug}",
		commitTemplate: "{key}: {title}",
		subtaskCommitTemplate: "{key}: {title}",
		commitPerSubtask: true,
		worktreeRoot: "~/.minidev/worktrees",
		copyIntoWorktree: ["local.properties", ".env", ".env.local", "Config/Secrets.xcconfig"],
	},
	pr: { push: true, command: "auto", draft: false },
	tests: { write: "auto" },
	durable: { replay: "safe" },
	ui: { dismissOn: "done" },
	limits: { maxSubtasks: 12, subtaskAttempts: 3, fixRounds: 3, reviewRounds: 1 },
	runsDir: "~/.minidev/runs",
};

export const USER_DIR = path.join(os.homedir(), ".minidev");
export const USER_CONFIG = path.join(USER_DIR, "config.json");
export const PROJECT_CONFIG = ".minidev.json";

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Invalid JSON in ${file}: ${(err as Error).message}`);
	}
}

/** defaults ← ~/.minidev/config.json ← <repo>/.minidev.json */
export function loadConfig(repoRoot?: string): Config {
	let cfg = deepMerge(DEFAULT_CONFIG, readJson(USER_CONFIG));
	if (repoRoot) cfg = deepMerge(cfg, readJson(path.join(repoRoot, PROJECT_CONFIG)));
	cfg.runsDir = expandHome(cfg.runsDir);
	cfg.git.worktreeRoot = expandHome(cfg.git.worktreeRoot);
	return cfg;
}

/** Patch the user config file (deep-merged into what is already there). */
export function saveUserConfig(patch: unknown): void {
	const current = (readJson(USER_CONFIG) as object | undefined) ?? {};
	ensureDir(USER_DIR);
	fs.writeFileSync(USER_CONFIG, `${JSON.stringify(deepMerge(current, patch), null, 2)}\n`);
}
