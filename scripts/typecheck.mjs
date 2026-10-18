#!/usr/bin/env node
// Typecheck against the host pi's packages without committing machine-specific paths.
// Locates pi's node_modules at runtime and writes a throwaway tsconfig under node_modules/.cache.
//
// Resolution order:
//   1. $PI_NODE_MODULES                     (directory containing @earendil-works/*)
//   2. managed install: <pi launcher>/../install/releases/<current-version>/node_modules
//   3. global npm install: $(npm root -g)
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

const candidates = [process.env.PI_NODE_MODULES, fromManagedInstall(), fromNpmGlobal()];
const piModules = candidates.find(hasPi);
if (!piModules) {
	console.error("typecheck: could not find pi's packages (@earendil-works/*). Set PI_NODE_MODULES to the node_modules dir containing them.");
	process.exit(2);
}

const cacheDir = join(root, "node_modules", ".cache", "minidev");
mkdirSync(cacheDir, { recursive: true });
// Host packages first, then this repo's node_modules: minidev depends on packages pi does not ship (pi-durable, chord).
const paths = [join(piModules, "@earendil-works", "*"), join(root, "node_modules", "@earendil-works", "*")];
const tsconfig = join(cacheDir, "tsconfig.typecheck.json");
writeFileSync(
	tsconfig,
	JSON.stringify({ extends: join(root, "tsconfig.json"), compilerOptions: { paths: { "@earendil-works/*": paths } } }, null, 2),
);

const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
const r = spawnSync(process.execPath, [tsc, "--noEmit", "-p", tsconfig, ...process.argv.slice(2)], { stdio: "inherit", cwd: root });
process.exit(r.status ?? 1);
