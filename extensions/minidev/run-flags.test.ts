import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseRunFlags } from "./run-flags.ts";

describe("parseRunFlags", () => {
	test("no flags passes the ticket argument through", () => {
		const flags = parseRunFlags("MD-1");
		assert.equal(flags.inPlace, undefined);
		assert.equal(flags.baseBranch, undefined);
		assert.equal(flags.ticketArg, "MD-1");
		assert.deepEqual(flags.unknown, []);
	});

	test("--in-place sets inPlace true and leaves the title", () => {
		const flags = parseRunFlags("--in-place Fix the flaky test");
		assert.equal(flags.inPlace, true);
		assert.equal(flags.baseBranch, undefined);
		assert.equal(flags.ticketArg, "Fix the flaky test");
		assert.deepEqual(flags.unknown, []);
	});

	test("--worktree sets inPlace false", () => {
		const flags = parseRunFlags("--worktree MD-2");
		assert.equal(flags.inPlace, false);
		assert.equal(flags.baseBranch, undefined);
		assert.equal(flags.ticketArg, "MD-2");
		assert.deepEqual(flags.unknown, []);
	});

	test("the last mode flag wins", () => {
		const flags = parseRunFlags("--in-place --worktree Fix it");
		assert.equal(flags.inPlace, false);
		assert.equal(flags.ticketArg, "Fix it");
	});

	test("--branch with a separate value", () => {
		const flags = parseRunFlags("--branch release/2.x MD-1");
		assert.equal(flags.baseBranch, "release/2.x");
		assert.equal(flags.ticketArg, "MD-1");
	});

	test("--branch=value inline form", () => {
		const flags = parseRunFlags("--branch=main --worktree MD-2");
		assert.deepEqual(flags, { inPlace: false, baseBranch: "main", ticketArg: "MD-2", unknown: [] });
	});

	test("--base with a separate value", () => {
		const flags = parseRunFlags("--base develop MD-1");
		assert.equal(flags.baseBranch, "develop");
		assert.equal(flags.ticketArg, "MD-1");
	});

	test("--base=value inline form", () => {
		const flags = parseRunFlags("--base=main MD-1");
		assert.equal(flags.baseBranch, "main");
		assert.equal(flags.ticketArg, "MD-1");
	});

	test("value-less --branch is unknown and the next token stays in the ticket argument", () => {
		const flags = parseRunFlags("--branch");
		assert.deepEqual(flags.unknown, ["--branch"]);
		assert.equal(flags.baseBranch, undefined);
		assert.equal(flags.ticketArg, "");

		const followed = parseRunFlags("--branch MD-1");
		assert.deepEqual(followed.unknown, []);
		assert.equal(followed.baseBranch, "MD-1");
		assert.equal(followed.ticketArg, "");
	});

	test("--branch followed by another flag is unknown and the flag is parsed", () => {
		const flags = parseRunFlags("--branch --in-place MD-1");
		assert.deepEqual(flags.unknown, ["--branch"]);
		assert.equal(flags.inPlace, true);
		assert.equal(flags.baseBranch, undefined);
		assert.equal(flags.ticketArg, "MD-1");
	});

	test("unknown flags are collected and stripped from the ticket argument", () => {
		const flags = parseRunFlags("--bogus X");
		assert.deepEqual(flags.unknown, ["--bogus"]);
		assert.equal(flags.ticketArg, "X");
	});

	test("multi-word titles are joined with single spaces", () => {
		assert.equal(parseRunFlags("Fix   the\nflaky   test").ticketArg, "Fix the flaky test");
	});

	test("a non-leading dash word stays in the ticket argument", () => {
		assert.equal(parseRunFlags("run-fix").ticketArg, "run-fix");
	});

	test("an empty string yields no ticket argument and no flags", () => {
		const flags = parseRunFlags("");
		assert.equal(flags.inPlace, undefined);
		assert.equal(flags.baseBranch, undefined);
		assert.equal(flags.ticketArg, "");
		assert.deepEqual(flags.unknown, []);
	});
});
