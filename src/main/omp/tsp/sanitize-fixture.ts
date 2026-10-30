import { Buffer } from "node:buffer";

/** OSC can carry the same private path as plain text and as an iTerm user variable. */
export function sanitizeFixtureText(text: string): string {
	return text
		.replace(/file:\/\/[^/\s\x07\x1b]+/g, "file://localhost")
		.replace(/\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/(?:T|C)(?:\/vomp-tsp-record-[^/\s"'\\]+)?/g, "/tmp/vomp-fixture")
		.replace(/\/(?:private\/)?tmp\/vomp-tsp-record-[^/\s"'\\]+/g, "/tmp/vomp-fixture")
		.replace(/\/(?:private\/)?tmp\/tsp-study/g, "/tmp/vomp-fixture")
		.replace(/\/Users\/[^/\s"'\\]+/g, "/tmp/vomp-fixture");
}

export function decodedOscPayloads(text: string): string[] {
	const decoded: string[] = [];
	for (const match of text.matchAll(/\x1b\]([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
		for (const token of match[1]!.matchAll(/[A-Za-z0-9+/]{8,}={0,2}/g)) {
			const bytes = Buffer.from(token[0], "base64");
			if (bytes.toString("base64").replace(/=+$/, "") !== token[0].replace(/=+$/, "")) continue;
			const value = bytes.toString("utf8");
			if (!value.includes("\ufffd")) decoded.push(value);
		}
	}
	return decoded;
}

/** Latin-1 preserves every unrelated byte, including UTF-8 and APC framing. */
export function sanitizeFixtureBytes(bytes: Uint8Array): Buffer {
	const text = sanitizeFixtureText(Buffer.from(bytes).toString("latin1"));
	const safe = text.replace(/\x1b\]([^\x07\x1b]*)(?:\x07|\x1b\\)/g, osc => osc.replace(/[A-Za-z0-9+/]{8,}={0,2}/g, token => {
		const decoded = Buffer.from(token, "base64");
		if (decoded.toString("base64").replace(/=+$/, "") !== token.replace(/=+$/, "")) return token;
		const original = decoded.toString("utf8");
		if (original.includes("\ufffd")) return token;
		const sanitized = sanitizeFixtureText(original);
		return sanitized === original ? token : Buffer.from(sanitized).toString("base64");
	}));
	return Buffer.from(safe, "latin1");
}
