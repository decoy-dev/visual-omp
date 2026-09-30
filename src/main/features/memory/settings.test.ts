import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { memoryStatus, parseMemorySettings } from "./settings";

/** Memory-related keys of `omp config list --json` (memory.backend=mnemopi, per-project-tagged, bank=team). */
const configList: unknown = JSON.parse(readFileSync(join(__dirname, "fixtures", "config-list.json"), "utf8"));

describe("parseMemorySettings", () => {
	it("reads the effective memory settings, treating unset values as omp defaults", () => {
		expect(parseMemorySettings(configList)).toEqual({
			backend: "mnemopi",
			autolearn: false,
			mnemopi: { dbPath: null, bank: "team", scoping: "per-project-tagged" },
			hindsight: { apiUrl: "http://localhost:8888", bankId: null, scoping: "per-project-tagged" },
		});
	});

	it("falls back to off for an empty or unknown backend", () => {
		expect(parseMemorySettings({}).backend).toBe("off");
		expect(parseMemorySettings({ "memory.backend": { value: "zettelkasten" } }).backend).toBe("off");
	});
});

describe("memoryStatus", () => {
	it("points at the backend's storage", () => {
		const settings = parseMemorySettings(configList);
		const memories = resolve("agent", "memories");
		const dbPath = join(memories, "mnemopi", "mnemopi.db");
		const status = memoryStatus(settings, memories);
		expect(status).toMatchObject({
			enabled: true,
			location: dbPath,
			locationKind: "sqlite",
			mnemopi: { dbPath },
		});
		expect(isAbsolute(status.memoriesDir)).toBe(true);
		expect(isAbsolute(status.location ?? "")).toBe(true);
		expect(status.location).toBe(join(memories, "mnemopi", "mnemopi.db"));
		expect(memoryStatus({ ...settings, backend: "local" }, memories)).toMatchObject({
			location: memories,
			locationKind: "directory",
		});
		const sharpshooterStatus = memoryStatus({ ...settings, backend: "sharpshooter" }, memories);
		expect(sharpshooterStatus.location).toBe(join(memories, "sharpshooter"));
		expect(isAbsolute(sharpshooterStatus.location ?? "")).toBe(true);
		expect(memoryStatus({ ...settings, backend: "hindsight" }, memories)).toMatchObject({
			location: "http://localhost:8888",
			locationKind: "remote",
		});
		expect(memoryStatus({ ...settings, backend: "off" }, memories)).toMatchObject({ enabled: false, location: null });
	});
});
