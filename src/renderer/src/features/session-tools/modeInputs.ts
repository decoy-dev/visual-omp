import type { ModeRequest } from "@shared/contracts/native";

export function goalBudget(text: string): number | undefined {
	if (!text.trim()) return undefined;
	const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(text.trim());
	const value = match ? Number(match[1]) * (match[2]?.toLowerCase() === "k" ? 1000 : match[2] ? 1_000_000 : 1) : NaN;
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error("budget");
	return value;
}

export function loopRequest(kind: "count" | "duration" | "until" | "while", value: string, check: string, prompt: string): Extract<ModeRequest, { mode: "loop"; action: "enter" }> {
	const request: Extract<ModeRequest, { mode: "loop"; action: "enter" }> = { mode: "loop", action: "enter" };
	if (prompt.trim()) request.prompt = prompt.trim();
	if (kind === "until" || kind === "while") {
		if (!check.trim()) throw new Error("condition");
		request.condition = { command: check.trim(), until: kind === "until" };
	} else if (kind === "count") {
		const iterations = Number(value);
		if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(iterations) || iterations <= 0) throw new Error("count");
		request.limit = { kind: "iterations", iterations };
	} else {
		const units: Record<string, number> = { s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000, m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000, h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000 };
		const text = value.trim().toLowerCase().replace(/\s+/g, "");
		const parts = [...text.matchAll(/(\d+)([a-z]+)/g)];
		const durationMs = parts.reduce((sum, part) => sum + Number(part[1]) * (units[part[2]!] ?? NaN), 0);
		if (parts.map(part => part[0]).join("") !== text || !Number.isSafeInteger(durationMs) || durationMs <= 0) throw new Error("duration");
		request.limit = { kind: "duration", durationMs };
	}
	return request;
}
