import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	parseTicketText,
	sanitizeKey,
	generateKey,
	ISSUE_KEY_RE,
	ticketMarkdown,
	resolveTicket,
	TICKET_TEMPLATE,
	type Ticket,
} from "./ticket.ts";

describe("parseTicketText", () => {
	test("parses Key/Title headers case-insensitively", () => {
		const t = parseTicketText("key: ABC-1\ntitle: Fix the thing\nbody line");
		assert.equal(t.key, "ABC-1");
		assert.equal(t.title, "Fix the thing");
		assert.equal(t.body, "body line");
	});

	test("accepts Summary as a title alias", () => {
		const t = parseTicketText("Key: ABC-2\nSummary: Add tests");
		assert.equal(t.title, "Add tests");
	});

	test("first Key/Title wins, later duplicates stay in the body", () => {
		const t = parseTicketText("Key: A-1\nKey: B-2\nTitle: First\nTitle: Second");
		assert.equal(t.key, "A-1");
		assert.equal(t.title, "First");
		assert.equal(t.body, "Key: B-2\nTitle: Second");
	});

	test("falls back to the first body line, stripping heading marks", () => {
		const t = parseTicketText("## Fix the parser\nmore text");
		assert.equal(t.title, "Fix the parser");
	});

	test("truncates a fallback title to 120 chars", () => {
		const t = parseTicketText("X".repeat(200));
		assert.equal(t.title.length, 120);
	});

	test("normalizes CRLF", () => {
		const t = parseTicketText("Key: A-1\r\nTitle: T\r\n\r\nbody");
		assert.equal(t.body, "body");
	});

	test("sanitizes the key", () => {
		assert.equal(parseTicketText("Key: ab c!\nTitle: T").key, "ab-c");
	});

	test("generates a key when missing", () => {
		assert.match(parseTicketText("Title: T").key, /^MD-\d{8}-\d{4}$/);
	});

	test("removes empty middle and trailing template sections", () => {
		const body = "## Intro\n\nKeep me\n\n## Empty\n\n## Notes\n";
		assert.equal(parseTicketText(`Title: T\n${body}`).body, "## Intro\n\nKeep me");
	});

	test("keeps a non-empty section whose content follows a blank line", () => {
		assert.equal(parseTicketText("Title: X\n## Description\n\nFoo").body, "## Description\n\nFoo");
	});

	test("TICKET_TEMPLATE parses to key with empty body", () => {
		const t = parseTicketText(TICKET_TEMPLATE("ABC-1"));
		assert.equal(t.key, "ABC-1");
		assert.equal(t.body, "");
	});
});

describe("sanitizeKey", () => {
	test("trims, replaces invalid runs, strips edge dashes and caps length", () => {
		assert.equal(sanitizeKey("  ab c!  "), "ab-c");
		assert.equal(sanitizeKey("--a--b--"), "a--b");
		assert.equal(sanitizeKey("x".repeat(50)).length, 40);
	});
});

describe("generateKey", () => {
	test("matches the MD-YYYYMMDD-HHMM shape", () => {
		assert.match(generateKey(), /^MD-\d{8}-\d{4}$/);
	});
});

describe("ISSUE_KEY_RE", () => {
	test("matches standard issue keys", () => {
		assert.ok(ISSUE_KEY_RE.test("ABC-123"));
	});

	test("rejects lowercase, too-short prefixes and keys without a dash", () => {
		assert.ok(!ISSUE_KEY_RE.test("abc-1"));
		assert.ok(!ISSUE_KEY_RE.test("A-1"));
		assert.ok(!ISSUE_KEY_RE.test("ABC123"));
	});
});

describe("ticketMarkdown", () => {
	const base: Ticket = { key: "MD-1", title: "T", body: "body", source: "file:/x" };

	test("renders the heading and body", () => {
		assert.equal(ticketMarkdown(base), "# MD-1: T\n\nbody\n");
	});

	test("includes the source url when present", () => {
		assert.equal(ticketMarkdown({ ...base, url: "https://x/1" }), "# MD-1: T\n\nSource: https://x/1\n\nbody\n");
	});

	test("uses a placeholder for an empty body", () => {
		assert.equal(ticketMarkdown({ ...base, body: "" }), "# MD-1: T\n\n(no description)\n");
	});
});

describe("resolveTicket", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minidev-ticket-"));
	after(() => fs.rmSync(dir, { recursive: true, force: true }));

	test("reads a markdown file source", async () => {
		const file = path.join(dir, "ticket.md");
		fs.writeFileSync(file, "Key: ABC-9\nTitle: From file\n\nDescription", "utf-8");
		const t = await resolveTicket(file);
		assert.ok(t);
		assert.equal(t.key, "ABC-9");
		assert.equal(t.title, "From file");
		assert.equal(t.body, "Description");
		assert.equal(t.source, `file:${path.resolve(file)}`);
	});

	test("returns undefined for a nonexistent markdown path", async () => {
		assert.equal(await resolveTicket(path.join(dir, "missing.md")), undefined);
	});
});
