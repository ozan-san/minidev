import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const WORKFLOW = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));

describe("GitHub Actions CI workflow", () => {
	test("workflow runs the test suite", () => {
		assert.ok(fs.existsSync(WORKFLOW), `missing workflow: ${WORKFLOW}`);
		const content = fs.readFileSync(WORKFLOW, "utf-8");
		assert.match(content, /npm ci/);
		assert.match(content, /CI=1 npm run -s test/);
		assert.match(content, /node-version: "22\.18"/);
	});

	test("workflow triggers on pull requests", () => {
		const content = fs.readFileSync(WORKFLOW, "utf-8");
		assert.match(content, /pull_request/);
	});

	test("workflow has a typecheck job against pi peers", () => {
		const content = fs.readFileSync(WORKFLOW, "utf-8");
		assert.match(content, /npm run -s typecheck/);
		assert.match(content, /PI_NODE_MODULES/);
		assert.match(content, /--no-save/);
	});
});
