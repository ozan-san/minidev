import * as fs from "node:fs";
import * as path from "node:path";
import { exec, git, gitTry } from "./util.ts";

export async function repoRoot(cwd: string): Promise<string | null> {
	return gitTry(cwd, ["rev-parse", "--show-toplevel"]);
}

/** Main checkout root even when cwd is inside a linked worktree. */
export async function mainRepoRoot(cwd: string): Promise<string | null> {
	const common = await gitTry(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (!common) return null;
	return path.basename(common) === ".git" ? path.dirname(common) : await repoRoot(cwd);
}

export async function detectBase(repo: string, remote: string, configured: string): Promise<string> {
	if (configured) return configured;
	const head = await gitTry(repo, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
	if (head) return head.replace(`${remote}/`, "");
	for (const b of ["main", "master", "develop"]) {
		if (await gitTry(repo, ["rev-parse", "--verify", "--quiet", b])) return b;
	}
	return (await gitTry(repo, ["branch", "--show-current"])) || "main";
}

export async function remoteUrl(repo: string, remote: string): Promise<string | null> {
	return gitTry(repo, ["remote", "get-url", remote]);
}

export async function fetchRemote(repo: string, remote: string, base: string): Promise<boolean> {
	const r = await exec("git", ["fetch", remote, base], { cwd: repo, timeoutMs: 120_000 });
	return r.code === 0;
}

/** Ref to branch from: "<remote>/<base>" if it exists, else the local base. */
export async function resolveBaseRef(repo: string, remote: string, base: string): Promise<string> {
	if (await gitTry(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${base}`])) return `${remote}/${base}`;
	if (await gitTry(repo, ["rev-parse", "--verify", "--quiet", base])) return base;
	throw new Error(`Base branch "${base}" not found locally or on ${remote}. Set git.baseBranch in .minidev.json.`);
}

// ── checkout planning ──

/** Everything the run knows about the repository before it decides where to work. */
export interface CheckoutInput {
	inPlace: boolean;
	repoRoot: string;
	worktreeRoot: string;
	repoName: string;
	key: string;
	/** Feature branch to create/use (worktree mode only). */
	branch: string;
	/** Base branch name, e.g. "main" (per-run --branch/--base, else git.baseBranch, else detected). */
	base: string;
	/** Ref for `base` ("origin/main" or "main"); worktree mode only. */
	baseRef: string;
	/** Branch checked out in the main checkout; "" when detached. In-place only. */
	currentBranch: string;
	/** HEAD sha of the main checkout. In-place only. */
	headSha: string;
}

/** Where a run works and which branch/ref it uses. Pure decision, no I/O. */
export interface CheckoutPlan {
	mode: "worktree" | "in-place";
	/** Directory every agent, check and commit runs in. */
	cwd: string;
	/** Branch the run commits to and (when it differs from `base`) pushes. */
	branch: string;
	/** Base branch name used as the PR target. */
	base: string;
	/** Ref the run's work is diffed against. */
	baseRef: string;
}

/** Decide worktree vs in-place and the branch/ref the run uses. Throws when in-place cannot be honoured. */
export function checkoutPlan(o: CheckoutInput): CheckoutPlan {
	if (!o.inPlace) {
		return { mode: "worktree", cwd: path.join(o.worktreeRoot, o.repoName, o.key), branch: o.branch, base: o.base, baseRef: o.baseRef };
	}
	if (!o.currentBranch) throw new Error("in-place runs need a checked-out branch: run `git switch <branch>` (or use --worktree) first");
	if (!o.headSha) throw new Error(`in-place run: could not resolve HEAD in ${o.repoRoot}`);
	return { mode: "in-place", cwd: o.repoRoot, branch: o.currentBranch, base: o.base, baseRef: o.headSha };
}

/** Local branch of a checkout; null when HEAD is detached. */
export async function currentBranch(repo: string): Promise<string | null> {
	const b = await gitTry(repo, ["branch", "--show-current"]);
	return b || null;
}

/** Full sha of HEAD. */
export async function headSha(repo: string): Promise<string | null> {
	return gitTry(repo, ["rev-parse", "HEAD"]);
}

/** In-place runs push (and open a PR) only off the base branch — never straight onto it. */
export function pushesInPlace(branch: string, base: string): boolean {
	return branch !== base;
}

export async function ensureWorktree(repo: string, wt: string, branch: string, baseRef: string): Promise<"created" | "reused"> {
	if (fs.existsSync(path.join(wt, ".git"))) {
		const current = await gitTry(wt, ["branch", "--show-current"]);
		if (current !== branch) throw new Error(`Worktree ${wt} exists but is on "${current}", expected "${branch}"`);
		return "reused";
	}
	fs.mkdirSync(path.dirname(wt), { recursive: true });
	await gitTry(repo, ["worktree", "prune"]);
	const branchExists = await gitTry(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
	if (branchExists) await git(repo, ["worktree", "add", wt, branch]);
	else await git(repo, ["worktree", "add", "-b", branch, wt, baseRef]);
	return "created";
}

/** Copy untracked-but-needed files (local.properties, …) from the main checkout. */
export function copyIntoWorktree(repo: string, wt: string, files: string[]): string[] {
	const copied: string[] = [];
	for (const rel of files) {
		const src = path.join(repo, rel);
		const dst = path.join(wt, rel);
		if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
		fs.mkdirSync(path.dirname(dst), { recursive: true });
		fs.cpSync(src, dst, { recursive: true });
		copied.push(rel);
	}
	return copied;
}

/** Stage everything and commit. Returns the new sha or null if there was nothing to commit. */
export async function commitAll(wt: string, message: string): Promise<string | null> {
	await git(wt, ["add", "-A"]);
	const clean = await exec("git", ["diff", "--cached", "--quiet"], { cwd: wt });
	if (clean.code === 0) return null;
	await git(wt, ["commit", "-q", "-m", message]);
	return git(wt, ["rev-parse", "--short", "HEAD"]);
}

export async function hasChanges(wt: string): Promise<boolean> {
	return ((await gitTry(wt, ["status", "--porcelain"])) ?? "").length > 0;
}

export async function diffStat(wt: string, baseRef: string): Promise<string> {
	return (await gitTry(wt, ["diff", "--stat", `${baseRef}...HEAD`])) ?? "";
}

export async function commitLog(wt: string, baseRef: string): Promise<string> {
	return (await gitTry(wt, ["log", "--oneline", `${baseRef}..HEAD`])) ?? "";
}

export async function push(wt: string, remote: string, branch: string): Promise<void> {
	const r = await exec("git", ["push", "-u", remote, branch], { cwd: wt, timeoutMs: 300_000 });
	if (r.code !== 0) throw new Error(`git push failed: ${(r.stderr || r.stdout).trim()}`);
}
