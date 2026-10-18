#!/usr/bin/env node
// Typecheck against the host pi's packages without committing machine-specific paths.
// Locates pi's node_modules at runtime and writes a throwaway tsconfig under node_modules/.cache.
// Falls back to generating stub types when pi is not installed (e.g. CI).
//
// Resolution order:
//   1. $PI_NODE_MODULES                     (directory containing @earendil-works/*)
//   2. managed install: <pi launcher>/../install/releases/<current-version>/node_modules
//   3. global npm install: $(npm root -g)
//   4. generate minimal stub packages under node_modules/.cache/minidev/stubs
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hasPi = (dir) => dir && existsSync(join(dir, "@earendil-works", "pi-coding-agent", "package.json"));

function fromManagedInstall() {
	const which = spawnSync("bash", ["-lc", "command -v pi"], { encoding: "utf-8" });
	if (which.status !== 0) return undefined;
	const launcher = realpathSync(which.stdout.trim());
	const agentDir = dirname(dirname(launcher));
	const versionFile = join(agentDir, "install", "current-version");
	if (existsSync(versionFile)) {
		const version = readFileSync(versionFile, "utf-8").trim();
		return join(agentDir, "install", "releases", version, "node_modules");
	}
	// npm-style install: <prefix>/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
	const m = /^(.*\/node_modules)\/@earendil-works\//.exec(launcher);
	return m?.[1];
}

function fromNpmGlobal() {
	try {
		return execFileSync("npm", ["root", "-g"], { encoding: "utf-8" }).trim();
	} catch {
		return undefined;
	}
}

function writeStub(dir, pkg, files) {
	const base = join(dir, "@earendil-works", pkg);
	mkdirSync(base, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(base, name), content, "utf-8");
	}
}

function generateStubs() {
	const stubDir = join(root, "node_modules", ".cache", "minidev", "stubs");
	writeStub(stubDir, "pi-coding-agent", {
		"package.json": JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.0.0-stub", main: "index.js", types: "index.d.ts" }),
		"index.d.ts": `export type ExtensionAPI = any;\nexport type ExtensionContext = any;\nexport type ExtensionCommandContext = any;\nexport type Theme = any;\nexport function getMarkdownTheme(): any;\n`,
		"index.js": `"use strict";\n`,
	});
	writeStub(stubDir, "pi-tui", {
		"package.json": JSON.stringify({ name: "@earendil-works/pi-tui", version: "0.0.0-stub", main: "index.js", types: "index.d.ts" }),
		"index.d.ts": `export function truncateToWidth(text: string, width: number): string;\nexport type TUI = any;\nexport function Box(props: any): any;\nexport function Markdown(props: any): any;\nexport function Text(props: any): any;\n`,
		"index.js": `"use strict";\n`,
	});
	return stubDir;
}

const candidates = [process.env.PI_NODE_MODULES, fromManagedInstall(), fromNpmGlobal()];
let piModules = candidates.find(hasPi);

if (!piModules) {
	piModules = generateStubs();
	console.log(`typecheck: pi packages not found — using generated stubs in ${piModules}`);
}

const cacheDir = join(root, "node_modules", ".cache", "minidev");
mkdirSync(cacheDir, { recursive: true });
const tsconfig = join(cacheDir, "tsconfig.typecheck.json");
writeFileSync(
	tsconfig,
	JSON.stringify({ extends: join(root, "tsconfig.json"), compilerOptions: { paths: { "@earendil-works/*": [join(piModules, "@earendil-works", "*")] } } }, null, 2),
);

const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
const r = spawnSync(process.execPath, [tsc, "--noEmit", "-p", tsconfig, ...process.argv.slice(2)], { stdio: "inherit", cwd: root });
process.exit(r.status ?? 1);
