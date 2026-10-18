import * as fs from "node:fs";
import * as path from "node:path";

export interface Ticket {
	key: string;
	title: string;
	/** Markdown body: description, acceptance criteria, notes. */
	body: string;
	source: string;
	url?: string;
}

/**
 * A ticket source (e.g. Jira via MCP or REST). Register more sources in `SOURCES`.
 * Returning undefined from fetch means "not handled", so the next source (or manual entry) is tried.
 */
export interface TicketSource {
	name: string;
	matches(arg: string): boolean;
	fetch(arg: string, signal?: AbortSignal): Promise<Ticket | undefined>;
}

export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

const fileSource: TicketSource = {
	name: "file",
	matches: (arg) => /\.(md|txt)$/i.test(arg) || fs.existsSync(arg),
	async fetch(arg) {
		const file = path.resolve(arg);
		if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return undefined;
		return { ...parseTicketText(fs.readFileSync(file, "utf-8")), source: `file:${file}` };
	},
};

// Jira is not wired yet. When an Atlassian MCP/REST is available, add a source here that
// matches ISSUE_KEY_RE or Jira URLs and returns { key, title, body, url, source: "jira" }.
export const SOURCES: TicketSource[] = [fileSource];

export async function resolveTicket(arg: string, signal?: AbortSignal): Promise<Ticket | undefined> {
	for (const src of SOURCES) {
		if (!src.matches(arg)) continue;
		const t = await src.fetch(arg, signal);
		if (t) return t;
	}
	return undefined;
}

export const TICKET_TEMPLATE = (key = "") => `Key: ${key}
Title: 

## Description


## Acceptance Criteria
- 

## Notes
`;

/** Drop "##" sections whose content is only blank lines or bare "-" bullets (unfilled template sections). */
function dropEmptySections(body: string): string {
	const lines = body.split("\n");
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (/^##/.test(lines[i])) {
			let j = i + 1;
			while (j < lines.length && /^\s*-?\s*$/.test(lines[j])) j++;
			if (j === lines.length || /^##/.test(lines[j])) {
				i = j - 1;
				continue;
			}
		}
		out.push(lines[i]);
	}
	return out.join("\n").trim();
}

/** Parse pasted ticket text. Accepts "Key:"/"Title:" headers, otherwise uses the first line as title. */
export function parseTicketText(text: string): Omit<Ticket, "source"> {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	let key = "";
	let title = "";
	const rest: string[] = [];
	for (const line of lines) {
		const k = /^\s*key\s*:\s*(.*)$/i.exec(line);
		const t = /^\s*(?:title|summary)\s*:\s*(.*)$/i.exec(line);
		if (k && !key) key = k[1].trim();
		else if (t && !title) title = t[1].trim();
		else rest.push(line);
	}
	let body = rest.join("\n").trim();
	if (!title) {
		const first = body.split("\n").find((l) => l.trim());
		title = (first ?? "Untitled change").replace(/^#+\s*/, "").trim().slice(0, 120);
	}
	// Drop empty template sections.
	body = dropEmptySections(body);
	return { key: sanitizeKey(key) || generateKey(), title, body };
}

export function sanitizeKey(key: string): string {
	return key.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export function generateKey(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `MD-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function ticketMarkdown(t: Ticket): string {
	return `# ${t.key}: ${t.title}\n\n${t.url ? `Source: ${t.url}\n\n` : ""}${t.body || "(no description)"}\n`;
}
