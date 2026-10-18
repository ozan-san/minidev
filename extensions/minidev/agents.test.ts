import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseStackDoc } from "./agents.ts";

describe("parseStackDoc", () => {
	test("ignores frontmatter", () => {
		const doc = "---\nname: x\ntools: a,b\n---\nintro";
		assert.deepEqual(parseStackDoc(doc), { all: "intro" });
	});

	test("drops the top-level # Title line", () => {
		assert.deepEqual(parseStackDoc("# Stack guidance\n\nintro text"), { all: "intro text" });
	});

	test("maps an All roles heading to 'all' and merges it with the intro", () => {
		const doc = "intro\n\n## All roles\nshared rules";
		assert.deepEqual(parseStackDoc(doc), { all: "intro\n\nshared rules" });
	});

	test("maps role headings to role keys via prefix", () => {
		const doc = "## Builder\nbuild rules\n\n## Tester notes\ntest rules";
		assert.deepEqual(parseStackDoc(doc), { builder: "build rules", tester: "test rules" });
	});

	test("keeps unknown headings lowercased", () => {
		assert.deepEqual(parseStackDoc("## Foo Bar\nsomething"), { "foo bar": "something" });
	});

	test("returns only 'all' when there are no headings", () => {
		assert.deepEqual(parseStackDoc("just intro"), { all: "just intro" });
	});
});
