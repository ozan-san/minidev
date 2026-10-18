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

/** True if the worktree tracks JVM unit tests (src/test/...). */
export async function hasUnitTests(wt: string): Promise<boolean> {
	const files = (await gitTry(wt, ["ls-files"])) ?? "";
	return /(^|\/)src\/test(?:[A-Z]\w*)?\//m.test(files);
}
