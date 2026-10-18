import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatVersion, parsePackageVersion, type VersionInfo } from "./version.ts";

function makeInfo(over: Partial<VersionInfo> = {}): VersionInfo {
	return { version: "0.1.0", commit: "abc1234", ...over };
}

describe("formatVersion", () => {
	test("includes version and short commit when both are present", () => {
		assert.equal(formatVersion(makeInfo()), "v0.1.0 (abc1234)");
	});

	test("omits the commit when it is null", () => {
		assert.equal(formatVersion(makeInfo({ commit: null })), "v0.1.0");
	});

	test("falls back to minidev when the version is null", () => {
		assert.equal(formatVersion(makeInfo({ version: null })), "minidev (abc1234)");
	});

	test("falls back to minidev when both are null", () => {
		assert.equal(formatVersion(makeInfo({ version: null, commit: null })), "minidev");
	});
});

describe("parsePackageVersion", () => {
	test("returns the version for a valid package.json", () => {
		assert.equal(parsePackageVersion('{"name":"minidev","version":"0.1.0"}'), "0.1.0");
	});

	test("trims surrounding whitespace from the version", () => {
		assert.equal(parsePackageVersion('{"version":"  0.1.0  "}'), "0.1.0");
	});

	test("returns null for invalid JSON", () => {
		assert.equal(parsePackageVersion("not json"), null);
	});

	test("returns null when version is missing", () => {
		assert.equal(parsePackageVersion('{"name":"minidev"}'), null);
	});

	test("returns null when version is not a string", () => {
		assert.equal(parsePackageVersion('{"version":123}'), null);
	});

	test("returns null when version is empty or whitespace", () => {
		assert.equal(parsePackageVersion('{"version":""}'), null);
		assert.equal(parsePackageVersion('{"version":"   "}'), null);
	});
});
