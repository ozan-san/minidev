import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "./config.ts";
import { deepMerge } from "./util.ts";

const EXAMPLE = fileURLToPath(new URL("../../minidev.example.json", import.meta.url));
const README = fileURLToPath(new URL("../../README.md", import.meta.url));

describe("durable config", () => {
	test("DEFAULT_CONFIG.durable is safe replay with orphan reaping", () => {
		assert.deepEqual(DEFAULT_CONFIG.durable, { replay: "safe", reapOrphans: true });
	});

	test("a partial durable override keeps the other default", () => {
		const merged = deepMerge(DEFAULT_CONFIG, { durable: { replay: "off" } });
		assert.equal(merged.durable.replay, "off");
		assert.equal(merged.durable.reapOrphans, true);
	});
});

describe("durability artifacts", () => {
	test("minidev.example.json parses and documents the durable defaults", () => {
		const cfg = JSON.parse(fs.readFileSync(EXAMPLE, "utf-8")) as { durable?: { replay?: string; reapOrphans?: boolean } };
		assert.equal(cfg.durable?.replay, "safe");
		assert.equal(cfg.durable?.reapOrphans, true);
	});

	test("README documents the journal command and orphan reaping", () => {
		const content = fs.readFileSync(README, "utf-8");
		assert.match(content, /\/minidev journal/);
		assert.match(content, /durable\.reapOrphans/);
	});
});
