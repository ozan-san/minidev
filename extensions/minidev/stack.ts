/**
 * Stack detection: decides which "mode" a run uses (agent guidance, setup, checks, test detection).
 * Deterministic and cheap — reads tracked files and a few manifests. The scout can fill in
 * build/test commands afterwards when detection finds none (see `applyScoutCommands`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Check, Config } from "./config.ts";
import { exec, gitTry, shellQuote } from "./util.ts";

export const STACK_IDS = ["android", "ios", "typescript", "generic"] as const;
export type StackId = (typeof STACK_IDS)[number];

export const STACK_LABELS: Record<StackId, string> = {
	android: "Android (Gradle)",
	ios: "iOS / Swift",
	typescript: "TypeScript / JavaScript",
	generic: "Generic",
};

export interface Checks {
	subtask: Check[];
	final: Check[];
}

export interface StackInfo {
	id: StackId;
	/** Human label incl. flavour, e.g. "iOS / Swift (Xcode workspace, scheme App)". */
	label: string;
	/** Why this stack was chosen. */
	signals: string[];
	/** Other stacks that also matched (mixed repos, e.g. React Native / KMP). */
	alsoDetected: StackId[];
	/** Commands run once in a fresh worktree (dependency install, project generation). */
	setup: string[];
	/** Detected checks. Config overrides win, see `effectiveChecks`. */
	checks: Checks;
	/** Where checks came from: "detected" | "scout" | "none". */
	checksSource: "detected" | "scout" | "none";
	/** Regex source matched against `git ls-files` to decide whether the repo has unit tests. */
	testPattern: string;
	/** Facts handed to agents (package manager, scheme, wrapper, …). */
	facts: string[];
	/** Problems a human should know (e.g. xcodebuild missing). */
	warnings: string[];
}

const TEST_PATTERNS: Record<StackId, string> = {
	android: String.raw`(^|/)src/test(?:[A-Z]\w*)?/`,
	ios: String.raw`(Tests?/[^\n]*\.swift$|Tests\.swift$)`,
	typescript: String.raw`(\.(test|spec)\.[cm]?[jt]sx?$|(^|/)__tests__/)`,
	generic: String.raw`((^|/)(tests?|spec)/|_test\.(go|py|rb|exs?)$|(^|/)test_\w+\.py$|Tests?\.(java|kt|cs)$)`,
};

interface Scan {
	root: string;
	files: string[];
	has: (re: RegExp) => boolean;
	exists: (rel: string) => boolean;
	read: (rel: string) => string;
}

async function scan(root: string): Promise<Scan> {
	const files = ((await gitTry(root, ["ls-files"])) ?? "").split("\n").filter(Boolean);
	return {
		root,
		files,
		has: (re) => files.some((f) => re.test(f)),
		exists: (rel) => fs.existsSync(path.join(root, rel)),
		read: (rel) => {
			try {
				return fs.readFileSync(path.join(root, rel), "utf-8");
			} catch {
				return "";
			}
		},
	};
}

function score(s: Scan): Record<StackId, { score: number; signals: string[] }> {
	const r: Record<StackId, { score: number; signals: string[] }> = {
		android: { score: 0, signals: [] },
		ios: { score: 0, signals: [] },
		typescript: { score: 0, signals: [] },
		generic: { score: 0, signals: [] },
	};
	const add = (id: StackId, n: number, why: string) => {
		r[id].score += n;
		r[id].signals.push(why);
	};

	// Android
	if (s.has(/(^|\/)AndroidManifest\.xml$/)) add("android", 3, "AndroidManifest.xml");
	if (s.has(/^settings\.gradle(\.kts)?$/)) add("android", 1, "settings.gradle");
	if (s.has(/(^|\/)build\.gradle(\.kts)?$/) && s.files.some((f) => /build\.gradle/.test(f) && /com\.android\.(application|library)|android\s*\{/.test(s.read(f))))
		add("android", 2, "Android Gradle plugin");

	// iOS / Swift
	if (s.has(/\.xcodeproj\/project\.pbxproj$/)) add("ios", 3, ".xcodeproj");
	if (s.has(/\.xcworkspace\/contents\.xcworkspacedata$/)) add("ios", 1, ".xcworkspace");
	if (s.has(/^Package\.swift$/)) add("ios", 3, "Package.swift");
	if (s.has(/^(project\.yml|Project\.swift|Tuist\/)/)) add("ios", 2, "XcodeGen/Tuist manifest");
	const swiftFiles = s.files.filter((f) => f.endsWith(".swift")).length;
	if (swiftFiles) add("ios", Math.min(2, Math.ceil(swiftFiles / 20)), `${swiftFiles} .swift files`);

	// TypeScript / JavaScript (root package.json only; nested ones are usually tooling)
	if (s.has(/^package\.json$/)) {
		add("typescript", 2, "package.json");
		if (s.has(/^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/)) add("typescript", 1, "JS lockfile");
	}
	if (s.has(/^tsconfig(\.\w+)?\.json$/)) add("typescript", 2, "tsconfig.json");
	const tsFiles = s.files.filter((f) => /\.(m|c)?tsx?$/.test(f) && !f.endsWith(".d.ts")).length;
	const jsFiles = s.files.filter((f) => /\.(m|c)?jsx?$/.test(f) && !/(^|\/)[\w.-]+\.config\.[cm]?js$/.test(f)).length;
	if (tsFiles) add("typescript", Math.min(2, Math.ceil(tsFiles / 20)), `${tsFiles} .ts files`);
	else if (jsFiles) add("typescript", Math.min(2, Math.ceil(jsFiles / 20)), `${jsFiles} .js files`);

	return r;
}

// ── per-stack profiles ─────────────────────────────────────────────────────

async function androidProfile(s: Scan): Promise<Partial<StackInfo>> {
	const g = s.exists("gradlew") ? "./gradlew" : "gradle";
	const G = `${g} --console=plain`;
	const facts = [`Gradle: ${g === "gradle" ? "no wrapper, using system gradle" : "./gradlew wrapper"}`];
	const warnings: string[] = [];
	if (g === "gradle") warnings.push("No ./gradlew wrapper in repo");
	// Product flavors make testDebugUnitTest/lintDebug ambiguous — warn so the user configures checks.
	const buildFiles = s.files.filter((f) => /build\.gradle(\.kts)?$/.test(f));
	if (buildFiles.some((f) => /productFlavors/.test(s.read(f)))) {
		warnings.push("productFlavors found — assembleDebug works, but you may want flavor-specific test/lint tasks in .minidev.json (stacks.android.checks)");
		facts.push("Uses product flavors");
	}
	if (s.has(/^gradle\/libs\.versions\.toml$/)) facts.push("Version catalog: gradle/libs.versions.toml");
	return {
		facts,
		warnings,
		checks: {
			subtask: [{ name: "assemble", command: `${G} assembleDebug`, timeoutSec: 1800 }],
			final: [
				{ name: "assemble", command: `${G} assembleDebug`, timeoutSec: 1800 },
				{ name: "unit-tests", command: `${G} testDebugUnitTest`, when: "hasTests", timeoutSec: 2400 },
				{ name: "lint", command: `${G} lintDebug`, blocking: false, timeoutSec: 1800 },
			],
		},
	};
}

async function has(bin: string): Promise<boolean> {
	return (await exec("bash", ["-lc", `command -v ${bin}`], { cwd: "/" })).code === 0;
}

async function iosProfile(s: Scan, derivedData: string, afterSetup = false): Promise<Partial<StackInfo>> {
	const facts: string[] = [];
	const warnings: string[] = [];
	const setup: string[] = [];

	// Project generation / dependency managers (run in setup before scheme detection).
	// After setup has run, skip this so scheme detection runs on the generated project.
	if (!afterSetup) {
		if (s.exists("project.yml") && !s.has(/\.xcodeproj\/project\.pbxproj$/)) {
			setup.push("xcodegen generate");
			facts.push("XcodeGen (project.yml) — edit project.yml, not the .xcodeproj");
			if (!(await has("xcodegen"))) warnings.push("xcodegen not installed");
		}
		if (s.exists("Project.swift") || s.exists("Tuist")) {
			setup.push("tuist install && tuist generate --no-open");
			facts.push("Tuist — edit Project.swift manifests, not the generated .xcodeproj");
			if (!(await has("tuist"))) warnings.push("tuist not installed");
		}
		if (s.exists("Podfile")) {
			if (!s.has(/^Pods\//)) setup.push("pod install");
			facts.push("CocoaPods (Podfile) — use the .xcworkspace");
			if (!(await has("pod"))) warnings.push("CocoaPods (pod) not installed");
		}
	}

	const xcodeOk = await has("xcodebuild");
	if (!xcodeOk) warnings.push("xcodebuild not found — iOS builds cannot run on this machine");

	const workspace = s.files.find((f) => /^[^/]+\.xcworkspace\/contents\.xcworkspacedata$/.test(f))?.split("/")[0];
	const project = s.files.find((f) => /^[^/]+\.xcodeproj\/project\.pbxproj$/.test(f))?.split("/")[0];
	const spmOnly = s.exists("Package.swift") && !workspace && !project && !setup.length;

	if (spmOnly) {
		facts.push("Swift Package (Package.swift) — files under Sources/<Target>/ are picked up automatically");
		return {
			facts,
			warnings,
			setup,
			checks: {
				subtask: [{ name: "swift-build", command: "swift build", timeoutSec: 1800 }],
				final: [
					{ name: "swift-build", command: "swift build", timeoutSec: 1800 },
					{ name: "swift-test", command: "swift test", when: "hasTests", timeoutSec: 2400 },
				],
			},
		};
	}

	// Xcode project/workspace: needs a scheme. Detection runs xcodebuild -list (only if no setup step must run first).
	const container = workspace ? `-workspace ${shellQuote(workspace)}` : project ? `-project ${shellQuote(project)}` : "";
	let scheme = "";
	if (xcodeOk && container && !setup.length) {
		const r = await exec("bash", ["-lc", `xcodebuild ${container} -list -json`], { cwd: s.root, timeoutMs: 120_000 });
		try {
			const j = JSON.parse(r.stdout);
			const schemes: string[] = j.workspace?.schemes ?? j.project?.schemes ?? [];
			const base = (workspace ?? project ?? "").replace(/\.(xcworkspace|xcodeproj)$/, "");
			scheme = schemes.find((x) => x === base) ?? schemes.find((x) => !/Tests?$|Pods|UITests/.test(x)) ?? schemes[0] ?? "";
			if (schemes.length) facts.push(`Schemes: ${schemes.join(", ")}`);
		} catch {
			/* leave scheme empty */
		}
	}
	if (!scheme) {
		warnings.push("Could not detect an Xcode scheme — set stacks.ios.checks in .minidev.json (or the scout will propose commands)");
		return { facts, warnings, setup, checks: { subtask: [], final: [] } };
	}
	facts.push(`Using ${workspace ? "workspace" : "project"} ${workspace ?? project}, scheme ${scheme}`);

	// A concrete simulator is needed to run tests.
	let simId = "";
	if (xcodeOk) {
		const r = await exec("xcrun", ["simctl", "list", "devices", "available", "-j"], { cwd: s.root, timeoutMs: 60_000 });
		try {
			const devs = Object.entries(JSON.parse(r.stdout).devices as Record<string, Array<{ udid: string; name: string }>>)
				.filter(([rt]) => /iOS/.test(rt))
				.sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }))
				.flatMap(([, d]) => d);
			const dev = devs.find((d) => /^iPhone/.test(d.name)) ?? devs[0];
			if (dev) {
				simId = dev.udid;
				facts.push(`Test simulator: ${dev.name} (${dev.udid})`);
			}
		} catch {
			/* no simulators */
		}
		if (!simId) warnings.push("No iOS simulator available — tests will be skipped");
	}

	const xb = `xcodebuild ${container} -scheme ${shellQuote(scheme)} -derivedDataPath ${shellQuote(derivedData)} -quiet CODE_SIGNING_ALLOWED=NO`;
	const pretty = (await has("xcbeautify")) ? " | xcbeautify --quiet" : "";
	const build = `set -o pipefail; ${xb} -destination 'generic/platform=iOS Simulator' build${pretty}`;
	const final: Check[] = [{ name: "xcode-build", command: build, timeoutSec: 2400 }];
	if (simId) {
		final.push({ name: "xcode-test", command: `set -o pipefail; ${xb} -destination 'platform=iOS Simulator,id=${simId}' test${pretty}`, when: "hasTests", timeoutSec: 3600 });
	}
	if (s.exists(".swiftlint.yml") && (await has("swiftlint"))) final.push({ name: "swiftlint", command: "swiftlint lint --quiet", blocking: false });
	return { facts, warnings, setup, checks: { subtask: [{ name: "xcode-build", command: build, timeoutSec: 2400 }], final } };
}

async function typescriptProfile(s: Scan): Promise<Partial<StackInfo>> {
	const facts: string[] = [];
	const warnings: string[] = [];
	let pm = "npm";
	if (s.exists("pnpm-lock.yaml")) pm = "pnpm";
	else if (s.exists("yarn.lock")) pm = "yarn";
	else if (s.exists("bun.lockb") || s.exists("bun.lock")) pm = "bun";
	if (pm !== "npm" && !(await has(pm))) warnings.push(`${pm} not installed`);
	facts.push(`Package manager: ${pm} (do not switch, do not create other lockfiles)`);

	const INSTALL: Record<string, string> = {
		pnpm: "pnpm install --frozen-lockfile",
		yarn: "yarn install --frozen-lockfile || yarn install --immutable",
		bun: "bun install --frozen-lockfile",
	};
	const install = INSTALL[pm] ?? (s.exists("package-lock.json") ? "npm ci" : "npm install");

	let scripts: Record<string, string> = {};
	let pkg: Record<string, unknown> = {};
	try {
		pkg = JSON.parse(s.read("package.json"));
		scripts = (pkg.scripts as Record<string, string>) ?? {};
	} catch {
		warnings.push("package.json could not be parsed");
	}
	const deps = { ...((pkg.dependencies as object) ?? {}), ...((pkg.devDependencies as object) ?? {}) } as Record<string, string>;
	const frameworks = ["next", "react", "vue", "svelte", "@angular/core", "@nestjs/core", "express", "fastify", "react-native", "expo", "electron"].filter((d) => d in deps);
	if (frameworks.length) facts.push(`Frameworks: ${frameworks.join(", ")}`);
	const testRunners = ["vitest", "jest", "mocha", "ava", "@playwright/test", "cypress"].filter((d) => d in deps);
	if (testRunners.length) facts.push(`Test tools: ${testRunners.join(", ")}`);
	if (pkg.workspaces || s.exists("pnpm-workspace.yaml") || s.exists("turbo.json") || s.exists("nx.json")) facts.push("Monorepo (workspaces/turbo/nx)");
	facts.push(`Module type: ${pkg.type === "module" ? "ESM" : "CommonJS (default)"}`);

	const run = (name: string) => (pm === "npm" ? `npm run -s ${name}` : `${pm} run ${name}`);
	const exe = pm === "npm" ? "npx" : pm === "bun" ? "bunx" : `${pm} exec`;
	const pick = (...names: string[]) => names.find((n) => scripts[n]);
	const isDummy = (cmd?: string) => !cmd || /no test specified/.test(cmd);

	const typecheckScript = pick("typecheck", "type-check", "tsc", "check-types", "types");
	const typecheck = typecheckScript ? run(typecheckScript) : s.exists("tsconfig.json") ? `${exe} tsc --noEmit -p .` : "";
	const buildScript = pick("build");
	const lintScript = pick("lint");
	const testScript = isDummy(scripts.test) ? pick("test:unit", "unit") : "test";
	const facts2 = Object.keys(scripts).length ? [`Scripts: ${Object.keys(scripts).join(", ")}`] : [];

	const subtask: Check[] = [];
	const final: Check[] = [];
	if (typecheck) {
		subtask.push({ name: "typecheck", command: typecheck, timeoutSec: 900 });
		final.push({ name: "typecheck", command: typecheck, timeoutSec: 900 });
	} else if (buildScript) {
		subtask.push({ name: "build", command: run(buildScript), timeoutSec: 1200 });
	}
	if (buildScript) final.push({ name: "build", command: run(buildScript), timeoutSec: 1800 });
	if (testScript) final.push({ name: "unit-tests", command: `CI=1 ${run(testScript)}`, timeoutSec: 1800 });
	if (lintScript) final.push({ name: "lint", command: run(lintScript), blocking: false, timeoutSec: 900 });
	if (!final.length) warnings.push("No typecheck/build/test scripts found");

	return { facts: [...facts, ...facts2], warnings, setup: [install], checks: { subtask, final } };
}

async function genericProfile(s: Scan): Promise<Partial<StackInfo>> {
	const facts: string[] = [];
	const subtask: Check[] = [];
	const final: Check[] = [];
	let flavour = "";
	const setup: string[] = [];
	if (s.exists("Cargo.toml")) {
		flavour = "Rust";
		subtask.push({ name: "cargo-check", command: "cargo check --all-targets" });
		final.push({ name: "cargo-build", command: "cargo build" }, { name: "cargo-test", command: "cargo test" }, { name: "clippy", command: "cargo clippy", blocking: false });
	} else if (s.exists("go.mod")) {
		flavour = "Go";
		subtask.push({ name: "go-build", command: "go build ./..." });
		final.push({ name: "go-build", command: "go build ./..." }, { name: "go-vet", command: "go vet ./...", blocking: false }, { name: "go-test", command: "go test ./...", when: "hasTests" });
	} else if (s.exists("pyproject.toml") || s.exists("setup.py") || s.exists("requirements.txt")) {
		flavour = "Python";
		subtask.push({ name: "compile", command: "python3 -m compileall -q $(git ls-files '*.py' | xargs -n1 dirname | sort -u) >/dev/null" });
		final.push({ name: "pytest", command: "python3 -m pytest -q", when: "hasTests" });
	} else if (s.exists("Makefile")) {
		flavour = "Make";
		const mk = s.read("Makefile");
		if (/^build:/m.test(mk)) subtask.push({ name: "make-build", command: "make build" });
		if (/^build:/m.test(mk)) final.push({ name: "make-build", command: "make build" });
		if (/^test:/m.test(mk)) final.push({ name: "make-test", command: "make test" });
		if (/^lint:/m.test(mk)) final.push({ name: "make-lint", command: "make lint", blocking: false });
	}
	if (flavour) facts.push(`Detected toolchain: ${flavour}`);
	const ci = s.files.filter((f) => /^(\.github\/workflows\/.*\.ya?ml|\.gitlab-ci\.yml|\.circleci\/config\.yml|Jenkinsfile|bitrise\.yml|azure-pipelines\.yml)$/.test(f));
	if (ci.length) facts.push(`CI config (source of truth for commands): ${ci.join(", ")}`);
	return { facts, setup, checks: { subtask, final }, label: flavour ? `Generic (${flavour})` : undefined };
}

interface ProfileArgs {
	s: Scan;
	derivedData: string;
}

type Profile = (a: ProfileArgs) => Promise<Partial<StackInfo>>;

const PROFILES: Record<StackId, Profile> = {
	android: ({ s }) => androidProfile(s),
	ios: ({ s, derivedData }) => iosProfile(s, derivedData),
	typescript: ({ s }) => typescriptProfile(s),
	generic: ({ s }) => genericProfile(s),
};

// ── public API ─────────────────────────────────────────────────────────────

export interface DetectOptions {
	/** Forced stack from config ("auto" = detect). */
	forced: Config["stack"];
	/** Where to keep per-run build products (Xcode DerivedData). */
	derivedData: string;
	/** Ask the user when several stacks match. */
	choose?: (candidates: StackId[], summary: string) => Promise<StackId | undefined>;
}

export async function detectStack(root: string, o: DetectOptions): Promise<StackInfo> {
	const s = await scan(root);
	const scores = score(s);
	const ranked = (["android", "ios", "typescript"] as StackId[])
		.filter((id) => scores[id].score >= 3)
		.sort((a, b) => scores[b].score - scores[a].score);

	let id: StackId;
	if (o.forced && o.forced !== "auto") id = o.forced;
	// Ask only when the runner-up is close (KMP, Flutter-ish hybrids); a tooling package.json in an
	// Android repo, or android/ + ios/ folders in a React Native repo, should not trigger a prompt.
	else if (ranked.length > 1 && o.choose && scores[ranked[1]].score >= scores[ranked[0]].score - 2) {
		const summary = ranked.map((r) => `${STACK_LABELS[r]}: ${scores[r].signals.join(", ")}`).join("\n");
		id = (await o.choose(ranked, summary)) ?? ranked[0];
	} else id = ranked[0] ?? "generic";

	const profile = await PROFILES[id]({ s, derivedData: o.derivedData });

	const checks = profile.checks ?? { subtask: [], final: [] };
	return {
		id,
		label: profile.label ?? STACK_LABELS[id],
		signals: o.forced && o.forced !== "auto" ? [`forced by config (stack: ${o.forced})`] : scores[id].signals,
		alsoDetected: ranked.filter((r) => r !== id),
		setup: profile.setup ?? [],
		checks,
		checksSource: checks.subtask.length || checks.final.length ? "detected" : "none",
		testPattern: TEST_PATTERNS[id],
		facts: profile.facts ?? [],
		warnings: profile.warnings ?? [],
	};
}

/** Re-run profile detection after setup (e.g. Xcode scheme detection needs the generated project). */
export async function refreshAfterSetup(root: string, info: StackInfo, derivedData: string): Promise<StackInfo> {
	if (info.id !== "ios" || info.checks.final.length) return info;
	const s = await scan(root);
	// Generated projects aren't tracked; look on disk too.
	const onDisk = fs.readdirSync(root).filter((f) => /\.(xcworkspace|xcodeproj)$/.test(f));
	for (const d of onDisk) s.files.push(d.endsWith(".xcworkspace") ? `${d}/contents.xcworkspacedata` : `${d}/project.pbxproj`);
	const p = await iosProfile(s, derivedData, true);
	const checks = p.checks ?? info.checks;
	return {
		...info,
		facts: [...new Set([...info.facts, ...(p.facts ?? [])])],
		warnings: (p.warnings ?? []).length ? (p.warnings as string[]) : info.warnings.filter((w) => !/scheme/.test(w)),
		checks,
		checksSource: checks.final.length ? "detected" : info.checksSource,
	};
}

export async function hasTests(root: string, stack: StackInfo | undefined): Promise<boolean> {
	const files = (await gitTry(root, ["ls-files", "--cached", "--others", "--exclude-standard"])) ?? "";
	const re = new RegExp(stack?.testPattern ?? TEST_PATTERNS.generic, "m");
	return re.test(files);
}

/**
 * Checks used for a run: explicit `checks` in config ▸ `stacks.<id>.checks` in config ▸ detected/scout.
 * Each of subtask/final resolves independently.
 */
export function effectiveChecks(cfg: Config, stack: StackInfo | undefined): Checks {
	const id = stack?.id ?? "generic";
	const perStack = cfg.stacks?.[id]?.checks;
	return {
		subtask: cfg.checks?.subtask ?? perStack?.subtask ?? stack?.checks.subtask ?? [],
		final: cfg.checks?.final ?? perStack?.final ?? stack?.checks.final ?? [],
	};
}

export function effectiveSetup(cfg: Config, stack: StackInfo): string[] {
	return cfg.setup ?? cfg.stacks?.[stack.id]?.setup ?? stack.setup;
}

/** Scout's proposed commands (JSON block) — used only when nothing was detected or configured. */
export interface ScoutCommands {
	setup?: string[];
	build?: string;
	typecheck?: string;
	test?: string;
	lint?: string;
}

export function applyScoutCommands(stack: StackInfo, cmds: ScoutCommands): boolean {
	if (stack.checksSource !== "none") return false;
	const quick = cmds.typecheck || cmds.build;
	const subtask: Check[] = quick ? [{ name: cmds.typecheck ? "typecheck" : "build", command: quick }] : [];
	const final: Check[] = [];
	if (cmds.build) final.push({ name: "build", command: cmds.build });
	if (cmds.typecheck && cmds.typecheck !== cmds.build) final.push({ name: "typecheck", command: cmds.typecheck });
	if (cmds.test) final.push({ name: "tests", command: cmds.test, when: "hasTests" });
	if (cmds.lint) final.push({ name: "lint", command: cmds.lint, blocking: false });
	if (!subtask.length && !final.length) return false;
	stack.checks = { subtask, final };
	stack.checksSource = "scout";
	return true;
}

export function describeStack(st: StackInfo, checks: Checks): string {
	const lines = [
		`**${st.label}** — ${st.signals.join(", ") || "no strong signals"}`,
		st.alsoDetected.length ? `Also matched: ${st.alsoDetected.map((x) => STACK_LABELS[x]).join(", ")}` : "",
		...st.facts.map((f) => `- ${f}`),
		st.setup.length ? `\nSetup: ${st.setup.map((c) => `\`${c}\``).join(", ")}` : "",
		`\nSubtask checks (${st.checksSource}): ${checks.subtask.map((c) => `\`${c.command}\``).join(", ") || "none"}`,
		`Final checks: ${checks.final.map((c) => `\`${c.name}\`${c.blocking === false ? " (non-blocking)" : ""}`).join(", ") || "none"}`,
		...st.warnings.map((w) => `⚠️ ${w}`),
	];
	return lines.filter(Boolean).join("\n");
}
