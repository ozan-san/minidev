import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	shellQuote,
	expandHome,
	slugify,
	tail,
	fmtUsd,
	fmtDuration,
	extractJson,
	stripJsonBlocks,
	deepMerge,
	readFileOr,
	writeFile,
	ensureDir,
} from "./util.ts";

describe("shellQuote", () => {
	test("quotes the empty string", () => {
		assert.equal(shellQuote(""), "''");
	});

	test("leaves safe strings unchanged", () => {
		assert.equal(shellQuote("abc/def-1.2"), "abc/def-1.2");
	});

	test("quotes strings with spaces", () => {
		assert.equal(shellQuote("a b"), "'a b'");
	});

	test("escapes single quotes", () => {
		assert.equal(shellQuote("it's"), "'it'\\''s'");
	});
});

describe("expandHome", () => {
	test("expands bare tilde", () => {
		assert.equal(expandHome("~"), os.homedir());
	});

	test("expands tilde prefix", () => {
		assert.equal(expandHome("~/x/y"), path.join(os.homedir(), "x/y"));
	});

	test("leaves absolute and inner tilde paths unchanged", () => {
		assert.equal(expandHome("/abs"), "/abs");
		assert.equal(expandHome("rel/~"), "rel/~");
	});
});

describe("slugify", () => {
	test("lowercases and collapses punctuation", () => {
		assert.equal(slugify("Hello, World!"), "hello-world");
	});

	test("trims leading and trailing dashes", () => {
		assert.equal(slugify("--Hello--"), "hello");
	});

	test("falls back to 'change' for empty input", () => {
		assert.equal(slugify("!!!"), "change");
	});

	test("respects max length and removes trailing dash after slicing", () => {
		assert.equal(slugify("aaa bbb", 4), "aaa");
	});

	test("defaults to 40 characters", () => {
		assert.equal(slugify("a".repeat(50)).length, 40);
	});
});

describe("tail", () => {
	test("returns short text unchanged", () => {
		assert.equal(tail("1\n2\n3", 3), "1\n2\n3");
	});

	test("keeps the last n lines and notes omissions", () => {
		assert.equal(tail("1\n2\n3\n4", 2), "…(2 earlier lines omitted)\n3\n4");
	});
});

describe("fmtUsd", () => {
	test("uses four decimals under a cent", () => {
		assert.equal(fmtUsd(0.005), "$0.0050");
		assert.equal(fmtUsd(0), "$0.0000");
	});

	test("uses two decimals at a cent and above", () => {
		assert.equal(fmtUsd(0.01), "$0.01");
		assert.equal(fmtUsd(1.234), "$1.23");
	});
});

describe("fmtDuration", () => {
	test("formats seconds", () => {
		assert.equal(fmtDuration(0), "0s");
		assert.equal(fmtDuration(59_000), "59s");
	});

	test("rounds and formats minutes", () => {
		assert.equal(fmtDuration(59_500), "1m00s");
		assert.equal(fmtDuration(125_000), "2m05s");
	});
});

describe("extractJson", () => {
	test("parses a single json fence", () => {
		assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
	});

	test("last valid block wins", () => {
		assert.deepEqual(extractJson('```json\n{"a":1}\n```\n\n```json\n{"b":2}\n```'), { b: 2 });
	});

	test("falls back to the previous block when the last is invalid", () => {
		assert.deepEqual(extractJson('```json\n{"a":1}\n```\n\n```json\n{invalid}\n```'), { a: 1 });
	});

	test("parses a fence without a language tag", () => {
		assert.deepEqual(extractJson('```\n{"z":9}\n```'), { z: 9 });
	});

	test("parses a bare object embedded in prose", () => {
		assert.deepEqual(extractJson('x {"a":1} y'), { a: 1 });
	});

	test("throws when there is no json", () => {
		assert.throws(() => extractJson("no json here"), /No JSON block/);
	});
});

describe("stripJsonBlocks", () => {
	test("removes json fences and trims", () => {
		assert.equal(stripJsonBlocks('before\n```json\n{"a":1}\n```\nafter'), "before\n\nafter");
	});

	test("keeps non-json fences", () => {
		const text = "```sh\nnpm test\n```";
		assert.equal(stripJsonBlocks(text), text);
	});
});

describe("deepMerge", () => {
	test("merges nested objects", () => {
		assert.deepEqual(deepMerge({ a: { b: 1 }, c: 2 }, { a: { d: 3 } }), { a: { b: 1, d: 3 }, c: 2 });
	});

	test("replaces arrays instead of concatenating", () => {
		assert.deepEqual(deepMerge({ a: [1, 2] }, { a: [3] }), { a: [3] });
	});

	test("returns base for undefined or null overrides", () => {
		const base = { a: 1 };
		assert.equal(deepMerge(base, undefined), base);
		assert.equal(deepMerge(base, null), base);
	});

	test("primitives replace", () => {
		assert.deepEqual(deepMerge({ a: 1 }, { a: 5 }), { a: 5 });
	});

	test("does not mutate the base", () => {
		const base = { a: { b: 1 }, c: 2 };
		deepMerge(base, { a: { d: 3 } });
		assert.deepEqual(base, { a: { b: 1 }, c: 2 });
	});
});

describe("file helpers", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minidev-"));
	after(() => fs.rmSync(dir, { recursive: true, force: true }));

	test("readFileOr returns the fallback for a missing file", () => {
		assert.equal(readFileOr(path.join(dir, "nope.txt"), "fallback"), "fallback");
	});

	test("writeFile creates parent dirs and round-trips content", () => {
		const file = path.join(dir, "a", "b", "file.txt");
		writeFile(file, "hello");
		assert.ok(fs.existsSync(file));
		assert.equal(readFileOr(file, ""), "hello");
	});

	test("ensureDir creates nested directories", () => {
		const nested = path.join(dir, "x", "y");
		assert.equal(ensureDir(nested), nested);
		assert.ok(fs.statSync(nested).isDirectory());
	});
});
