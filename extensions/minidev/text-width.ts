/**
 * Terminal cell-width measurement for themed dashboard strings.
 *
 * Ported from pi-tui's `visibleWidth`/`graphemeWidth` but deliberately dependency-free (no runtime pi-tui import) so
 * the renderers stay loadable in unit tests, while still matching the host closely enough that framed lines are never
 * re-clipped by `truncateToWidth` in ui.ts.
 */
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
