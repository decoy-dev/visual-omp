import { join } from "node:path";
import { z } from "zod";
import type { MemoryBackend, MemoryScoping, MemoryStatus } from "@shared/contracts/memory";

/** `omp config list --json`: every known setting key with its effective value (absent when unset). */
const ConfigListSchema = z.record(z.string(), z.object({ value: z.unknown().optional() }));

const BackendSchema = z.enum(["off", "local", "mnemopi", "sharpshooter", "hindsight"]).catch("off");
const ScopingSchema = z.enum(["global", "per-project", "per-project-tagged"]);
const OptionalText = z
	.string()
	.optional()
	.catch(undefined)
	.transform(value => value?.trim() || null);

/** The memory-related settings the GUI needs, as omp resolves them. */
export interface MemorySettings {
	backend: MemoryBackend;
	autolearn: boolean;
	mnemopi: { dbPath: string | null; bank: string | null; scoping: MemoryScoping };
	hindsight: { apiUrl: string; bankId: string | null; scoping: MemoryScoping };
}

/** Extract {@link MemorySettings} from `omp config list --json` output (defaults match omp's). */
export function parseMemorySettings(json: unknown): MemorySettings {
	const list = ConfigListSchema.parse(json);
	const value = (key: string): unknown => list[key]?.value;
	return {
		backend: BackendSchema.parse(value("memory.backend") ?? "off"),
		autolearn: z.boolean().catch(false).parse(value("autolearn.enabled")),
		mnemopi: {
			dbPath: OptionalText.parse(value("mnemopi.dbPath")),
			bank: OptionalText.parse(value("mnemopi.bank")),
			scoping: ScopingSchema.catch("per-project").parse(value("mnemopi.scoping")),
		},
		hindsight: {
			apiUrl: OptionalText.parse(value("hindsight.apiUrl")) ?? "http://localhost:8888",
			bankId: OptionalText.parse(value("hindsight.bankId")),
			scoping: ScopingSchema.catch("per-project-tagged").parse(value("hindsight.scoping")),
		},
	};
}

/** Shared-bank database path: `mnemopi.dbPath`, else `<memories>/mnemopi/mnemopi.db`. */
export function mnemopiDbPath(settings: MemorySettings, memoriesDir: string): string {
	return settings.mnemopi.dbPath ?? join(memoriesDir, "mnemopi", "mnemopi.db");
}

export function memoryStatus(settings: MemorySettings, memoriesDir: string): MemoryStatus {
	const dbPath = mnemopiDbPath(settings, memoriesDir);
	const locations = {
		off: { location: null, locationKind: null },
		local: { location: memoriesDir, locationKind: "directory" },
		mnemopi: { location: dbPath, locationKind: "sqlite" },
		sharpshooter: { location: join(memoriesDir, "sharpshooter"), locationKind: "directory" },
		hindsight: { location: settings.hindsight.apiUrl, locationKind: "remote" },
	} satisfies Record<MemoryBackend, Pick<MemoryStatus, "location" | "locationKind">>;
	return {
		backend: settings.backend,
		enabled: settings.backend !== "off",
		memoriesDir,
		...locations[settings.backend],
		autolearn: settings.autolearn,
		mnemopi: { dbPath, bank: settings.mnemopi.bank, scoping: settings.mnemopi.scoping },
		hindsight: settings.hindsight,
	};
}
