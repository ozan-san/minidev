import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extractErrors, failuresReport, runChecks, type CheckResult } from "./checks.ts";
import type { Check } from "./config.ts";

describe("extractErrors", () => {
	test("picks known error lines and ignores ordinary ones", () => {
		const output = [
			"e: file.kt:1 x",
			"src/a.ts(1,2): error TS2322",
			"FAILURE: Build failed",
			"* What went wrong",
			"> Task :app:test FAILED",
			"java.lang.NullPointerException",
			"    at com.foo.Test",
			"Downloading dependencies",
		].join("\n");
		const errors = extractErrors(output).split("\n");
		assert.deepEqual(errors, [
			"e: file.kt:1 x",
			"src/a.ts(1,2): error TS2322",
			"FAILURE: Build failed",
			"* What went wrong",
			"> Task :app:test FAILED",
			"java.lang.NullPointerException",
			"    at com.foo.Test",
		]);
	});

	test("caps the output at 80 lines", () => {
		const output = Array.from({ length: 100 }, () => "e: x").join("\n");
		assert.equal(extractErrors(output).split("\n").length, 80);
	});

	test("returns an empty string when nothing matches", () => {
		assert.equal(extractErrors("all good\nnothing to see"), "");
	});
});

function result(over: Partial<CheckResult>): CheckResult {
	return {
		name: "check",
		command: "cmd",
		ok: true,
		skipped: false,
		blocking: true,
		code: 0,
		timedOut: false,
		durationMs: 1,
		logPath: "/tmp/log",
		tail: "tail text",
		...over,
	};
}

describe("failuresReport", () => {
	test("includes blocking failures with exit code, command, log and tail", () => {
		const report = failuresReport([
			result({ name: "build", command: "make", ok: false, code: 3, timedOut: true, logPath: "/tmp/build.log" }),
		]);
		assert.match(report, /Check "build" failed \(exit 3, timed out\)/);
		assert.match(report, /Command: `make`/);
		assert.match(report, /Full log: \/tmp\/build\.log/);
		assert.match(report, /tail text/);
	});

	test("skips passing and non-blocking results", () => {
		const report = failuresReport([
			result({ name: "ok" }),
			result({ name: "lint", ok: false, blocking: false }),
		]);
		assert.equal(report, "");
	});
});

describe("runChecks", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minidev-checks-"));
	after(() => fs.rmSync(dir, { recursive: true, force: true }));

	test("reports a passing check as ok and writes a log", async () => {
		const logDir = fs.mkdtempSync(path.join(dir, "logs-"));
		const results = await runChecks([{ name: "noop", command: "true" }], dir, logDir, "sub", { hasTests: false });
		assert.equal(results.length, 1);
		assert.equal(results[0].ok, true);
		assert.equal(results[0].code, 0);
		const log = fs.readFileSync(results[0].logPath, "utf-8");
		assert.ok(log.startsWith("$ true\n"));
	});

	test("stops at the first blocking failure", async () => {
		const logDir = fs.mkdtempSync(path.join(dir, "logs-"));
		const checks: Check[] = [
			{ name: "fail", command: "exit 3" },
			{ name: "after", command: "true" },
		];
		const results = await runChecks(checks, dir, logDir, "sub", { hasTests: false });
		assert.equal(results.length, 1);
		assert.equal(results[0].ok, false);
		assert.equal(results[0].code, 3);
	});

	test("continues past a non-blocking failure", async () => {
		const logDir = fs.mkdtempSync(path.join(dir, "logs-"));
		const checks: Check[] = [
			{ name: "lint", command: "exit 3", blocking: false },
			{ name: "after", command: "true" },
		];
		const results = await runChecks(checks, dir, logDir, "final", { hasTests: false });
		assert.equal(results.length, 2);
		assert.equal(results[0].ok, false);
		assert.equal(results[0].blocking, false);
		assert.equal(results[1].ok, true);
	});

	test("skips hasTests checks when the repo has no tests", async () => {
		const logDir = fs.mkdtempSync(path.join(dir, "logs-"));
		const checks: Check[] = [{ name: "unit", command: "true", when: "hasTests" }];
		const results = await runChecks(checks, dir, logDir, "final", { hasTests: false });
		assert.equal(results.length, 1);
		assert.equal(results[0].skipped, true);
		assert.equal(results[0].ok, true);
	});
});
