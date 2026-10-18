import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { decideToolCall, type GuardScope } from "./agent-guard.ts";

const scope: GuardScope = { root: path.join(path.sep, "work", "repo"), tmp: [path.join(path.sep, "tmp")] };

describe("bash guard", () => {
	test("blocks git history/branch mutations", () => {
		for (const command of ["git push", "git commit -m x", "git worktree add ../x", "git -C /w checkout main", "git reset --hard"]) {
			const block = decideToolCall("bash", { command }, undefined);
			assert.ok(block, `expected ${command} to be blocked`);
			assert.match(block.block, /git history\/branch operations/);
		}
	});

	test("allows read-only git", () => {
		assert.equal(decideToolCall("bash", { command: "git status" }, undefined), undefined);
		assert.equal(decideToolCall("bash", { command: "git diff HEAD" }, undefined), undefined);
		assert.equal(decideToolCall("bash", { command: "git log --oneline" }, undefined), undefined);
	});

	test("blocks potentially destructive shell commands", () => {
		for (const command of ["sudo rm -rf /", "rm -rf /", "rm -rf ~", "gh pr create", "glab mr create", "gh release create"]) {
			assert.ok(decideToolCall("bash", { command }, undefined), `expected ${command} to be blocked`);
		}
	});

	test("allows ordinary shell commands", () => {
		assert.equal(decideToolCall("bash", { command: "ls -la" }, undefined), undefined);
		assert.equal(decideToolCall("bash", { command: "rm -rf node_modules" }, undefined), undefined);
	});
});

describe("write/edit scope guard", () => {
	test("blocks writes outside the worktree", () => {
		for (const p of ["/etc/passwd", path.join(scope.root, "..", "escape.ts"), "~/secrets.txt"]) {
			const block = decideToolCall("write", { path: p }, scope);
			assert.ok(block, `expected write to ${p} to be blocked`);
			assert.match(block.block, /writes are restricted to the worktree/);
		}
	});

	test("allows writes inside the worktree root and tmp", () => {
		assert.equal(decideToolCall("write", { path: path.join(scope.root, "a.ts") }, scope), undefined);
		assert.equal(decideToolCall("write", { path: "src/nested/a.ts" }, scope), undefined);
		assert.equal(decideToolCall("write", { path: path.join(scope.root) }, scope), undefined);
		assert.equal(decideToolCall("write", { path: path.join(path.sep, "tmp", "x") }, scope), undefined);
	});

	test("applies the same rules to edit", () => {
		assert.ok(decideToolCall("edit", { path: "/etc/passwd" }, scope));
		assert.equal(decideToolCall("edit", { path: path.join(scope.root, "a.ts") }, scope), undefined);
	});

	test("does not block when the scope or its root is missing", () => {
		assert.equal(decideToolCall("write", { path: "/etc/passwd" }, undefined), undefined);
		assert.equal(decideToolCall("write", { path: "/etc/passwd" }, { root: "", tmp: [] }), undefined);
	});

	test("ignores write/edit without a usable path", () => {
		assert.equal(decideToolCall("write", {}, scope), undefined);
		assert.equal(decideToolCall("write", { path: 42 }, scope), undefined);
	});

	test("~ resolves against the home directory", () => {
		const home = os.homedir();
		const insideHome: GuardScope = { root: home, tmp: [] };
		assert.equal(decideToolCall("write", { path: "~/inside.txt" }, insideHome), undefined);
	});
});
