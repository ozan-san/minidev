import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gitTry, readFileOr } from "./util.ts";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface VersionInfo {
	version: string | null;
	commit: string | null;
}

export function parsePackageVersion(json: string): string | null {
	try {
		const parsed = JSON.parse(json) as { version?: unknown };
		return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : null;
	} catch {
		return null;
	}
}

export function readPackageVersion(): string | null {
	return parsePackageVersion(readFileOr(path.join(PACKAGE_ROOT, "package.json"), ""));
}

export function formatVersion(info: VersionInfo): string {
	const base = info.version ? `v${info.version}` : "minidev";
	return info.commit ? `${base} (${info.commit})` : base;
}

export async function computeVersionInfo(): Promise<VersionInfo> {
	return {
		version: readPackageVersion(),
		commit: await gitTry(PACKAGE_ROOT, ["rev-parse", "--short", "HEAD"]),
	};
}

let cached: Promise<VersionInfo> | undefined;

export function loadVersionInfo(): Promise<VersionInfo> {
	cached ??= computeVersionInfo();
	return cached;
}

export async function loadVersionLabel(): Promise<string> {
	return formatVersion(await loadVersionInfo());
}
