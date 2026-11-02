import { StringDecoder } from "node:string_decoder";

export const STARTUP_DIAGNOSTIC_MAX_LINES = 8;
export const STARTUP_DIAGNOSTIC_MAX_CHARS = 1200;
const STARTUP_DIAGNOSTIC = /^(?:Error:\s*|Session file not found:\s*|Could not restore model\s+|Model (?:unavailable:\s*|.+ (?:not found|unavailable)\b)|No models available\.)/;

export interface StartupDiagnostic {
	text: string;
	resumeFileMissing: boolean;
}

function missingResumeFile(line: string): string | undefined {
	return /^(?:Error:\s*)?Session file not found:\s*(.+)$/.exec(line)?.[1]
		?? /^Error: Session "(.+)" not found\.$/.exec(line)?.[1];
}

/** Both transports use the same recognized failures and recovery classification. */
export function startupDiagnostic(lines: readonly string[], resumeFile?: string): StartupDiagnostic | null {
	const diagnostics = lines.map(line => line.trim()).filter(line => STARTUP_DIAGNOSTIC.test(line));
	if (!diagnostics.length) return null;
	const text = diagnostics.slice(-STARTUP_DIAGNOSTIC_MAX_LINES).join("\n");
	return {
		text: text.length > STARTUP_DIAGNOSTIC_MAX_CHARS ? `${text.slice(0, STARTUP_DIAGNOSTIC_MAX_CHARS - 1)}…` : text,
		resumeFileMissing: resumeFile !== undefined && diagnostics.some(line => missingResumeFile(line) === resumeFile),
	};
}

/** Pre-surface text only. Escape payloads and oversized lines are never buffered. */
export class StartupDiagnosticCapture {
	readonly #decoder = new StringDecoder("utf8");
	#escape: "text" | "escape" | "csi" | "string" | "string-escape" | "intermediate" = "text";
	#lines: string[] = [];
	#line = "";
	#lineOverflow = false;

	push(bytes: Uint8Array): void {
		this.#text(this.#decoder.write(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)));
	}

	end(): void {
		this.#text(this.#decoder.end());
	}

	diagnostic(resumeFile?: string): StartupDiagnostic | null {
		return startupDiagnostic([...this.#lines, this.#lineText()], resumeFile);
	}

	#lineText(): string {
		const line = this.#line.trim();
		return this.#lineOverflow ? `${line.slice(0, STARTUP_DIAGNOSTIC_MAX_CHARS - 1)}…` : line;
	}

	#text(text: string): void {
		for (const char of text) {
			if (this.#escape === "string-escape") {
				this.#escape = char === "\\" || char === "\x07" || char === "\x9c" ? "text" : char === "\x1b" ? "string-escape" : "string";
			} else if (this.#escape === "string") {
				if (char === "\x07" || char === "\x9c") this.#escape = "text";
				else if (char === "\x1b") this.#escape = "string-escape";
			} else if (char === "\x1b") this.#escape = "escape";
			else if (this.#escape === "escape") {
				this.#escape = char === "[" ? "csi" : "]PX^_".includes(char) ? "string" : char >= " " && char <= "/" ? "intermediate" : "text";
			} else if (this.#escape === "csi") {
				if (char >= "@" && char <= "~") this.#escape = "text";
			} else if (this.#escape === "intermediate") {
				if (char >= "0" && char <= "~") this.#escape = "text";
			} else if (char === "\x9b") this.#escape = "csi";
			else if ("\x90\x98\x9d\x9e\x9f".includes(char)) this.#escape = "string";
			else if (char === "\r" || char === "\n") {
				const line = this.#lineText();
				if (STARTUP_DIAGNOSTIC.test(line)) {
					this.#lines.push(line);
					this.#lines = this.#lines.slice(-STARTUP_DIAGNOSTIC_MAX_LINES);
					while (this.#lines.length > 1 && this.#lines.join("\n").length > STARTUP_DIAGNOSTIC_MAX_CHARS) this.#lines.shift();
					this.#lines = startupDiagnostic(this.#lines)!.text.split("\n");
				}
				this.#line = "";
				this.#lineOverflow = false;
			} else if (char >= " " && !(char >= "\x7f" && char <= "\x9f")) {
				if (this.#line.length < STARTUP_DIAGNOSTIC_MAX_CHARS + 1) this.#line += char;
				else this.#lineOverflow = true;
			}
		}
	}
}
