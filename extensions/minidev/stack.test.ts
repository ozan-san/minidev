import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, type Check, type Config } from "./config.ts";
import {
	detectStack,
	effectiveChecks,
	effectiveSetup,
	applyScoutCommands,
	describeStack,
	STACK_LABELS,
	type Checks,
	type StackInfo,
} from "./stack.ts";
import { git } from "./util.ts";

function makeStack(over: Partial<StackInfo> = {}): StackInfo {
	return {
		id: "typescript",
		label: "TypeScript / JavaScript",
		signals: ["package.json"],
		alsoDetected: [],
		setup: [],
		checks: { subtask: [], final: [] },
		checksSource: "detected",
		testPattern: "\\.test\\.",
		facts: [],
		warnings: [],
		...over,
	};
}

function check(name: string, command = name): Check {
	return { name, command };
}

describe("effectiveChecks", () => {
	const stackChecks: Checks = { subtask: [check("stack-sub")], final: [check("stack-final")] };
	const perStackChecks: Checks = { subtask: [check("per-sub")], final: [check("per-final")] };
	const cfgChecks: Checks = { subtask: [check("cfg-sub")], final: [check("cfg-final")] };

	test("config checks win over stack and per-stack checks", () => {
		const cfg: Config = {
			...DEFAULT_CONFIG,
			checks: cfgChecks,
			stacks: { typescript: { checks: perStackChecks } },
		};
		assert.deepEqual(effectiveChecks(cfg, makeStack({ checks: stackChecks })), cfgChecks);
	});

	test("per-stack checks win over detected stack checks", () => {
		const cfg: Config = { ...DEFAULT_CONFIG, stacks: { typescript: { checks: perStackChecks } } };
		assert.deepEqual(effectiveChecks(cfg, makeStack({ checks: stackChecks })), perStackChecks);
	});

	test("falls back to detected stack checks", () => {
		assert.deepEqual(effectiveChecks(DEFAULT_CONFIG, makeStack({ checks: stackChecks })), stackChecks);
	});

	test("subtask and final resolve independently", () => {
		const cfg: Config = { ...DEFAULT_CONFIG, checks: { subtask: [check("only-sub")] }, stacks: {} };
		const checks = effectiveChecks(cfg, makeStack({ checks: stackChecks }));
		assert.deepEqual(checks.subtask, [check("only-sub")]);
		assert.deepEqual(checks.final, stackChecks.final);
	});

	test("undefined stack uses the generic per-stack entry", () => {
		const cfg: Config = {
			...DEFAULT_CONFIG,
			stacks: { generic: { checks: { subtask: [check("gen")], final: [] } } },
		};
		assert.deepEqual(effectiveChecks(cfg, undefined).subtask, [check("gen")]);
	});

	test("undefined stack with no generic entry yields empty checks", () => {
		assert.deepEqual(effectiveChecks(DEFAULT_CONFIG, undefined), { subtask: [], final: [] });
	});
});

describe("effectiveSetup", () => {
	test("config setup wins", () => {
		const cfg: Config = { ...DEFAULT_CONFIG, setup: ["cfg"], stacks: { typescript: { setup: ["stack"] } } };
		assert.deepEqual(effectiveSetup(cfg, makeStack({ setup: ["detected"] })), ["cfg"]);
	});

	test("per-stack setup wins over detected setup", () => {
		const cfg: Config = { ...DEFAULT_CONFIG, stacks: { typescript: { setup: ["stack"] } } };
		assert.deepEqual(effectiveSetup(cfg, makeStack({ setup: ["detected"] })), ["stack"]);
	});

	test("falls back to detected setup", () => {
		assert.deepEqual(effectiveSetup(DEFAULT_CONFIG, makeStack({ setup: ["detected"] })), ["detected"]);
	});
});

describe("applyScoutCommands", () => {
	test("returns false and leaves the stack unchanged when checks are not 'none'", () => {
		const stack = makeStack({ checksSource: "detected", checks: { subtask: [], final: [check("existing")] } });
		const before = structuredClone(stack);
		assert.equal(applyScoutCommands(stack, { build: "make" }), false);
		assert.deepEqual(stack, before);
	});

	test("maps scout commands to subtask and final checks", () => {
		const stack = makeStack({ checksSource: "none" });
		assert.equal(
			applyScoutCommands(stack, { typecheck: "tsc", build: "build", test: "test", lint: "lint" }),
			true,
		);
		assert.equal(stack.checksSource, "scout");
		assert.deepEqual(stack.checks.subtask, [{ name: "typecheck", command: "tsc" }]);
		assert.deepEqual(stack.checks.final, [
			{ name: "build", command: "build" },
			{ name: "typecheck", command: "tsc" },
			{ name: "tests", command: "test", when: "hasTests" },
			{ name: "lint", command: "lint", blocking: false },
		]);
	});

	test("does not duplicate typecheck when it equals build", () => {
		const stack = makeStack({ checksSource: "none" });
		applyScoutCommands(stack, { typecheck: "same", build: "same" });
		assert.deepEqual(stack.checks.final, [{ name: "build", command: "same" }]);
	});

	test("uses build as the quick subtask when there is no typecheck", () => {
		const stack = makeStack({ checksSource: "none" });
		applyScoutCommands(stack, { build: "make" });
		assert.deepEqual(stack.checks.subtask, [{ name: "build", command: "make" }]);
	});

	test("returns false for empty commands", () => {
		const stack = makeStack({ checksSource: "none" });
		assert.equal(applyScoutCommands(stack, {}), false);
		assert.equal(stack.checksSource, "none");
	});
});

describe("describeStack", () => {
	test("includes label, signals, facts and warnings", () => {
		const stack = makeStack({
			signals: ["package.json", "tsconfig.json"],
			alsoDetected: ["generic"],
			facts: ["Package manager: npm"],
			warnings: ["No wrapper"],
		});
		const text = describeStack(stack, {
			subtask: [check("typecheck", "tsc")],
			final: [{ name: "lint", command: "lint", blocking: false }],
		});
		assert.match(text, /\*\*TypeScript \/ JavaScript\*\* — package\.json, tsconfig\.json/);
		assert.match(text, new RegExp(`Also matched: ${STACK_LABELS.generic}`));
		assert.match(text, /- Package manager: npm/);
		assert.match(text, /\(non-blocking\)/);
		assert.match(text, /⚠️ No wrapper/);
	});

	test("says 'no strong signals' and 'none' when empty", () => {
		const stack = makeStack({ signals: [] });
		const text = describeStack(stack, { subtask: [], final: [] });
		assert.match(text, /no strong signals/);
		assert.match(text, /Subtask checks \(detected\): none/);
		assert.match(text, /Final checks: none/);
	});
});

describe("detectStack", () => {
	test("reports a tracked CI workflow as a fact for the generic stack", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minidev-stack-"));
		try {
			await git(dir, ["init"]);
			fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
			fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
			fs.writeFileSync(path.join(dir, ".github", "workflows", "ci.yml"), "name: CI\n");
			await git(dir, ["add", "."]);

			const stack = await detectStack(dir, { forced: "generic", derivedData: dir });
			assert.ok(
				stack.facts.some((f) => /CI config .*github\/workflows\/ci\.yml/.test(f)),
				`no CI fact in: ${stack.facts.join(" | ")}`,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
