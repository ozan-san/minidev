import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { findCommand, grepCommand, lsCommand } from "./agent-tools.ts";

describe("lsCommand", () => {
	test("defaults to the current directory", () => {
		assert.equal(lsCommand({}), "ls -1Ap -- .");
	});

	test("shell-quotes the path", () => {
		assert.equal(lsCommand({ path: "my dir" }), "ls -1Ap -- 'my dir'");
	});
});

describe("findCommand", () => {
	test("quotes the name glob and skips .git and node_modules", () => {
		const command = findCommand({ pattern: "*.ts" });
		assert.match(command, /^find \. -maxdepth 6 -name '\*\.ts'/);
		assert.match(command, /-not -path '\*\/\.git\/\*'/);
		assert.match(command, /-not -path '\*\/node_modules\/\*'/);
	});

	test("uses the given path", () => {
		assert.match(findCommand({ pattern: "a b", path: "src" }), /^find src -maxdepth 6 -name 'a b'/);
	});
});

describe("grepCommand", () => {
	test("prefers ripgrep and falls back to grep -rnE", () => {
		const command = grepCommand({ pattern: "foo" });
		assert.match(command, /^if command -v rg >\/dev\/null 2>&1; then rg /);
		assert.match(command, /; else grep -rnE /);
		assert.match(command, /; fi$/);
	});

	test("shell-quotes patterns containing spaces", () => {
		assert.match(grepCommand({ pattern: "a b" }), /-- 'a b' \./);
	});

	test("shell-quotes patterns containing single quotes", () => {
		assert.match(grepCommand({ pattern: "it's" }), /'it'\\''s'/);
	});

	test("adds -i when ignoreCase is set", () => {
		const withCase = grepCommand({ pattern: "foo", ignoreCase: true });
		assert.match(withCase, /--max-count 200 -i -- foo \./);
		assert.match(withCase, /grep -rnE -i -- foo \./);
		const withoutCase = grepCommand({ pattern: "foo" });
		assert.doesNotMatch(withoutCase, / -i /);
	});

	test("passes a glob to ripgrep and grep", () => {
		const command = grepCommand({ pattern: "foo", glob: "*.ts" });
		assert.match(command, /-g '\*\.ts' -- foo \./);
		assert.match(command, /grep -rnE --include '\*\.ts' -- foo \./);
	});
});
