import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SavedOutputBlock, SavedToolOutput } from "@shared/session-output";

const boundary = vi.hoisted(() => ({
	handlers: new Map<string, unknown>(),
	hosts: [] as { sessionFile: string | null }[],
	followed: [] as string[],
}));
vi.mock("electron", () => ({
	app: {
		getPath: (name: string) => {
			if (name !== "userData" || !process.env.VOMP_DEV_PROFILE) throw new Error("Only the fixture userData boundary is available.");
			return process.env.VOMP_DEV_PROFILE;
		},
	},
	ipcMain: { handle: (name: string, handler: unknown) => { boundary.handlers.set(name, handler); } },
	BrowserWindow: { getAllWindows: () => [] },
}));
// These snapshots stand in for reports already received by main, not discovery or validation.
// Loading real hosts or followers would load native adapters or start ownership watchers.
vi.mock("../omp/host", () => ({ listHosts: () => boundary.hosts }));
vi.mock("../omp/follow", () => ({ followedSessionFiles: () => boundary.followed }));
// This unrelated handler must never run in the read-only fixture test.
vi.mock("../omp/session-rename", () => ({
	renameSavedSession: () => { throw new Error("The read-only fixture test cannot rename sessions."); },
}));

type ToolOutputHandler = (event: unknown, file: string, toolCallId: string, manual?: boolean) => Promise<SavedToolOutput>;
type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function within(root: string, file: string): boolean {
	const path = relative(root, file);
	return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

// Invoke through scripts/live-preview-fixture/run.mjs. Its HOME, XDG, PI_CODING_AGENT_DIR
// and actual app-profile are inherited unchanged; this test never patches the environment.
// Dynamic production imports keep skipped CI runs from reading the fixture's preferences.
describe.skipIf(!process.env.VOMP_TOOL_OUTPUT_LIVE_ROOT || !process.env.VOMP_TOOL_OUTPUT_LIVE_FILE)("live saved bash output through the registered session handler", () => {
	it("recovers the exact XDG fixture only while main owns a current reported session file", async () => {
		const evidence: JsonRecord = { status: "failed", handler: "sessions:toolOutput" };
		const childSpawns: unknown[] = [];
		const spawnChannel = channel("child_process");
		const onSpawn = (message: unknown): void => { childSpawns.push(message); };
		spawnChannel.subscribe(onSpawn);
		let stage = "fixture confinement";
		try {
			const rootInput = process.env.VOMP_TOOL_OUTPUT_LIVE_ROOT!;
			const fileInput = process.env.VOMP_TOOL_OUTPUT_LIVE_FILE!;
			expect(isAbsolute(rootInput)).toBe(true);
			expect(isAbsolute(fileInput)).toBe(true);
			const root = resolve(rootInput);
			const file = resolve(fileInput);
			expect(basename(root)).toMatch(/^vomp-preview\.[A-Za-z0-9_-]+$/);
			expect(within(root, file)).toBe(true);
			const canonicalRoot = await realpath(root);
			expect(within(canonicalRoot, await realpath(file))).toBe(true);
			const markerFile = join(root, "fixture.json");
			expect(within(canonicalRoot, await realpath(markerFile))).toBe(true);
			const marker: unknown = JSON.parse(await readFile(markerFile, "utf8"));
			expect(record(marker) && marker.root).toBe(root);

			const confinedEnvironment: Record<string, string> = {
				HOME: join(root, "home"),
				USERPROFILE: join(root, "home"),
				VOMP_DEV_PROFILE: join(root, "app-profile"),
				PI_CODING_AGENT_DIR: join(root, "home", ".omp", "agent"),
				XDG_CONFIG_HOME: join(root, "home", ".config"),
				XDG_DATA_HOME: join(root, "data"),
				XDG_STATE_HOME: join(root, "state"),
				XDG_CACHE_HOME: join(root, "cache"),
				TMPDIR: join(root, "tmp"),
				TMP: join(root, "tmp"),
				TEMP: join(root, "tmp"),
			};
			for (const [key, expected] of Object.entries(confinedEnvironment)) {
				expect(process.env[key], key).toBe(expected);
				// The unused XDG config directory need not exist.
				if (key !== "XDG_CONFIG_HOME") expect(within(canonicalRoot, await realpath(expected)), key).toBe(true);
			}
			expect(process.env.OMP_PROFILE).toBe("");
			expect(process.env.PI_CONFIG_DIR).toBe(".omp");
			const preferencesFile = join(confinedEnvironment.VOMP_DEV_PROFILE!, "preferences.json");
			expect(within(canonicalRoot, await realpath(preferencesFile))).toBe(true);
			const preferencesText = await readFile(preferencesFile, "utf8");
			const storedPreferences: unknown = JSON.parse(preferencesText);
			expect(record(storedPreferences)).toBe(true);

			stage = "real application environment";
			const { userEnv } = await import("../env");
			const environment = await userEnv();
			for (const [key, expected] of Object.entries(confinedEnvironment)) expect(environment[key], `userEnv ${key}`).toBe(expected);
			const { getPrefs } = await import("../prefs");
			expect(getPrefs()).toMatchObject(storedPreferences as JsonRecord);
			// Observe the real login-shell spawn so a silent subprocess observer cannot pass.
			expect(childSpawns.length).toBeGreaterThan(0);
			// Nothing below may start any subprocess.
			const environmentSpawns = childSpawns.length;

			stage = "legacy inferred session root";
			const { sessionsDir } = await import("../omp/paths");
			const inferredSessionDirectory = sessionsDir();
			const xdgSessionDirectory = join(root, "data", "omp", "sessions");
			expect(inferredSessionDirectory).toBe(join(root, "home", ".omp", "agent", "sessions"));
			expect(inferredSessionDirectory).not.toBe(xdgSessionDirectory);
			const inferredRootStatus = await stat(inferredSessionDirectory).then(
				() => ({ exists: true }),
				error => ({ exists: false, code: record(error) && typeof error.code === "string" ? error.code : "unknown" }),
			);
			evidence.fixture = { root, file, profile: confinedEnvironment.VOMP_DEV_PROFILE };
			evidence.roots = { inferredSessionDirectory, xdgSessionDirectory, inferredRootStatus, discovery: "none" };

			stage = "explicit saved fixture records";
			const transcript = await readFile(file, "utf8");
			const entries: unknown[] = transcript.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
			const header = entries.find((entry): entry is JsonRecord => record(entry) && entry.type === "session");
			expect(typeof header?.id).toBe("string");
			expect(typeof header?.cwd).toBe("string");
			expect(await realpath(header!.cwd as string)).toBe(await realpath(join(root, "work")));
			const results = entries.flatMap(entry => {
				if (!record(entry) || entry.type !== "message" || !record(entry.message)) return [];
				const message = entry.message;
				return message.role === "toolResult" && message.toolName === "bash" ? [message] : [];
			});
			expect(results).toHaveLength(3);
			expect(results.every(message => typeof message.toolCallId === "string" && message.toolCallId.length > 0)).toBe(true);
			expect(new Set(results.map(message => message.toolCallId)).size).toBe(3);
			expect(results.every(message => Object.hasOwn(message, "details"))).toBe(true);

			stage = "actual handler registration";
			const { register } = await import("./sessions");
			const { loadSavedToolOutput } = await import("../omp/session-tool-output");
			const { helperFileValidation } = await import("../omp/helper-file");
			const { setAppRendererUrl } = await import("../services/app-origin");
			const rendererUrl = "file:///visual-omp-fixture/index.html";
			setAppRendererUrl(rendererUrl);
			const frame = { url: rendererUrl };
			const event = { senderFrame: frame, sender: { mainFrame: frame } };
			register();
			expect(helperFileValidation(file)).toBeUndefined();
			const handler = boundary.handlers.get("sessions:toolOutput") as ToolOutputHandler;
			expect(typeof handler).toBe("function");

			stage = "no owned report";
			boundary.hosts = [{ sessionFile: null }];
			boundary.followed = [];
			for (const message of results) for (const manual of [false, true]) {
				expect(await handler(event, file, message.toolCallId as string, manual)).toEqual({ status: "unavailable" });
			}
			// Extra renderer arguments cannot supply the reader's main-only authority provider.
			expect(await Reflect.apply(handler, undefined, [event, file, "fixture-27-0", false, () => [file]])).toEqual({ status: "unavailable" });
			expect(boundary.hosts).toEqual([{ sessionFile: null }]);
			expect(boundary.followed).toEqual([]);
			evidence.withoutReport = { status: "unavailable", requestDidNotRegisterFile: true };

			stage = "existing legacy index gap";
			const { findSessionFile } = await import("../omp/sessions");
			const indexedFile = await findSessionFile(header!.id as string);
			expect(indexedFile).toBeNull();
			evidence.index = { file: indexedFile, root: inferredSessionDirectory, existingXdgGap: true, helperRegistration: false };

			const reads: JsonRecord[] = [];
			evidence.reads = reads;
			const readAll = async (authority: "host" | "follower"): Promise<void> => {
				for (const message of results) {
					expect(Array.isArray(message.content)).toBe(true);
					const expected = message.content as SavedOutputBlock[];
					const serialized = JSON.stringify(expected);
					for (const manual of [false, true]) {
						const output = manual
							? await handler(event, file, message.toolCallId as string, true)
							: await handler(event, file, message.toolCallId as string);
						const read: JsonRecord = { authority, toolCallId: message.toolCallId, mode: manual ? "manual" : "automatic", status: output.status };
						reads.push(read);
						expect(output.status, `${authority} ${message.toolCallId} ${read.mode}`).toBe("ready");
						if (output.status !== "ready") throw new Error("The actual saved output handler did not return ready content.");
						expect(Object.keys(output).sort()).toEqual(["content", "status"]);
						for (const block of output.content) expect(Object.keys(block).every(key => ["type", "text", "data", "mimeType"].includes(key))).toBe(true);
						expect(output.content).toEqual(expected);
						Object.assign(read, {
							blocks: output.content.length,
							contentBytes: Buffer.byteLength(serialized),
							sourceSha256: digest(serialized),
							returnedSha256: digest(JSON.stringify(output.content)),
							exactContentMatch: true,
							detailsOrTraceReturned: false,
						});
					}
				}
			};

			stage = "current host report";
			// Boundary shim for the actual sessionFile omp already reported, with no new omp process.
			boundary.hosts = [{ sessionFile: file }];
			await readAll("host");
			// A production report must not authorize direct reader calls with no provider.
			expect(await loadSavedToolOutput(file, "fixture-27-0")).toEqual({ status: "unavailable" });

			stage = "opened follower after host removal";
			boundary.hosts = [];
			boundary.followed = [file];
			await readAll("follower");

			stage = "closed reports revoke authority";
			boundary.followed = [];
			for (const message of results) for (const manual of [false, true]) {
				expect(await handler(event, file, message.toolCallId as string, manual)).toEqual({ status: "unavailable" });
			}
			evidence.afterClosure = { hostReports: 0, followerReports: 0, status: "unavailable" };
			expect(childSpawns.length - environmentSpawns).toBe(0);
			evidence.subprocessesAfterEnvironment = childSpawns.length - environmentSpawns;

			stage = "read-only source preservation";
			expect(await readFile(preferencesFile, "utf8")).toBe(preferencesText);
			expect(digest(await readFile(file, "utf8"))).toBe(digest(transcript));
			evidence.readOnly = { sourceUnchanged: true, profilePreferencesUnchanged: true };
			evidence.status = "passed";
		} finally {
			spawnChannel.unsubscribe(onSpawn);
			boundary.hosts = [];
			boundary.followed = [];
			if (evidence.status !== "passed") evidence.failedStage = stage;
			// Omit transcript text, details, prompts, configuration and credentials.
			await writeFile("/tmp/omp-c28fix-handler-evidence.json", `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
		}
	}, 120_000);
});
