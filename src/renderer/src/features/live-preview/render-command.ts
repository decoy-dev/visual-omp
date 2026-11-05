import type { PreviewSequencePattern } from "@shared/contracts/preview";

export interface RenderCommand {
	tool: "ffmpeg" | "remotion" | "manim" | "latex" | "blender";
	path: string | null;
	sequences: PreviewSequencePattern[];
}

export interface RenderInvocation {
	render: RenderCommand;
	/** Literal option argv for one FFmpeg input and output, or null when their scope is ambiguous. */
	ffmpegOptions: { input: readonly string[]; output: readonly string[] } | null;
}

const VIDEO = /\.(?:mp4|m4v|webm|mov|mkv|avi|gif)$/i;
const IMAGE = /\.(?:png|jpe?g|webp|bmp|tiff?|exr)$/i;
const FFMPEG_SWITCHES: Record<string, true> = { "-y": true, "-n": true, "-an": true, "-vn": true, "-sn": true, "-dn": true, "-shortest": true, "-nostdin": true, "-hide_banner": true, "-stats": true, "-nostats": true, "-re": true, "-copyts": true, "-start_at_zero": true };
const REMOTION_SWITCHES: Record<string, true> = { "--sequence": true, "--overwrite": true, "--muted": true, "--disable-web-security": true, "--disable-headless": true };
const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t" };
const BLENDER_FORMATS: Record<string, string> = { PNG: ".png", JPEG: ".jpg", OPEN_EXR: ".exr", TIFF: ".tif", BMP: ".bmp", WEBP: ".webp" };

function literalPath(value: string | undefined): string | null {
	if (!value || value === "-" || /[\x00\r\n$`*?]/.test(value) || /^(?:[a-z][a-z\d+.-]*:\/\/|pipe:|https?:|data:)/i.test(value)) return null;
	return value;
}

function splitPath(path: string): { folder: string; name: string } {
	const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return { folder: index < 0 ? "." : index === 2 && /^[A-Za-z]:/.test(path) ? path.slice(0, 3) : path.slice(0, index) || path[0], name: path.slice(index + 1) };
}

function sequence(path: string, placeholder: RegExp): PreviewSequencePattern | null {
	const { folder, name } = splitPath(path);
	const match = placeholder.exec(name);
	if (!match || /[%#]/.test(folder) || placeholder.test(name.slice(match.index + match[0].length))) return null;
	const digits = match[0][0] === "#" ? match[0].length : match[1] ? Number(match[1]) : null;
	if (digits !== null && (!Number.isSafeInteger(digits) || digits <= 0)) return null;
	return { folder, prefix: name.slice(0, match.index), digits, suffix: name.slice(match.index + match[0].length) };
}

/** Only literal shell words are inspected. No expansion or script execution occurs. */
function shellCommands(source: string): string[][] {
	const commands: string[][] = [];
	let args: string[] = [];
	let word = "";
	let quote = "";
	let started = false;
	let redirected = false;
	const pushWord = () => { if (started && !redirected) args.push(word); word = ""; started = false; };
	const pushCommand = () => { pushWord(); if (args.length) commands.push(args); args = []; redirected = false; };
	for (let index = 0; index < source.length; index++) {
		const ch = source[index];
		if (quote) {
			if (ch === quote) quote = "";
			else if (ch === "\\" && quote !== "'" && /[\\"`$\n]/.test(source[index + 1] ?? "")) word += source[++index];
			else word += ch;
			continue;
		}
		if (ch === "'" || ch === '"') { quote = ch; started = true; }
		else if (ch === "\\" && /[\s\\'";|&<>]/.test(source[index + 1] ?? "")) { const next = source[++index]; if (next !== "\n") { word += next; started = true; } }
		else if (ch === "#" && !started) { while (index < source.length && source[index] !== "\n") index++; pushCommand(); }
		else if (/[;|&\n]/.test(ch)) pushCommand();
		else if (/[<>]/.test(ch)) { pushWord(); redirected = true; }
		else if (/\s/.test(ch)) pushWord();
		else { word += ch; started = true; }
	}
	if (!quote) pushCommand();
	return commands;
}

function decodeLiteral(value: string): string | null {
	if (value[0] === "`" && value.includes("${")) return null;
	return value.slice(1, -1).replace(/\\([\\'"`nrt])/g, (_, ch: string) => ESCAPES[ch] ?? ch);
}

/** Eval supports literal subprocess argv, shell strings and tool.bash calls. Dynamic code stays unknown. */
function embeddedCommands(source: string): string[][] {
	const commands: string[][] = [];
	const literal = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60)`;
	const calls = new RegExp(String.raw`\b(?:subprocess\.(?:run|Popen|call|check_call|check_output)|(?:Bun\.)?spawn(?:Sync)?|exec(?:Sync|File|FileSync)?|(?:Bun\.)?\$)\s*(?:\(\s*)?(\[[^\]\n]*\]|${literal})`, "g");
	for (const match of source.matchAll(calls)) {
		const argument = match[1];
		if (argument.startsWith("[")) {
			const values = [...argument.matchAll(new RegExp(literal, "g"))];
			if (argument.slice(1, -1).replace(new RegExp(literal, "g"), "").replace(/[\s,]/g, "")) continue;
			const args = values.map(value => decodeLiteral(value[0]));
			if (args.length && args.every((value): value is string => value !== null)) commands.push(args);
		} else {
			const shell = decodeLiteral(argument);
			if (shell !== null) commands.push(...shellCommands(shell));
		}
	}
	const bash = new RegExp(String.raw`\b(?:tool\.)?bash\s*\(\s*\{\s*(?:[\s\S]*?\b)?command\s*:\s*(${literal})`, "g");
	for (const match of source.matchAll(bash)) {
		const shell = decodeLiteral(match[1]);
		if (shell !== null) commands.push(...shellCommands(shell));
	}
	return commands;
}

function executable(args: string[]): string[] {
	let index = 0;
	if (args[index] === "env") index++;
	while (/^[A-Za-z_]\w*=/.test(args[index] ?? "")) index++;
	if (/^(?:npx|bunx)$/.test(args[index] ?? "")) { index++; while (/^(?:--yes|-y|--no-install)$/.test(args[index] ?? "")) index++; }
	else if (args[index] === "uv" && args[index + 1] === "run") index += 2;
	else if (args[index] === "npm" && args[index + 1] === "exec") { index += 2; if (args[index] === "--") index++; }
	if (/^(?:python[\d.]*|uv)$/.test(splitPath(args[index] ?? "").name) && args[index + 1] === "-m" && args[index + 2] === "manim") index += 2;
	if (/^(?:node|bun)$/.test(splitPath(args[index] ?? "").name) && /[/\\]@remotion[/\\]cli[/\\]remotion-cli\.js$/.test(args[index + 1] ?? "")) return ["remotion", ...args.slice(index + 2)];
	return args.slice(index);
}

function option(args: string[], ...names: string[]): string | null {
	for (let index = args.length - 1; index >= 0; index--) {
		if (names.includes(args[index])) return literalPath(args[index + 1]);
		for (const name of names) if (args[index].startsWith(`${name}=`)) return literalPath(args[index].slice(name.length + 1));
	}
	return null;
}

function positionals(args: string[], switches: Readonly<Record<string, true>>): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg.startsWith("-")) { if (!switches[arg] && !arg.includes("=")) index++; }
		else values.push(arg);
	}
	return values;
}

function ffmpegOptions(args: string[]): RenderInvocation["ffmpegOptions"] {
	const inputs: string[][] = [];
	const outputs: string[][] = [];
	let pending: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "-i") {
			if (outputs.length || !args[index + 1]) return null;
			inputs.push(pending);
			pending = [];
			index++;
		} else if (arg !== "-" && arg.startsWith("-")) {
			pending.push(arg);
			if (!FFMPEG_SWITCHES[arg] && !arg.includes("=")) {
				const value = args[++index];
				if (value === undefined || value.startsWith("-")) return null;
				pending.push(value);
			}
		} else {
			if (!inputs.length) return null;
			outputs.push(pending);
			pending = [];
		}
	}
	return inputs.length === 1 && outputs.length === 1 && pending.length === 0 ? { input: inputs[0], output: outputs[0] } : null;
}

function parseArgs(raw: string[], output: string): RenderCommand | null {
	const args = executable(raw);
	const name = splitPath(args[0] ?? "").name.replace(/\.exe$/i, "");
	const rest = args.slice(1);
	if (rest.some(arg => /^(?:--?version|--help|-h)$/.test(arg))) return null;
	if (name === "ffmpeg") {
		const logged = [...output.matchAll(/Output #\d+,[^\r\n]*? to ['"]([^'"\r\n]+)['"]:/g)].at(-1)?.[1];
		const outputs = positionals(rest, FFMPEG_SWITCHES).map(literalPath).filter((path): path is string => path !== null && (VIDEO.test(path) || IMAGE.test(path)));
		const path = literalPath(logged) ?? (outputs.length === 1 ? outputs[0] : null);
		const pattern = path && IMAGE.test(path) ? sequence(path, /%0?(\d*)d/) : null;
		return { tool: "ffmpeg", path: path && !path.includes("%") ? path : null, sequences: pattern ? [pattern] : [] };
	}
	if (/^remotion(?:@[^/]+)?$/.test(name) && rest[0] === "render") {
		const values = positionals(rest.slice(1), REMOTION_SWITCHES);
		const logged = /^(?:Output[ \t]*=[ \t]*|Output[ \t]{2,})(.+?)[ \t]*$/m.exec(output)?.[1];
		const hasEntry = /\.(?:[cm]?[jt]sx?|html?)$/i.test(values[0] ?? "");
		const candidate = option(rest, "--output", "-o") ?? literalPath(logged) ?? literalPath(values.length >= (hasEntry ? 3 : 2) ? values.at(-1) : undefined);
		const isSequence = rest.some(arg => arg === "--sequence" || arg === "--sequence=true");
		if (isSequence) {
			const format = option(rest, "--image-format") ?? "jpeg";
			const folder = candidate && !/\.(?:[cm]?[jt]sx?|html?)$/i.test(candidate) ? candidate : null;
			return { tool: "remotion", path: null, sequences: folder && /^(?:png|jpeg)$/.test(format) ? [{ folder, prefix: "element-", digits: null, suffix: `.${format}` }] : [] };
		}
		return { tool: "remotion", path: candidate && VIDEO.test(candidate) ? candidate : null, sequences: [] };
	}
	if (name === "manim") {
		const pngs = rest.includes("--save_pngs") || option(rest, "--format") === "png";
		const imageLog = /\b\d+ images ready at ([^\r\n]+?)(?:\s{2,}|$)/m.exec(output)?.[1];
		const logged = /File ready at\s*['"]([^'"\r\n]+)['"]/m.exec(output)?.[1];
		if (pngs) {
			let prefixPath = literalPath(imageLog);
			if (!prefixPath) {
				const scriptIndex = rest.findIndex(arg => /\.py$/i.test(arg));
				const scene = rest[scriptIndex + 1];
				if (scriptIndex >= 0 && scene && /^[A-Za-z_]\w*$/.test(scene) && !rest.some(arg => /^(?:--config_file|--config-file)(?:=|$)/.test(arg)) && !rest.slice(scriptIndex + 2).some(arg => !arg.startsWith("-"))) {
					const script = splitPath(rest[scriptIndex]).name.replace(/\.py$/i, "");
					const mediaOption = option(rest, "--media_dir", "--media-dir");
					const outputOption = option(rest, "--output_file", "-o");
					const invalidMedia = rest.some(arg => /^(?:--media_dir|--media-dir)(?:=|$)/.test(arg)) && mediaOption === null;
					const invalidOutput = rest.some(arg => /^(?:--output_file|-o)(?:=|$)/.test(arg)) && outputOption === null;
					const media = mediaOption ?? "media";
					const base = (outputOption ?? scene).replace(/\.png$/i, "");
					if (!invalidMedia && !invalidOutput) prefixPath = literalPath(/^(?:[/\\]|[A-Za-z]:[/\\])/.test(base) ? base : `${media}/images/${script}/${base}`);
				}
			}
			const parts = prefixPath ? splitPath(prefixPath) : null;
			const padding = option(rest, "--zero_pad", "-0");
			const hasPadding = rest.some(arg => /^(?:--zero_pad|-0)(?:=|$)/.test(arg));
			const digits = padding === null ? hasPadding ? undefined : 4 : /^\d$/.test(padding) ? Number(padding) || null : undefined;
			return { tool: "manim", path: null, sequences: parts && digits !== undefined ? [{ folder: parts.folder, prefix: parts.name, digits, suffix: ".png" }] : [] };
		}
		return { tool: "manim", path: literalPath(logged), sequences: [] };
	}
	if (/^(?:pdf|lua|xe)?latex(?:mk)?$/.test(name) || name === "tectonic") {
		const logged = /Output written on (.+?) \(\d+ pages?\b/m.exec(output)?.[1];
		return { tool: "latex", path: literalPath(logged?.replace(/^['"]|['"]$/g, "")), sequences: [] };
	}
	if (name === "blender") {
		const target = option(rest, "-o", "--render-output");
		// Blender's // paths are relative to the .blend file, which this parser cannot resolve.
		const pattern = target && !target.startsWith("//") ? sequence(target, /#+/) : null;
		if (pattern && !pattern.suffix) {
			const format = option(rest, "-F", "--render-format");
			const suffix = format ? BLENDER_FORMATS[format] : null;
			if (suffix) pattern.suffix = suffix;
			else return { tool: "blender", path: null, sequences: [] };
		}
		const logged = /(?:^|\n)Saved:\s*['"]?([^\r\n]+?)['"]?\s*$/m.exec(output)?.[1];
		return { tool: "blender", path: pattern ? null : literalPath(logged), sequences: pattern ? [pattern] : [] };
	}
	return null;
}

/** Recognizes the same render as parseRenderCommand while retaining unambiguous FFmpeg option argv. */
export function parseRenderInvocation(command: string, output: string): RenderInvocation | null {
	const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
	const commands = [...shellCommands(command), ...embeddedCommands(command)];
	const results = new Map<string, RenderCommand>();
	let options: RenderInvocation["ffmpegOptions"] = null;
	let invocations = 0;
	for (const args of commands) {
		const result = parseArgs(args, clean);
		if (result) {
			results.set(JSON.stringify(result), result);
			invocations++;
			if (result.tool === "ffmpeg") options = ffmpegOptions(executable(args).slice(1));
		}
	}
	const render = results.size === 1 ? results.values().next().value : null;
	return render ? { render, ffmpegOptions: invocations === 1 ? options : null } : null;
}

/** Paths retain the command's spelling; the caller resolves them against the chat cwd. */
export function parseRenderCommand(command: string, output: string): RenderCommand | null {
	return parseRenderInvocation(command, output)?.render ?? null;
}
