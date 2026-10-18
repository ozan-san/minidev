import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { UiDismiss } from "./config.ts";
import { STAGES, type RunState, type RunStatus, type Stage } from "./state.ts";
import { fmtDuration, fmtUsd } from "./util.ts";

export interface LiveAgent {
	role: string;
	label: string;
	model: string;
	costUsd: number;
	turns: number;
	startedAt: number;
}

export type ActivityKind = "tool" | "text" | "retry" | "info" | "check" | "commit";

export interface ActivityEntry {
	kind: ActivityKind;
	text: string;
	agent?: string;
}

export const MAX_ACTIVITY = 6;
export const MAX_LOG = 300;

/** Per-stage border colors; the current stage tints the panel frame. */
export const STAGE_COLORS: Record<Stage, ThemeColor> = {
	workspace: "borderMuted",
	detect: "border",
	scout: "toolOutput",
	plan: "borderAccent",
	build: "accent",
	test: "warning",
	review: "success",
	pr: "mdLink",
};

export interface DashboardView {
	state: RunState;
	agent?: LiveAgent;
	activity: ActivityEntry[];
	log: ActivityEntry[];
	note: string;
	startedStage: number;
	waitingSince?: number;
	now: number;
	version?: string;
	/** Terminal width available to the panel; when set, the frame is padded to it. */
	width?: number;
}

export function collapseActivity(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function pushActivity(list: ActivityEntry[], entry: ActivityEntry, max = MAX_LOG): ActivityEntry[] {
	const next = [...list, entry];
	return next.length > max ? next.slice(next.length - max) : next;
}

export function pipelineChips(
	state: RunState,
): Array<{ stage: Stage; status: "done" | "active" | "pending" | "failed" | "paused" }> {
	return STAGES.map((stage) => {
		if (state.completed.includes(stage)) return { stage, status: "done" as const };
		if (stage === state.stage) {
			if (state.status === "failed") return { stage, status: "failed" as const };
			if (state.status === "paused") return { stage, status: "paused" as const };
			return { stage, status: "active" as const };
		}
		return { stage, status: "pending" as const };
	});
}

export function budgetLevel(costUsd: number, budgetUsd: number): "ok" | "warn" | "over" {
	const ratio = costUsd / Math.max(budgetUsd, 0.0001);
	if (ratio >= 1) return "over";
	if (ratio >= 0.8) return "warn";
	return "ok";
}

/**
 * Whether the run panel should be removed when a run ends (config `ui.dismissOn`).
 * "done": only a successful run. "terminal": any run that is no longer running.
 * "never": keep the panel until the user dismisses it.
 */
export function shouldDismissPanel(status: RunStatus, dismissOn: UiDismiss): boolean {
	if (dismissOn === "never") return false;
	if (dismissOn === "done") return status === "done";
	return status !== "running";
}

export function progressBar(fraction: number, width: number): string {
	const clamped = Math.min(1, Math.max(0, fraction));
	const filled = Math.round(clamped * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

const ANSI_SGR = /\u001b\[[0-9;]*m/g;
const ANSI_SGR_EXACT = /^\u001b\[[0-9;]*m$/;

// Grapheme-aware width measurement, ported from pi-tui's `visibleWidth` /
// `graphemeWidth`. Kept local (no runtime pi-tui import) so this module stays
// loadable in tests, but matches the host closely enough that framed lines are
// never re-clipped by `truncateToWidth` in ui.ts.
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Code points rendered two cells wide (Unicode East Asian Width wide/fullwidth). */
const WIDE_RANGES = [
	4352, 4447, 8986, 8987, 9001, 9002, 9193, 9196, 9200, 9200, 9203, 9203,
	9725, 9726, 9748, 9749, 9776, 9783, 9800, 9811, 9855, 9855, 9866, 9871,
	9875, 9875, 9889, 9889, 9898, 9899, 9917, 9918, 9924, 9925, 9934, 9934,
	9940, 9940, 9962, 9962, 9970, 9971, 9973, 9973, 9978, 9978, 9981, 9981,
	9989, 9989, 9994, 9995, 10024, 10024, 10060, 10060, 10062, 10062, 10067, 10069,
	10071, 10071, 10133, 10135, 10160, 10160, 10175, 10175, 11035, 11036, 11088, 11088,
	11093, 11093, 11904, 11929, 11931, 12019, 12032, 12245, 12272, 12287, 12289, 12350,
	12353, 12438, 12441, 12543, 12549, 12591, 12593, 12686, 12688, 12773, 12783, 12830,
	12832, 12871, 12880, 42124, 42128, 42182, 43360, 43388, 44032, 55203, 63744, 64255,
	65040, 65049, 65072, 65106, 65108, 65126, 65128, 65131, 94176, 94180, 94192, 94198,
	94208, 101589, 101631, 101662, 101760, 101874, 110576, 110579, 110581, 110587, 110589, 110590,
	110592, 110882, 110898, 110898, 110928, 110930, 110933, 110933, 110948, 110951, 110960, 111355,
	119552, 119638, 119648, 119670, 126980, 126980, 127183, 127183, 127374, 127374, 127377, 127386,
	127488, 127490, 127504, 127547, 127552, 127560, 127568, 127569, 127584, 127589, 127744, 127776,
	127789, 127797, 127799, 127868, 127870, 127891, 127904, 127946, 127951, 127955, 127968, 127984,
	127988, 127988, 127992, 128062, 128064, 128064, 128066, 128252, 128255, 128317, 128331, 128334,
	128336, 128359, 128378, 128378, 128405, 128406, 128420, 128420, 128507, 128591, 128640, 128709,
	128716, 128716, 128720, 128722, 128725, 128728, 128732, 128735, 128747, 128748, 128756, 128764,
	128992, 129003, 129008, 129008, 129292, 129338, 129340, 129349, 129351, 129535, 129648, 129660,
	129664, 129674, 129678, 129734, 129736, 129736, 129741, 129756, 129759, 129770, 129775, 129784,
	131072, 196605, 196608, 262141,
];

const FULLWIDTH_RANGES = [12288, 12288, 65281, 65376, 65504, 65510];

function inRanges(ranges: number[], cp: number): boolean {
	let lo = 0;
	let hi = ranges.length / 2 - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const start = ranges[mid * 2];
		const end = ranges[mid * 2 + 1];
		if (cp < start) hi = mid - 1;
		else if (cp > end) lo = mid + 1;
		else return true;
	}
	return false;
}

function eastAsianWidth(cp: number): 1 | 2 {
	return inRanges(WIDE_RANGES, cp) || inRanges(FULLWIDTH_RANGES, cp) ? 2 : 1;
}

// Built via the constructor so the `v` flag does not require an ES2024 target.
const zeroWidthRegex = new RegExp(String.raw`^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$`, "v");
const leadingNonPrintingRegex = new RegExp(
	String.raw`^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+`,
	"v",
);
const nonPrintingCharRegex = new RegExp(
	String.raw`^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate})$`,
	"v",
);
const markCharRegex = new RegExp(String.raw`^\p{Mark}$`, "v");
const terminalSpacingMarkRegex = new RegExp(
	String.raw`^(?:[\p{Spacing_Mark}--[\u1734\u302E\u302F]]|[\u065F\u0F7F\u102B\u102C\u1031\u1033-\u1035\u1038\u103A-\u103E])+$`,
	"v",
);
const rgiEmojiRegex = new RegExp(String.raw`^\p{RGI_Emoji}$`, "v");

/** Fast pre-filter before the (expensive) RGI emoji regex. */
function couldBeEmoji(segment: string): boolean {
	const cp = segment.codePointAt(0) ?? 0;
	return (
		(cp >= 0x1f000 && cp <= 0x1fbff) ||
		(cp >= 0x2300 && cp <= 0x23ff) ||
		(cp >= 0x2600 && cp <= 0x27bf) ||
		(cp >= 0x2b50 && cp <= 0x2b55) ||
		segment.includes("\uFE0F") ||
		segment.length > 2
	);
}

/** Terminal cell width of a single grapheme cluster. */
function graphemeWidth(segment: string): number {
	if (segment.length === 1) {
		const code = segment.charCodeAt(0);
		if (code >= 0x20 && code <= 0x7e) return 1;
		if (code === 0x09) return 3;
	}
	if (terminalSpacingMarkRegex.test(segment)) return [...segment].length;
	if (zeroWidthRegex.test(segment)) return 0;
	if (couldBeEmoji(segment) && rgiEmojiRegex.test(segment)) return 2;
	const base = segment.replace(leadingNonPrintingRegex, "");
	const cp = base.codePointAt(0);
	if (cp === undefined) return 0;
	if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return 2;
	let width = eastAsianWidth(cp);
	let followsMark = false;
	const chars = [...base];
	for (const char of chars.slice(1)) {
		if (terminalSpacingMarkRegex.test(char)) {
			width += 1;
			followsMark = false;
		} else if (markCharRegex.test(char)) {
			followsMark = true;
		} else if (!nonPrintingCharRegex.test(char)) {
			const c = char.codePointAt(0) ?? 0;
			if (followsMark || (c >= 0xff00 && c <= 0xffef)) width += eastAsianWidth(c);
			else if (c === 0x0e33 || c === 0x0eb3) width += 1;
			followsMark = false;
		}
	}
	return width;
}

/** Visible cell count of a themed string (ANSI escape sequences are ignored). */
export function textWidth(text: string): number {
	const clean = text.replace(ANSI_SGR, "");
	if (clean.length === 0) return 0;
	let width = 0;
	for (const { segment } of graphemeSegmenter.segment(clean)) width += graphemeWidth(segment);
	return width;
}

/** Clip a themed string to `max` visible cells, keeping it reset-terminated. */
export function truncateVisible(text: string, max: number): string {
	if (max <= 0) return "";
	if (textWidth(text) <= max) return text;
	let out = "";
	let width = 0;
	let ansi = false;
	for (const part of text.split(/(\u001b\[[0-9;]*m)/)) {
		if (!part) continue;
		if (ANSI_SGR_EXACT.test(part)) {
			ansi = true;
			out += part;
			continue;
		}
		for (const { segment } of graphemeSegmenter.segment(part)) {
			const w = graphemeWidth(segment);
			if (width + w > max) return ansi ? `${out}\u001b[0m` : out;
			out += segment;
			width += w;
		}
	}
	return ansi ? `${out}\u001b[0m` : out;
}

/**
 * Draw a box around `lines` with box-drawing characters, colored by `color`.
 * With `width` the frame spans the terminal and content is clipped to width - 4;
 * without it the box hugs the widest line (keeps the renderers unit-testable).
 */
export function frameLines(lines: string[], th: Theme, opts: { color: ThemeColor; width?: number }): string[] {
	const widest = lines.reduce((max, l) => Math.max(max, textWidth(l)), 0);
	const inner = opts.width === undefined ? widest : Math.max(0, opts.width - 4);
	const bar = "─".repeat(inner + 2);
	const border = (text: string) => th.fg(opts.color, text);
	const body = lines.map((l) => {
		const clipped = truncateVisible(l, inner);
		return `${border("│")} ${clipped}${" ".repeat(Math.max(0, inner - textWidth(clipped)))} ${border("│")}`;
	});
	return [border(`╭${bar}╮`), ...body, border(`╰${bar}╯`)];
}

export function renderWidget(v: DashboardView, th: Theme): string[] {
	const s = v.state;
	const out: string[] = [];
	const statusColor =
		s.status === "failed" ? "error" : s.status === "paused" ? "warning" : s.status === "done" ? "success" : "accent";

	out.push(
		`${th.fg("accent", th.bold("minidev"))}${v.version ? ` ${th.fg("dim", v.version)}` : ""} ${th.fg("toolTitle", s.key)} ${th.fg("muted", s.title)}${s.stack ? th.fg("dim", ` [${s.stack.label}]`) : ""}  ${th.fg(statusColor, s.status)}${s.pauseReason ? th.fg("warning", ` (${s.pauseReason})`) : ""}`,
	);

	const pipeline = pipelineChips(s)
		.map(({ stage, status }) => {
			if (status === "done") return th.fg("success", `✓ ${stage}`);
			if (status === "failed") return th.fg("error", `✗ ${stage}`);
			if (status === "paused") return th.fg("warning", `⏸ ${stage}`);
			if (status === "active") return th.fg("accent", `⏳ ${stage}`);
			return th.fg("dim", `· ${stage}`);
		})
		.join(th.fg("dim", "  "));
	out.push(pipeline);

	if (s.subtasks.length && (s.stage === "build" || s.completed.includes("build"))) {
		const done = s.subtasks.filter((t) => t.status === "done").length;
		const chips = s.subtasks
			.map((t) =>
				t.status === "done"
					? th.fg("success", t.id)
					: t.status === "running"
						? th.fg("accent", `[${t.id}]`)
						: t.status === "failed"
							? th.fg("error", t.id)
							: th.fg("dim", t.id),
			)
			.join(" ");
		out.push(`${th.fg("muted", `subtasks ${done}/${s.subtasks.length}`)} ${chips}`);
	}

	const ratio = s.costUsd / Math.max(s.budgetUsd, 0.0001);
	const pct = Math.round(ratio * 100);
	const level = budgetLevel(s.costUsd, s.budgetUsd);
	const costColor = level === "ok" ? "toolOutput" : level === "warn" ? "warning" : "error";
	out.push(
		`${th.fg("muted", "cost")} ${th.fg(costColor, `${progressBar(ratio, 10)} ${fmtUsd(s.costUsd)} / ${fmtUsd(s.budgetUsd)} (${pct}%)`)}`,
	);

	const last = v.activity[v.activity.length - 1];
	if (v.agent) {
		const a = v.agent;
		out.push(
			`${th.fg("accent", "▶")} ${th.fg("toolTitle", a.label)} ${th.fg("dim", `${a.role} ${a.model}`)} ${th.fg("muted", `${a.turns} turns · ${fmtUsd(a.costUsd)} · ${fmtDuration(v.now - a.startedAt)}`)}`,
		);
		if (last) out.push(th.fg("dim", `   ↳ ${last.text}`));
	} else if (s.status === "running" && v.waitingSince) {
		out.push(th.fg("warning", v.note));
	} else if (s.status === "running") {
		out.push(`${th.fg("accent", "▶")} ${th.fg("muted", `${v.note || s.stage} · ${fmtDuration(v.now - v.startedStage)}`)}`);
	}

	const icons: Record<ActivityKind, string> = {
		tool: "",
		text: "» ",
		retry: "↻ ",
		check: "",
		commit: "● ",
		info: "",
	};
	for (const e of v.activity.slice(-MAX_ACTIVITY)) {
		out.push(`  ${th.fg("dim", icons[e.kind] + e.text)}`);
	}

	if (v.log.length > v.activity.length) {
		out.push(th.fg("dim", `  … ${v.log.length - v.activity.length} earlier · /minidev ui details`));
	}

	if (s.prUrl) out.push(`${th.fg("success", "PR")} ${s.prUrl}`);
	return frameLines(out, th, { color: STAGE_COLORS[s.stage], width: v.width });
}

export function renderDetail(v: DashboardView, th: Theme): string[] {
	const s = v.state;
	const out: string[] = [];
	const statusColor =
		s.status === "failed" ? "error" : s.status === "paused" ? "warning" : s.status === "done" ? "success" : "accent";

	out.push(
		`${th.fg("accent", th.bold("minidev"))}${v.version ? ` ${th.fg("dim", v.version)}` : ""} ${th.fg("accent", th.bold(s.key))} ${th.fg("muted", s.title)}${s.stack ? th.fg("dim", ` [${s.stack.label}]`) : ""}`,
	);
	out.push(
		`${th.fg(statusColor, s.status)} ${th.fg("dim", "@")} ${th.fg("toolTitle", s.stage)}${s.pauseReason ? th.fg("warning", ` (${s.pauseReason})`) : ""}${s.error ? th.fg("error", ` — ${s.error.split("\n")[0]}`) : ""}`,
	);

	const pipeline = pipelineChips(s)
		.map(({ stage, status }) => {
			if (status === "done") return th.fg("success", `✓ ${stage}`);
			if (status === "failed") return th.fg("error", `✗ ${stage}`);
			if (status === "paused") return th.fg("warning", `⏸ ${stage}`);
			if (status === "active") return th.fg("accent", `⏳ ${stage}`);
			return th.fg("dim", `· ${stage}`);
		})
		.join(th.fg("dim", "  "));
	out.push(pipeline);

	const ratio = s.costUsd / Math.max(s.budgetUsd, 0.0001);
	const pct = Math.round(ratio * 100);
	const level = budgetLevel(s.costUsd, s.budgetUsd);
	const costColor = level === "ok" ? "toolOutput" : level === "warn" ? "warning" : "error";
	out.push(
		`${th.fg("muted", "cost")} ${th.fg(costColor, `${progressBar(ratio, 10)} ${fmtUsd(s.costUsd)} / ${fmtUsd(s.budgetUsd)} (${pct}%)`)}`,
	);

	if (s.subtasks.length) {
		const done = s.subtasks.filter((t) => t.status === "done").length;
		out.push("", `${th.fg("muted", `Subtasks ${done}/${s.subtasks.length}`)}`);
		for (const t of s.subtasks) {
			const color: ThemeColor =
				t.status === "done"
					? "success"
					: t.status === "running"
						? "accent"
						: t.status === "failed"
							? "error"
							: "dim";
			const icon = t.status === "done" ? "✓" : t.status === "running" ? "▶" : t.status === "failed" ? "✗" : "·";
			out.push(`  ${th.fg(color, icon)} ${t.id} ${t.title} · ${t.attempts} attempts${t.commit ? ` · ${t.commit}` : ""}`);
		}
	}

	out.push("", `${th.fg("muted", `Agents (${s.agentRuns.length + (v.agent ? 1 : 0)})`)}`);
	for (const run of s.agentRuns) {
		out.push(`  ${th.fg(run.ok ? "success" : "error", agentSummary(run, v.now))}`);
	}
	if (v.agent) {
		out.push(
			`${th.fg("accent", "▶")} ${th.fg("toolTitle", `${v.agent.role} ${v.agent.label}`)} ${th.fg("muted", `${v.agent.turns} turns · ${fmtUsd(v.agent.costUsd)} · ${fmtDuration(v.now - v.agent.startedAt)}`)}`,
		);
	}
	if (!s.agentRuns.length && !v.agent) out.push(th.fg("dim", "  (none yet)"));

	if (s.checks.length) {
		out.push(`${th.fg("muted", "Checks")}`);
		for (const r of s.checks) {
			const color: ThemeColor = r.skipped ? "dim" : r.ok ? "success" : "error";
			out.push(
				`  ${th.fg(color, `${r.ok ? "✓" : "✗"} ${r.name}${r.skipped ? " (skipped)" : ""} · ${fmtDuration(r.durationMs)}`)}`,
			);
		}
	}

	out.push("", `${th.fg("muted", `Activity (${v.log.length})`)}`);
	for (const e of v.log.slice(-200)) {
		let color: ThemeColor = "dim";
		let icon = "";
		switch (e.kind) {
			case "text":
				color = "toolOutput";
				icon = "» ";
				break;
			case "retry":
				color = "warning";
				icon = "↻ ";
				break;
			case "check":
				color = "toolOutput";
				icon = e.text.includes("✗") ? "✗ " : "✓ ";
				break;
			case "commit":
				color = "accent";
				icon = "● ";
				break;
			case "tool":
			case "info":
				break;
		}
		out.push(`  ${th.fg(color, icon + e.text)}`);
	}

	out.push("", `${th.fg("muted", "Artifacts")}`);
	if (s.worktree) out.push(`  ${th.fg("dim", s.worktree)}`);
	if (s.runDir) out.push(`  ${th.fg("dim", s.runDir)}`);
	if (s.prUrl) out.push(`  ${th.fg("dim", s.prUrl)}`);

	out.push("", th.fg("dim", "esc close · ↑/↓ line · pgUp/pgDn page"));
	return frameLines(out, th, { color: STAGE_COLORS[s.stage], width: v.width });
}

export function agentSummary(
	run: {
		role: string;
		label: string;
		model: string;
		costUsd: number;
		turns: number;
		ok: boolean;
		startedAt: number;
		endedAt?: number;
	},
	now: number,
): string {
	return `${run.role} ${run.label} · ${run.turns} turns · ${fmtUsd(run.costUsd)} · ${fmtDuration((run.endedAt ?? now) - run.startedAt)}${run.ok ? " ✓" : " ✗"}`;
}
