import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "./util.ts";

test("slugify lowercases and collapses punctuation", () => {
	assert.equal(slugify("Hello, World!"), "hello-world");
});

test("slugify falls back to 'change' for empty input", () => {
	assert.equal(slugify("!!!"), "change");
});
