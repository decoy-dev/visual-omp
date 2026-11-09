import type * as OsModule from "node:os";
import type * as FsModule from "node:fs";
import { watch } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpendSummary } from "@shared/contracts/extensions";
import { startFixture } from "../../../scripts/live-preview-fixture/server.mjs";
import { fixtureEnvironment } from "../../../scripts/live-preview-fixture/environment.mjs";
import { allSessions, findSessionFile, stopWatchingSessions, watchSessions } from "../omp/sessions";
import { sessionsDir } from "../omp/paths";
import { loadSavedToolOutput } from "../omp/session-tool-output";
import { renameSavedSession } from "../omp/session-rename";
import { register as registerComposer } from "./composer";
import { register as registerPanes } from "./panes";
import { register as registerExtensions } from "./extensions";

const fixture = vi.hoisted(() => ({
	home: "", env: {} as NodeJS.ProcessEnv,
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	broadcast: vi.fn(), promptHistory: vi.fn(), blob: vi.fn(), renameRpc: vi.fn(),
}));
vi.mock("node:os", async importOriginal => ({ ...(await importOriginal<typeof OsModule>()), homedir: () => fixture.home }));
vi.mock("node:fs", async importOriginal => {
	const actual = await importOriginal<typeof FsModule>();
	return { ...actual, watch: vi.fn(actual.watch) };
});
vi.mock("../env", () => ({ userEnv: async () => fixture.env }));
vi.mock("../ipc", () => ({ handle: (name: string, handler: (...args: unknown[]) => unknown) => fixture.handlers.set(name, handler), handleWithEvent: (name: string, handler: (...args: unknown[]) => unknown) => fixture.handlers.set(name, (...args) => handler({ sender: { id: 44 } }, ...args)), broadcast: fixture.broadcast, onBroadcast: vi.fn() }));
vi.mock("electron", () => ({ app: { on: vi.fn() }, BrowserWindow: {}, dialog: {}, shell: {}, nativeImage: {} }));
vi.mock("../prefs", () => ({ getPrefs: () => ({ archivedSessions: [], extraProjects: [] }), finishSessionPinMigration: vi.fn() }));
vi.mock("../omp/host", () => ({ getHost: vi.fn(), listHosts: () => [] }));
vi.mock("../omp/elsewhere", () => ({ sessionOwnership: async (files: string[]) => new Map(files.map(file => [file, "free"])) }));
vi.mock("../omp/rpc", () => ({ rpcRequest: vi.fn(), rpcRequests: fixture.renameRpc }));
vi.mock("../omp/config-file", () => ({ ompAgentDir: vi.fn() }));
vi.mock("../omp/predict", () => ({ closePredictions: vi.fn(), predictFeedback: vi.fn(), predictWord: vi.fn(), releasePredictionFolder: vi.fn(), retainPredictionFolder: vi.fn() }));
vi.mock("../omp/dictation", () => ({ closeDictation: vi.fn(), startDictation: vi.fn(), stopDictation: vi.fn() }));
vi.mock("../omp/native-bridge", () => ({ nativeBridge: vi.fn() }));
vi.mock("../services/prompt-history", () => ({ readPromptHistory: fixture.promptHistory }));
vi.mock("../services/panes", () => ({ inspectPaneFile: vi.fn(), readPaneFile: vi.fn(), readPdfFile: vi.fn(), previewablePath: vi.fn(), scanMadeFiles: vi.fn(), findPlanFile: vi.fn() }));
vi.mock("../services/preview-protocol", () => ({ grantBlobPreview: fixture.blob }));

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "vomp-xdg-callers-"));
	fixture.home = join(root, "home");
	fixture.env = { HOME: fixture.home, XDG_DATA_HOME: join(root, "data") };
	await mkdir(join(fixture.home, ".omp", "agent"), { recursive: true });
	await mkdir(join(root, "data", "omp", "sessions", "project"), { recursive: true });
	fixture.broadcast.mockClear(); fixture.promptHistory.mockClear(); fixture.blob.mockClear(); fixture.renameRpc.mockReset();
	vi.mocked(watch).mockClear();
	registerComposer(); registerPanes(); registerExtensions();
});
afterEach(async () => { stopWatchingSessions(); await rm(root, { recursive: true, force: true }); });

async function saveChat(id = "xdg-chat"): Promise<string> {
	const file = join(root, "data", "omp", "sessions", "project", `${id}.jsonl`);
	await writeFile(file, [
		JSON.stringify({ type: "session", id, cwd: root, timestamp: new Date().toISOString() }),
		JSON.stringify({ type: "message", id: "assistant", message: { role: "assistant", provider: "fixture", model: "preview", timestamp: Date.now(), content: [], usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.25 } } } }),
		JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "bash-1", toolName: "bash", content: [{ type: "text", text: "Saved XDG output" }] } }), "",
	].join("\n"));
	return file;
}

// Windows deliberately retains its agent directory; the cross-platform rule matrix is in history-path.test.ts.
describe.skipIf(process.platform === "win32")("shared XDG root callers", () => {
	it("lists and finds saved chats, reads config-root pins and discovers spend", async () => {
		const file = await saveChat();
		await writeFile(join(fixture.home, ".omp", "agent", "session-pins.json"), JSON.stringify(["xdg-chat"]));
		expect(await allSessions()).toMatchObject([{ id: "xdg-chat", file, pinned: true }]);
		expect(await findSessionFile("xdg-chat")).toBe(file);
		const spend = await fixture.handlers.get("extensions:spend")!(7) as SpendSummary;
		expect(spend.chats).toMatchObject([{ id: "xdg-chat", file }]);
		expect(spend.totals.cost).toBe(0.25);
	});
	it("selects the shared XDG root for the history watcher", async () => {
		await watchSessions();
		const file = await saveChat("watched");
		expect(watch).toHaveBeenCalledWith(join(root, "data", "omp", "sessions"), { recursive: true }, expect.any(Function));
		expect(await findSessionFile("watched")).toBe(file);
	});
	it("uses the shared root for prompt history and transcript blob images", async () => {
		await fixture.handlers.get("sessions:promptHistory")!("xdg-chat");
		await fixture.handlers.get("panes:readBlob")!("image-hash");
		expect(fixture.promptHistory).toHaveBeenCalledWith(join(root, "data", "omp", "history.db"), "xdg-chat");
		expect(fixture.blob).toHaveBeenCalledWith(join(root, "data", "omp", "blobs"), "image-hash", 44);
	});
	it("authorizes saved XDG output without a live host or follower", async () => {
		const file = await saveChat();
		expect(await loadSavedToolOutput(file, "bash-1")).toEqual({ status: "ready", content: [{ type: "text", text: "Saved XDG output" }] });
	});
	it("resolves the XDG saved summary before and after an omp-owned rename", async () => {
		const file = await saveChat();
		fixture.renameRpc.mockImplementation(async (_cwd, requests) => {
			requests[0].validate({ sessionFile: file, sessionId: "xdg-chat" });
			await writeFile(file, `${JSON.stringify({ type: "title", title: "Renamed XDG chat" })}\n${await readFile(file, "utf8")}`);
			return [{}, undefined, { sessionName: "Renamed XDG chat", sessionFile: file, sessionId: "xdg-chat" }];
		});
		expect(await renameSavedSession(file, "Renamed XDG chat")).toEqual({ title: "Renamed XDG chat", file, id: "xdg-chat", movedFrom: null });
	});
});

// Explicit opt-in, with an allowlisted fresh HOME and a provider bound only to loopback.
describe.skipIf(!process.env.VOMP_XDG_LIVE || !process.env.OMP_BIN || process.platform === "win32")("live isolated XDG discovery", () => {
	it("lists one omp chat, watches the next and discovers both in spend", async () => {
		const requests: unknown[] = [];
		const server = await startFixture({ root, port: 0, durationMs: 10, onRequest: request => requests.push(request) });
		fixture.env = fixtureEnvironment(root);
		fixture.home = fixture.env.HOME!;
		const createChat = () => {
			const { promise, resolve: accept, reject } = Promise.withResolvers<void>();
			const child = execFile(resolve(process.env.OMP_BIN!), ["--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--no-pty", "--model", "fixture/preview", "--thinking", "off", "-p", "fixture notes"], { env: fixture.env, cwd: join(root, "work"), timeout: 90000, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : accept());
			child.stdin?.end();
			return promise;
		};
		try {
			expect(sessionsDir(fixture.env)).toBe(join(root, "data", "omp", "sessions"));
			await createChat();
			const initial = await allSessions();
			expect(initial).toHaveLength(1);
			await watchSessions(); fixture.broadcast.mockClear();
			await createChat();
			await vi.waitFor(() => expect(fixture.broadcast).toHaveBeenCalledWith("sessions:changed", { cwd: null }), { timeout: 12000 });
			const chats = await allSessions();
			expect(chats).toHaveLength(2);
			expect(new Set(chats.map(chat => chat.id)).size).toBe(2);
			const spend = await fixture.handlers.get("extensions:spend")!(7) as SpendSummary;
			expect(spend.chats.map(chat => chat.id).sort()).toEqual(chats.map(chat => chat.id).sort());
			expect(spend.totals.requests).toBeGreaterThanOrEqual(2);
			expect(requests.length).toBeGreaterThanOrEqual(2);
		} finally { stopWatchingSessions(); await server.close(); }
	}, 180000);
});
