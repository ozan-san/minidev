import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EntryRecord, ToolRegistration, UsageState } from "@earendil-works/pi-durable";
import {
	assistantMessage,
	callCost,
	countAssistants,
	inputHash,
	lastAssistant,
	loadProjectContext,
	requestIdFor,
	sessionDir,
	summarizeTool,
	toolSelection,
	totalCost,
} from "./harness-util.ts";

let nextId = 1;

function assistant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		role: "assistant",
		provider: "openai",
		model: "gpt-5",
		content: [{ type: "text", text: "hello" }],
		usage: { cost: { total: 0.25 } },
		stopReason: "stop",
		...overrides,
	};
}

function entry(kind: string, ...model: Record<string, unknown>[]): EntryRecord {
	return { id: nextId++, conversationId: 1, kind, model } as unknown as EntryRecord;
}

describe("requestIdFor", () => {
	test("is deterministic", () => {
		assert.equal(requestIdFor("k", "builder", "item"), "k:builder:item");
		assert.equal(requestIdFor("k", "builder", "item"), requestIdFor("k", "builder", "item"));
	});

	test("separates key, role and item", () => {
		assert.notEqual(requestIdFor("k1", "builder", "item"), requestIdFor("k2", "builder", "item"));
		assert.notEqual(requestIdFor("k", "builder", "item"), requestIdFor("k", "planner", "item"));
		assert.notEqual(requestIdFor("k", "builder", "i1"), requestIdFor("k", "builder", "i2"));
	});
});

describe("inputHash", () => {
	test("is stable and 16 hex characters", () => {
		assert.equal(inputHash("a", "b"), inputHash("a", "b"));
		assert.match(inputHash("a", "b"), /^[0-9a-f]{16}$/);
	});

	test("is sensitive to every part", () => {
		assert.notEqual(inputHash("a", "b"), inputHash("a", "c"));
		assert.notEqual(inputHash("a", "b"), inputHash("b", "a"));
		assert.notEqual(inputHash("a"), inputHash("a", "b"));
	});

	test("treats undefined as the empty string", () => {
		assert.equal(inputHash(undefined, "b"), inputHash("", "b"));
	});
});

describe("summarizeTool", () => {
	test("formats bash as the first command line", () => {
		assert.equal(summarizeTool("bash", { command: "git status\nignored" }), "$ git status");
	});

	test("formats path-based tools", () => {
		assert.equal(summarizeTool("read", { path: "/a.ts" }), "read /a.ts");
		assert.equal(summarizeTool("write", { path: "/a.ts" }), "write /a.ts");
		assert.equal(summarizeTool("edit", { path: "/a.ts" }), "edit /a.ts");
		assert.equal(summarizeTool("ls", { path: "/src" }), "ls /src");
	});

	test("formats grep and find with their pattern and path", () => {
		assert.equal(summarizeTool("grep", { pattern: "foo", path: "/src" }), "grep /foo/ /src");
		assert.equal(summarizeTool("find", { pattern: "*.ts", path: "/src" }), "find *.ts /src");
	});

	test("falls back to the tool name plus args", () => {
		assert.equal(summarizeTool("mytool", { a: 1 }), 'mytool {"a":1}');
	});
});

describe("sessionDir", () => {
	test("points at <runDir>/session", () => {
		assert.equal(sessionDir("/r/K"), path.join("/r/K", "session"));
	});
});

describe("totalCost", () => {
	test("sums model and tool buckets", () => {
		const usage = {
			models: { "p/m": { cost: { total: 1.5 } }, "p/n": { cost: { total: 0.5 } } },
			tools: { bash: { cost: { total: 0.25 } } },
		} as unknown as UsageState;
		assert.equal(totalCost(usage), 2.25);
	});

	test("tolerates missing buckets and missing cost", () => {
		assert.equal(totalCost({ models: {}, tools: {} } as unknown as UsageState), 0);
		assert.equal(totalCost({ models: { "p/m": {} }, tools: { bash: {} } } as unknown as UsageState), 0);
	});
});

describe("entry inspection", () => {
	test("assistantMessage finds the first assistant model item", () => {
		assert.ok(assistantMessage(entry("assistant", assistant())));
		assert.equal(assistantMessage(entry("tool", { role: "toolResult" })), undefined);
		assert.equal(assistantMessage(entry("empty")), undefined);
	});

	test("countAssistants counts only entries with an assistant message", () => {
		const entries = [entry("assistant", assistant()), entry("tool", { role: "toolResult" }), entry("assistant", assistant())];
		assert.equal(countAssistants(entries), 2);
		assert.equal(countAssistants([]), 0);
	});

	test("callCost sums assistant usage", () => {
		const entries = [
			entry("assistant", assistant({ usage: { cost: { total: 0.5 } } })),
			entry("tool", { role: "toolResult" }),
			entry("assistant", assistant({ usage: { cost: { total: 0.25 } } })),
		];
		assert.equal(callCost(entries), 0.75);
		assert.equal(callCost([]), 0);
	});

	test("lastAssistant keeps the last assistant entry's text, stop reason and model", () => {
		const entries = [
			entry("assistant", assistant({ content: [{ type: "text", text: "first" }] })),
			entry("assistant", assistant({ content: [{ type: "text", text: "  second  " }], stopReason: "length" })),
		];
		assert.deepEqual(lastAssistant(entries), {
			text: "second",
			stopReason: "length",
			error: undefined,
			model: "openai/gpt-5",
		});
	});

	test("lastAssistant includes only text blocks and reports errors", () => {
		const message = assistant({
			content: [
				{ type: "text", text: "done" },
				{ type: "toolCall", id: "call_1", name: "bash" },
			],
			errorMessage: "boom",
			stopReason: "error",
		});
		assert.deepEqual(lastAssistant([entry("assistant", message)]), {
			text: "done",
			stopReason: "error",
			error: "boom",
			model: "openai/gpt-5",
		});
	});

	test("lastAssistant is undefined without an assistant entry", () => {
		assert.equal(lastAssistant([entry("tool", { role: "toolResult" })]), undefined);
		assert.equal(lastAssistant([]), undefined);
	});
});

describe("toolSelection", () => {
	const tools = [{ name: "read" }, { name: "grep" }, { name: "bash" }, { name: "write" }] as unknown as ToolRegistration[];
	const names = (selection: ToolRegistration[]) => selection.map((t) => t.name);

	test("empty wanted returns every tool", () => {
		assert.deepEqual(names(toolSelection(tools, [])), ["read", "grep", "bash", "write"]);
	});

	test("a subset keeps registry order and always includes bash", () => {
		assert.deepEqual(names(toolSelection(tools, ["read", "grep"])), ["read", "grep", "bash"]);
	});

	test("unknown names are ignored and bash is still included", () => {
		assert.deepEqual(names(toolSelection(tools, ["nope"])), ["bash"]);
	});

	test("an explicit bash is not duplicated", () => {
		assert.deepEqual(names(toolSelection(tools, ["bash"])), ["bash"]);
	});
});

describe("loadProjectContext", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minidev-util-"));
	after(() => fs.rmSync(dir, { recursive: true, force: true }));

	test("returns empty when neither file exists", () => {
		assert.equal(loadProjectContext(dir), "");
	});

	test("loads AGENTS.md alone", () => {
		const cwd = fs.mkdtempSync(path.join(dir, "agents-"));
		fs.writeFileSync(path.join(cwd, "AGENTS.md"), "  rules  ");
		assert.equal(loadProjectContext(cwd), "# AGENTS.md\n\nrules");
	});

	test("loads CLAUDE.md alone", () => {
		const cwd = fs.mkdtempSync(path.join(dir, "claude-"));
		fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "claude rules");
		assert.equal(loadProjectContext(cwd), "# CLAUDE.md\n\nclaude rules");
	});

	test("loads AGENTS.md before CLAUDE.md", () => {
		const cwd = fs.mkdtempSync(path.join(dir, "both-"));
		fs.writeFileSync(path.join(cwd, "AGENTS.md"), "agents");
		fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "claude");
		assert.equal(loadProjectContext(cwd), "# AGENTS.md\n\nagents\n\n# CLAUDE.md\n\nclaude");
	});

	test("skips empty files", () => {
		const cwd = fs.mkdtempSync(path.join(dir, "empty-"));
		fs.writeFileSync(path.join(cwd, "AGENTS.md"), "   \n");
		fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "claude");
		assert.equal(loadProjectContext(cwd), "# CLAUDE.md\n\nclaude");
	});
});
