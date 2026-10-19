/** Flags accepted by `/minidev run` (and the `/ticket` alias): --branch/--base <name>, --in-place, --worktree. Pure: no config, no I/O. */

export interface RunFlags {
	/** Base branch this run cuts from (and diffs/opens the PR against); wins over git.baseBranch. */
	baseBranch?: string;
	/** true for --in-place, false for --worktree, undefined when neither was given (use git.inPlace). */
	inPlace?: boolean;
	/** The ticket argument with all flags removed: a key, a file path or a title. */
	ticketArg: string;
	/** Unrecognized flags (or value-less --branch/--base), reported to the user and dropped. */
	unknown: string[];
}

export function parseRunFlags(raw: string): RunFlags {
	const tokens = raw.split(/\s+/).filter(Boolean);
	const out: RunFlags = { ticketArg: "", unknown: [] };
	const words: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--in-place") {
			out.inPlace = true;
		} else if (token === "--worktree") {
			out.inPlace = false;
		} else if (/^--(?:branch|base)=/.test(token)) {
			const value = token.replace(/^--(?:branch|base)=/, "");
			if (value) out.baseBranch = value;
			else out.unknown.push(token);
		} else if (token === "--branch" || token === "--base") {
			const next = tokens[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				out.baseBranch = next;
				i++;
			} else {
				out.unknown.push(token);
			}
		} else if (token.startsWith("--")) {
			out.unknown.push(token);
		} else {
			words.push(token);
		}
	}
	out.ticketArg = words.join(" ");
	return out;
}
