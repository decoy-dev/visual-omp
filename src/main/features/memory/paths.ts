import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import type { MemoryEntryKind, StoredMemoryBackend } from "@shared/contracts/memory";
import { pathExists } from "../../files";
import { agentDir } from "../../omp/paths";
import { wyhash } from "./wyhash";

/**
 * omp's memories root: `<agent dir>/memories`, or `$XDG_STATE_HOME/omp/memories` when the default
 * agent dir is in use and `omp config init-xdg` created `$XDG_STATE_HOME/omp` (macOS/Linux).
 */
export async function memoriesDir(env: NodeJS.ProcessEnv): Promise<string> {
	const dir = resolve(agentDir(env));
	const xdgState = env.XDG_STATE_HOME;
	if (xdgState && process.platform !== "win32" && dir === join(homedir(), ".omp", "agent")) {
		const xdgRoot = join(xdgState, "omp");
		if (await pathExists(xdgRoot)) return join(xdgRoot, "memories");
	}
	return join(dir, "memories");
}

/** Directory name of a project's `local`-backend memory root (omp's `encodeProjectPath`). */
export function localScopeKey(cwd: string, platform: NodeJS.Platform = process.platform): string {
	const scoped = platform === "win32" ? cwd.toLowerCase() : cwd;
	return `--${scoped.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function limitBankName(name: string): string {
	if (name.length <= 64) return name;
	const hash = wyhash(name).toString(36);
	const prefix = name.slice(0, Math.max(1, 63 - hash.length)).replace(/-+$/g, "") || "bank";
	return `${prefix}-${hash}`;
}

/** omp's bank-name sanitizer; undefined for blank/unusable input. */
export function sanitizeBankName(value: string | null | undefined): string | undefined {
	const sanitized = value
		?.trim()
		.replace(/[^a-zA-Z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized ? limitBankName(sanitized) : undefined;
}

/**
 * Stable per-project bank segment shared by mnemopi and sharpshooter:
 * `<sanitized basename>-<Bun.hash(absolute path) in base 36>`.
 */
export function projectBankSegment(cwd: string): string {
	const root = resolve(cwd || ".");
	return limitBankName(`${sanitizeBankName(basename(root)) ?? "default"}-${wyhash(root).toString(36)}`);
}

/** mnemopi per-project bank for `cwd` given the configured `mnemopi.bank` base. */
export function mnemopiProjectBank(configuredBank: string | null, cwd: string): string {
	const base = sanitizeBankName(configuredBank);
	const project = projectBankSegment(cwd);
	return limitBankName(base ? `${base}-${project}` : project);
}

/**
 * Scope key of the mnemopi database at `mnemopi.dbPath` (the shared bank, whatever its name). `~` is
 * outside the bank-name alphabet, so it never collides with a `banks/<name>` directory.
 */
export const MNEMOPI_SHARED_KEY = "~shared";

const BankKey = z.string().regex(/^[A-Za-z0-9_-]+$/);
const ScopeKeySchemas = {
	local: z.string().regex(/^--[^/\\]*--$/),
	mnemopi: z.union([z.literal(MNEMOPI_SHARED_KEY), BankKey]),
	sharpshooter: BankKey,
} satisfies Record<StoredMemoryBackend, z.ZodType<string>>;

const BackendSchema = z.enum(["local", "mnemopi", "sharpshooter"]);
const KindSchema = z.enum([
	"summary",
	"memory",
	"raw",
	"rollout",
	"skill",
	"lesson",
	"working",
	"episodic",
	"fact",
	"decisions",
	"delta",
]) satisfies z.ZodType<MemoryEntryKind>;

export interface ScopeRef {
	backend: StoredMemoryBackend;
	key: string;
}

export interface EntryRef extends ScopeRef {
	kind: MemoryEntryKind;
	/** Kind-specific item key (file stem, lesson hash, row id, …). */
	item: string;
}

export function scopeId(ref: ScopeRef): string {
	return `${ref.backend}/${encodeURIComponent(ref.key)}`;
}

export function entryId(ref: EntryRef): string {
	return `${scopeId(ref)}/${ref.kind}/${encodeURIComponent(ref.item)}`;
}

/** Parse a scope id; rejects anything that could escape the backend's storage root. */
export function parseScopeId(id: string): ScopeRef {
	const [backendPart, keyPart, ...rest] = id.split("/");
	if (keyPart === undefined || rest.length > 0) throw new Error(`Invalid memory scope id: ${id}`);
	const backend = BackendSchema.parse(backendPart);
	return { backend, key: ScopeKeySchemas[backend].parse(decodeURIComponent(keyPart)) };
}

export function parseEntryId(id: string): EntryRef {
	const parts = id.split("/");
	const [backendPart, keyPart, kindPart, itemPart] = parts;
	if (itemPart === undefined || parts.length !== 4) throw new Error(`Invalid memory entry id: ${id}`);
	const scope = parseScopeId(`${backendPart}/${keyPart}`);
	return { ...scope, kind: KindSchema.parse(kindPart), item: decodeURIComponent(itemPart) };
}
