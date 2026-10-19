import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { checkoutPlan, pushesInPlace, type CheckoutInput } from "./git.ts";

function makeInput(over: Partial<CheckoutInput> = {}): CheckoutInput {
	return {
		inPlace: false,
		repoRoot: "/repo",
		worktreeRoot: "/wt",
		repoName: "repo",
		key: "MD-1",
		branch: "feat/md-1",
		base: "main",
		baseRef: "origin/main",
		currentBranch: "",
		headSha: "",
		...over,
	};
}

describe("checkoutPlan", () => {
	test("worktree mode returns the worktree path and passes branch/base/baseRef through", () => {
		const plan = checkoutPlan(makeInput());
		assert.deepEqual(plan, {
			mode: "worktree",
			cwd: path.join("/wt", "repo", "MD-1"),
			branch: "feat/md-1",
			base: "main",
			baseRef: "origin/main",
		});
	});

	test("in-place mode works in the repo root on the current branch from HEAD", () => {
		const plan = checkoutPlan(
			makeInput({ inPlace: true, branch: "", base: "release/2.x", baseRef: "", currentBranch: "feat/x", headSha: "abc123" }),
		);
		assert.deepEqual(plan, {
			mode: "in-place",
			cwd: "/repo",
			branch: "feat/x",
			base: "release/2.x",
			baseRef: "abc123",
		});
	});

	test("in-place mode throws when no branch is checked out", () => {
		assert.throws(() => checkoutPlan(makeInput({ inPlace: true, headSha: "abc123" })), /checked-out branch/);
	});

	test("in-place mode throws when HEAD cannot be resolved", () => {
		assert.throws(() => checkoutPlan(makeInput({ inPlace: true, currentBranch: "feat/x" })), /HEAD/);
	});
});

describe("pushesInPlace", () => {
	test("feature branches off the base push and open a PR", () => {
		assert.equal(pushesInPlace("feat/x", "main"), true);
	});

	test("the base branch itself is never pushed", () => {
		assert.equal(pushesInPlace("main", "main"), false);
	});

	test("a local base name differing from the remote-tracking ref still pushes", () => {
		assert.equal(pushesInPlace("main", "origin/main"), true);
	});

	test("the repository's default branch is never pushed even when the PR target differs", () => {
		assert.equal(pushesInPlace("main", "develop", "main"), false);
		assert.equal(pushesInPlace("master", "develop", "main"), true);
	});
});
