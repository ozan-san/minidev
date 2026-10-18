import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { textWidth, truncateVisible } from "./text-width.ts";

describe("textWidth", () => {
	test("returns 0 for an empty string and the length for plain text", () => {
		assert.equal(textWidth(""), 0);
		assert.equal(textWidth("hello"), 5);
	});

	test("ignores ANSI SGR escape sequences", () => {
		assert.equal(textWidth("\u001b[31mab\u001b[0m"), 2);
		assert.equal(textWidth("\u001b[1;32mabc\u001b[0m"), 3);
	});

	test("counts East-Asian and emoji graphemes as two cells", () => {
		assert.equal(textWidth("中"), 2);
		assert.equal(textWidth("あ"), 2);
		assert.equal(textWidth("！"), 2);
		assert.equal(textWidth("🎉"), 2);
		assert.equal(textWidth("ab中cd"), 6);
	});

	test("counts combining marks as zero width", () => {
		assert.equal(textWidth("e\u0301"), 1);
		assert.equal(textWidth("cafe\u0301"), 4);
	});

	test("treats a tab as three cells", () => {
		assert.equal(textWidth("\t"), 3);
		assert.equal(textWidth("a\tb"), 5);
	});
});

describe("truncateVisible", () => {
	test("returns the input unchanged when it fits", () => {
		assert.equal(truncateVisible("hello", 5), "hello");
		assert.equal(truncateVisible("hi", 10), "hi");
		assert.equal(truncateVisible("\u001b[31mab\u001b[0m", 2), "\u001b[31mab\u001b[0m");
	});

	test("clips to exactly max visible cells", () => {
		assert.equal(truncateVisible("hello", 3), "hel");
		assert.equal(textWidth(truncateVisible("hello world", 4)), 4);
	});

	test("re-appends the reset sequence when it clipped inside colored text", () => {
		const clipped = truncateVisible("\u001b[31mhello\u001b[0m", 3);
		assert.equal(clipped, "\u001b[31mhel\u001b[0m");
		assert.ok(clipped.endsWith("\u001b[0m"));
		assert.equal(textWidth(clipped), 3);
	});

	test("does not append a reset when clipping plain text", () => {
		const clipped = truncateVisible("hello", 2);
		assert.equal(clipped, "he");
		assert.ok(!clipped.includes("\u001b"));
	});

	test("returns an empty string for a non-positive max", () => {
		assert.equal(truncateVisible("hello", 0), "");
		assert.equal(truncateVisible("hello", -1), "");
	});
});
