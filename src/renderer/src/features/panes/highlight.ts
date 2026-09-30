/**
 * Line-level syntax coloring for the diff and file viewer (DESIGN §1.7 `--syn-*` roles).
 *
 * highlight.js is not bundled (see `getHljs` in tool-render/util), so this is a small, fast
 * tokenizer that knows comments, strings, numbers, keywords, types, calls and punctuation for the
 * common C-like, script and markup languages. It works one line at a time; a block comment or
 * template string spanning lines is carried across calls through `LineState`.
 */
import { languageFromPath } from "../../tool-render/util";

export type SynRole = "text" | "keyword" | "string" | "number" | "function" | "type" | "operator" | "comment" | "punct";

export interface SynToken {
	role: SynRole;
	text: string;
}

/** What is still open at the end of a line. */
export type LineState = null | "block-comment" | "template" | "triple-dq" | "triple-sq" | "markup-comment";

type Family = "c" | "hash" | "sql" | "markup" | "css";

interface LangSpec {
	family: Family;
	keywords: ReadonlySet<string>;
}

const words = (list: string): ReadonlySet<string> => new Set(list.split(" "));

const JS = words(
	"as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of package private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield keyof declare namespace abstract override",
);
const PY = words(
	"and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield match case",
);
const RUST = words(
	"as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
);
const GO = words(
	"break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false",
);
const C_LIKE = words(
	"auto break case catch char class const continue default delete do double else enum explicit extern false final float for friend goto if inline int long namespace new nullptr operator override private protected public return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while abstract boolean byte extends implements import instanceof interface native package super synchronized throws transient null var val fun when object data sealed is internal lateinit companion func let guard protocol extension self Self nil",
);
const SHELL = words(
	"if then else elif fi for in do done while until case esac function return local export readonly declare set unset shift exit source alias echo cd true false",
);
const RUBY = words(
	"alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require",
);
const SQL = words(
	"select from where and or not insert into values update set delete create table index view drop alter add column primary key foreign references join left right inner outer on group by order having limit offset as distinct union all null is in like between exists case when then else end default unique",
);
const NONE: ReadonlySet<string> = new Set();

const LANGS: Record<string, LangSpec> = {
	javascript: { family: "c", keywords: JS },
	typescript: { family: "c", keywords: JS },
	jsx: { family: "c", keywords: JS },
	tsx: { family: "c", keywords: JS },
	json: { family: "c", keywords: words("true false null") },
	rust: { family: "c", keywords: RUST },
	go: { family: "c", keywords: GO },
	c: { family: "c", keywords: C_LIKE },
	cpp: { family: "c", keywords: C_LIKE },
	csharp: { family: "c", keywords: C_LIKE },
	java: { family: "c", keywords: C_LIKE },
	kotlin: { family: "c", keywords: C_LIKE },
	swift: { family: "c", keywords: C_LIKE },
	scala: { family: "c", keywords: C_LIKE },
	dart: { family: "c", keywords: C_LIKE },
	php: { family: "c", keywords: C_LIKE },
	zig: { family: "c", keywords: C_LIKE },
	python: { family: "hash", keywords: PY },
	ruby: { family: "hash", keywords: RUBY },
	bash: { family: "hash", keywords: SHELL },
	shell: { family: "hash", keywords: SHELL },
	sh: { family: "hash", keywords: SHELL },
	zsh: { family: "hash", keywords: SHELL },
	yaml: { family: "hash", keywords: words("true false null yes no") },
	toml: { family: "hash", keywords: words("true false") },
	dockerfile: { family: "hash", keywords: words("FROM RUN CMD COPY ADD ENV ARG WORKDIR EXPOSE ENTRYPOINT USER VOLUME LABEL") },
	makefile: { family: "hash", keywords: NONE },
	sql: { family: "sql", keywords: SQL },
	html: { family: "markup", keywords: NONE },
	xml: { family: "markup", keywords: NONE },
	svg: { family: "markup", keywords: NONE },
	vue: { family: "markup", keywords: NONE },
	svelte: { family: "markup", keywords: NONE },
	css: { family: "css", keywords: NONE },
	scss: { family: "css", keywords: NONE },
	ini: { family: "hash", keywords: words("true false") },
	lua: { family: "sql", keywords: words("and break do else elseif end false for function goto if in local nil not or repeat return then true until while") },
	less: { family: "css", keywords: NONE },
};

/** Language id for a path (`null` → plain mono). */
export function languageFor(path: string): string | null {
	const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
	if (base === "makefile") return "makefile";
	const ext = base.slice(base.lastIndexOf(".") + 1);
	if (ext === "vue" || ext === "svelte") return ext;
	const lang = languageFromPath(path);
	return lang && LANGS[lang] ? lang : null;
}

const NUMBER = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[a-zA-Z]*|\.\d+)/;
const IDENT = /^[A-Za-z_$@][\w$]*/;
const OPERATOR = /^(?:=>|===|!==|==|!=|<=|>=|&&|\|\||\?\?|\?\.|\+\+|--|[-+*/%=<>!&|^~?:])/;
const PUNCT = /^[()[\]{},;.]/;

function push(tokens: SynToken[], role: SynRole, text: string): void {
	const last = tokens[tokens.length - 1];
	if (last && last.role === role) last.text += text;
	else tokens.push({ role, text });
}

/** Index just past the closing quote (honouring backslash escapes), or -1 when unterminated. */
function stringEnd(line: string, from: number, quote: string): number {
	for (let i = from; i < line.length; i++) {
		if (line[i] === "\\") i++;
		else if (line.startsWith(quote, i)) return i + quote.length;
	}
	return -1;
}

function tokenizeMarkup(line: string, state: LineState): { tokens: SynToken[]; state: LineState } {
	const tokens: SynToken[] = [];
	let i = 0;
	if (state === "markup-comment") {
		const end = line.indexOf("-->");
		if (end < 0) return { tokens: [{ role: "comment", text: line }], state };
		push(tokens, "comment", line.slice(0, end + 3));
		i = end + 3;
	}
	while (i < line.length) {
		if (line.startsWith("<!--", i)) {
			const end = line.indexOf("-->", i + 4);
			if (end < 0) {
				push(tokens, "comment", line.slice(i));
				return { tokens, state: "markup-comment" };
			}
			push(tokens, "comment", line.slice(i, end + 3));
			i = end + 3;
			continue;
		}
		const tag = /^<\/?([A-Za-z][\w:.-]*)/.exec(line.slice(i));
		if (tag) {
			push(tokens, "punct", tag[0].slice(0, tag[0].length - tag[1].length));
			push(tokens, "keyword", tag[1]);
			i += tag[0].length;
			// Attributes until the tag closes on this line.
			while (i < line.length && line[i] !== ">") {
				const rest = line.slice(i);
				const attr = /^[A-Za-z_:@][\w:.-]*/.exec(rest);
				if (attr) {
					push(tokens, "function", attr[0]);
					i += attr[0].length;
				} else if (line[i] === '"' || line[i] === "'") {
					const end = stringEnd(line, i + 1, line[i]);
					const stop = end < 0 ? line.length : end;
					push(tokens, "string", line.slice(i, stop));
					i = stop;
				} else {
					push(tokens, /[=/]/.test(line[i]) ? "punct" : "text", line[i]);
					i++;
				}
			}
			if (line[i] === ">") {
				push(tokens, "punct", ">");
				i++;
			}
			continue;
		}
		const next = line.indexOf("<", i + 1);
		const stop = next < 0 ? line.length : next;
		push(tokens, "text", line.slice(i, stop));
		i = stop;
	}
	return { tokens, state: null };
}

/** Tokenize one line. Pass the previous line's `state` to continue multi-line comments/strings. */
export function tokenizeLine(line: string, lang: string | null, state: LineState = null): { tokens: SynToken[]; state: LineState } {
	const spec = lang ? LANGS[lang] : undefined;
	if (!spec) return { tokens: line ? [{ role: "text", text: line }] : [], state: null };
	if (spec.family === "markup") return tokenizeMarkup(line, state);

	const tokens: SynToken[] = [];
	const { family, keywords } = spec;
	const lineComment = family === "c" || family === "css" ? "//" : family === "sql" ? "--" : "#";
	const blockComments = family === "c" || family === "css" || family === "sql";
	let i = 0;

	const closeOpen = (closer: string, role: SynRole): boolean => {
		const end = role === "comment" ? line.indexOf(closer) : stringEnd(line, 0, closer);
		if (end < 0) {
			push(tokens, role, line);
			return false;
		}
		const stop = role === "comment" ? end + closer.length : end;
		push(tokens, role, line.slice(0, stop));
		i = stop;
		return true;
	};
	if (state === "block-comment" && !closeOpen("*/", "comment")) return { tokens, state };
	if (state === "template" && !closeOpen("`", "string")) return { tokens, state };
	if (state === "triple-dq" && !closeOpen('"""', "string")) return { tokens, state };
	if (state === "triple-sq" && !closeOpen("'''", "string")) return { tokens, state };

	while (i < line.length) {
		const ch = line[i];
		if (ch === " " || ch === "\t") {
			const ws = /^[ \t]+/.exec(line.slice(i))?.[0] ?? ch;
			push(tokens, "text", ws);
			i += ws.length;
			continue;
		}
		if (line.startsWith(lineComment, i) && !(family === "css" && lang === "css")) {
			push(tokens, "comment", line.slice(i));
			break;
		}
		if (blockComments && line.startsWith("/*", i)) {
			const end = line.indexOf("*/", i + 2);
			if (end < 0) {
				push(tokens, "comment", line.slice(i));
				return { tokens, state: "block-comment" };
			}
			push(tokens, "comment", line.slice(i, end + 2));
			i = end + 2;
			continue;
		}
		if (family === "hash" && (line.startsWith('"""', i) || line.startsWith("'''", i))) {
			const quote = line.slice(i, i + 3);
			const end = stringEnd(line, i + 3, quote);
			if (end < 0) {
				push(tokens, "string", line.slice(i));
				return { tokens, state: quote === '"""' ? "triple-dq" : "triple-sq" };
			}
			push(tokens, "string", line.slice(i, end));
			i = end;
			continue;
		}
		if (ch === '"' || ch === "'" || (ch === "`" && family === "c")) {
			const end = stringEnd(line, i + 1, ch);
			if (end < 0) {
				push(tokens, "string", line.slice(i));
				// Only template literals legitimately continue onto the next line.
				return { tokens, state: ch === "`" ? "template" : null };
			}
			push(tokens, "string", line.slice(i, end));
			i = end;
			continue;
		}
		const rest = line.slice(i);
		const number = NUMBER.exec(rest);
		if (number && !/[\w$]/.test(line[i - 1] ?? "")) {
			push(tokens, "number", number[0]);
			i += number[0].length;
			continue;
		}
		const ident = IDENT.exec(rest);
		if (ident) {
			const word = ident[0];
			const after = line.slice(i + word.length).trimStart();
			const role: SynRole =
				keywords.has(family === "sql" ? word.toLowerCase() : word)
					? "keyword"
					: word.startsWith("@")
						? "type"
						: family === "css" && after.startsWith(":")
							? "function"
							: after.startsWith("(")
								? "function"
								: /^[A-Z][a-z0-9]\w*$/.test(word) && family !== "sql"
									? "type"
									: "text";
			push(tokens, role, word);
			i += word.length;
			continue;
		}
		const operator = OPERATOR.exec(rest);
		if (operator) {
			push(tokens, "operator", operator[0]);
			i += operator[0].length;
			continue;
		}
		push(tokens, PUNCT.test(ch) ? "punct" : "text", ch);
		i++;
	}
	return { tokens, state: null };
}

/** Tokenize many lines of one file, carrying multi-line state. */
export function tokenizeLines(lines: readonly string[], lang: string | null): SynToken[][] {
	let state: LineState = null;
	return lines.map(line => {
		const result = tokenizeLine(line, lang, state);
		state = result.state;
		return result.tokens;
	});
}

/** CSS color for a role, from the §1.7 tokens. */
export const SYN_CLASS: Record<SynRole, string> = {
	text: "text-(--syn-text)",
	keyword: "text-(--syn-keyword)",
	string: "text-(--syn-string)",
	number: "text-(--syn-number)",
	function: "text-(--syn-function)",
	type: "text-(--syn-type)",
	operator: "text-(--syn-operator)",
	comment: "text-(--syn-comment) italic",
	punct: "text-(--syn-punct)",
};
