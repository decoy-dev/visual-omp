/**
 * Which words in omp's replies may name a file or folder (DESIGN §4.6), and the per-reply cache of where they point.
 * The grammar only decides what is worth asking main about; a word becomes a link only when main finds a regular
 * file or folder for it. Kept free of the DOM so main's tests can run it against real files.
 */
import type { FileRef, FileRefRequest } from "@shared/contracts/fileRefs";

/** A line citation after a path: `:12`, `:12:5`, `:50-100`. */
const LINE_SUFFIX = /:\d+(?:[-:,+]\d+)*$/;
const DRIVE = /^[A-Za-z]:[\\/]/;
/** `/x`, `~/x`, `./x`, `../x` and `C:\x`, with either separator. */
const ROOT = /^(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])/;
/** An extension that starts with a letter, so versions (`1.2.3`) and decimals (`0.4s`) do not qualify. */
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;
/** Single letters joined by periods: `e.g`, `i.e`, `U.S` (a sentence's final period is already dropped). */
const ABBREVIATION = /^(?:[A-Za-z]\.)+[A-Za-z]$/;
/** Code spans holding shell syntax, globs or padding are commands or patterns. */
const CODE_REFUSED = /[<>"|?*$;={}`&\n\r\t]|\s{2}|^\s|\s$/;
const LETTER = /\p{L}/u;
const ALNUM = /[\p{L}\p{N}]/u;
/** Runs of characters a path in prose can hold; spaces and other punctuation end a run. */
const TEXT_RUN = /[\p{L}\p{N}_.@+~/\\:-]+/gu;
const MAX_LENGTH = 1024;

/**
 * The path to look up for `raw` (a code span's text, or a run from prose), or null when it cannot name a file:
 * absolute, `~/`, `./` and Windows drive paths, `a/b` forms, names ending in `/`, dotfiles, and bare names with
 * an extension. A trailing line citation (`:12`) is dropped from the path.
 */
export function fileRefOf(raw: string, code: boolean): string | null {
	const ref = raw.replace(LINE_SUFFIX, "");
	if (!ref || ref.length > MAX_LENGTH || (code && CODE_REFUSED.test(ref))) return null;
	// UNC and `//` paths (main refuses them), and colons outside a drive (`app:openExternal`, URL schemes).
	if (/^[\\/]{2}/.test(ref) || (ref.includes(":") && !(DRIVE.test(ref) && ref.indexOf(":", 2) < 0))) return null;
	const root = ROOT.exec(ref)?.[0] ?? "";
	const segments = ref.slice(root.length).split(/[\\/]/);
	if (segments.at(-1) === "") segments.pop();
	if (segments.length === 0 || segments.some(segment => segment === "") || !LETTER.test(ref)) return null;
	if (root || segments.length > 1 || /[\\/]$/.test(ref)) return ref;
	if (/^\.[\p{L}\p{N}_]/u.test(ref)) return ref;
	if (!EXTENSION.test(ref) || ABBREVIATION.test(ref)) return null;
	return ALNUM.test(ref.slice(0, ref.lastIndexOf("."))) ? ref : null;
}

export interface TextRef {
	/** Where the linked text starts and ends in the string, line citation included. */
	start: number;
	end: number;
	ref: string;
}

/** References in a run of prose, in order. A sentence's closing `.` or `:` stays outside the link. */
export function textRefs(text: string): TextRef[] {
	const found: TextRef[] = [];
	for (const match of text.matchAll(TEXT_RUN)) {
		const run = match[0].replace(/[.:]+$/, "");
		const ref = fileRefOf(run, false);
		if (ref) found.push({ start: match.index, end: match.index + run.length, ref });
	}
	return found;
}

/** Main's limits (`FILE_REF_LIMITS`): references and bases per request. */
export const MAX_REFS = 100;
export const MAX_BASES = 8;

/**
 * Where each reference occurrence of a reply points, by text block and then by occurrence in document order; null
 * when it names nothing on disk or lies past the request limit. Occurrences keep their own results because a
 * relative name resolves against the folders named before it, so one spelling can point at different files.
 */
export type ReplyRefs = readonly (readonly (FileRef | null)[])[];

/** The occurrences of each text block of a reply and the bases to resolve them in, computed only when needed. */
export type ReplyRefSource = () => { blocks: readonly (readonly string[])[]; bases: readonly string[] };

interface CacheEntry {
	texts: string;
	bases: string;
	value: ReplyRefs | null;
	/** The previous result for the same text, shown while new bases resolve so links do not blink out. */
	stale: ReplyRefs | null;
	promise: Promise<void>;
}

/**
 * Resolved references by reply, where a reply key names one chat and one message (a streamed reply and the saved entry
 * that replaces it share it). An entry holds the text and bases it was resolved with: other text under the same key
 * shows nothing until it resolves, and new bases re-resolve while the previous links stay visible.
 */
export class ReplyRefCache {
	readonly #entries = new Map<string, CacheEntry>();
	readonly #resolve: (request: FileRefRequest) => Promise<(FileRef | null)[]>;
	readonly #size: number;

	constructor(resolve: (request: FileRefRequest) => Promise<(FileRef | null)[]>, size = 300) {
		this.#resolve = resolve;
		this.#size = size;
	}

	/** The links to show for `reply` with this text (the joined text blocks), or null while none have resolved. */
	read(reply: string, texts: string): ReplyRefs | null {
		const entry = this.#entries.get(reply);
		return entry?.texts === texts ? (entry.value ?? entry.stale) : null;
	}

	/** Starts resolving `reply` for this text and these bases unless that is done or under way; resolves when it settles. */
	load(reply: string, texts: string, bases: string, source: ReplyRefSource): Promise<void> | null {
		const previous = this.#entries.get(reply);
		if (previous?.texts === texts && previous.bases === bases) return previous.value ? null : previous.promise;
		const entry: CacheEntry = {
			texts,
			bases,
			value: null,
			stale: previous?.texts === texts ? (previous.value ?? previous.stale) : null,
			promise: Promise.resolve(),
		};
		entry.promise = this.#lookup(source).then(
			value => {
				entry.value = value;
			},
			() => {
				entry.value = [];
			},
		);
		this.#entries.delete(reply);
		this.#entries.set(reply, entry);
		for (const old of this.#entries.keys()) {
			if (this.#entries.size <= this.#size) break;
			this.#entries.delete(old);
		}
		return entry.promise;
	}

	async #lookup(source: ReplyRefSource): Promise<ReplyRefs> {
		const { blocks, bases } = source();
		// One request in document order across the reply's blocks, so a folder named in one block applies to the next.
		const refs = blocks.flat().slice(0, MAX_REFS);
		const results = refs.length > 0 ? await this.#resolve({ refs, bases: bases.slice(0, MAX_BASES) }) : [];
		let next = 0;
		return blocks.map(block => block.map(() => results[next++] ?? null));
	}
}
