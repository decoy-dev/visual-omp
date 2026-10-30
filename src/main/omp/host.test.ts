import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Sessions from "./sessions";
import type { RelayEvents } from "./relay";
import type { TuiFocus } from "@shared/ipc";
import type { MessageBoxOptions } from "electron";
import { broadcast } from "../ipc";

const pty = vi.hoisted(() => ({
	data: null as ((data: string | Buffer) => void) | null,
	exit: null as ((event: { exitCode: number }) => void) | null,
	args: [] as string[],
	spawnOptions: null as { env: NodeJS.ProcessEnv; encoding?: string | null; useConptyDll?: boolean } | null,
	root: "",
	events: {} as RelayEvents,
	room: "room",
	sessionId: "old",
	focus: null as TuiFocus | null,
	cwd: "/tmp",
	location: undefined as { cwd: string; sessionFile: string | null; sessionId: string } | undefined,
	historyDbPath: undefined as string | undefined,
	shutdown: undefined as "teardown" | undefined,
	screen: [] as string[],
	keys: vi.fn(async (_keys: string) => {}),
	confirm: vi.fn(async (_options?: MessageBoxOptions) => ({ response: 0 })),
	writes: vi.fn(),
	kill: vi.fn(),
	resize: vi.fn(),
}));
vi.mock("node-pty", () => ({
	spawn: vi.fn((_bin, args: string[], options: typeof pty.spawnOptions) => {
		pty.args = args;
		pty.spawnOptions = options;
		return { pid: 123, onData: (fn: typeof pty.data) => (pty.data = fn), onExit: (fn: typeof pty.exit) => (pty.exit = fn), write: pty.writes, kill: pty.kill, resize: pty.resize };
	}),
}));
vi.mock("../env", () => ({ userEnv: async () => ({}), ptyEnv: (env: unknown) => env }));
vi.mock("../ipc", () => ({ broadcast: vi.fn() }));
vi.mock("../prefs", () => ({ getPrefs: () => ({ archivedSessions: [], extraProjects: [] }) }));
vi.mock("./cli", () => ({
	runOmpJson: async (args: string[]) =>
		args[1] === "list"
			? { hosts: [{ instanceId: "host", generation: 1, pid: 123, startedAt: Date.now(), sessionId: pty.sessionId, cwd: pty.cwd }] }
			: { url: `ws://localhost:9999/r/${pty.room}.key`, generation: 1 },
}));
vi.mock("./locate", () => ({ ompPath: async () => "/omp" }));
vi.mock("./refused", () => ({ ompStartError: (error: unknown) => error }));
vi.mock("./paths", () => ({ sessionsDir: () => pty.root, agentDir: () => pty.root }));
vi.mock("./sessions", async importOriginal => ({ ...(await importOriginal<typeof Sessions>()), onSessionsChanged: vi.fn() }));
vi.mock("./relay", () => ({
	LoopbackRelay: class {
		url = "ws://localhost:9999";
		set events(events: RelayEvents) { pty.events = events; }
		start = async () => {};
		stop() {}
	},
}));
vi.mock("./tui-debug", () => ({ TuiDebugClient: class { info = async () => pty.focus; screen = async () => pty.screen; keys = pty.keys; close() {} } }));
vi.mock("electron", () => ({ BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }, dialog: { showMessageBox: pty.confirm }, nativeTheme: { on: vi.fn(), removeListener: vi.fn(), shouldUseDarkColors: false }, systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: false }) } }));
vi.mock("./native-bridge", () => ({ createNativeBridge: async () => ({ extensionPath: "/native.mjs", url: "http://127.0.0.1/native", snapshot: { get location() { return pty.location; }, get historyDbPath() { return pty.historyDbPath; }, get shutdown() { return pty.shutdown; } }, close: async () => {} }) }));
// Route promise timers through the fake clock in deadline regressions.
vi.mock("node:timers/promises", () => ({ setTimeout: (ms: number, value?: unknown) => {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	setTimeout(() => resolve(value), ms);
	return promise;
} }));

import { SessionHost, type EditorInputTransaction } from "./host";
import { TspSession } from "./tsp/session";

let host: SessionHost;
beforeEach(async () => {
	vi.stubEnv("VOMP_TSP", "");
	pty.root = await mkdtemp(join(tmpdir(), "vomp-host-test-"));
	pty.events = {};
	pty.focus = null;
	pty.cwd = "/tmp";
	pty.location = undefined;
	pty.historyDbPath = undefined;
	pty.shutdown = undefined;
	pty.screen = [];
	pty.keys.mockReset().mockResolvedValue(undefined);
	pty.confirm.mockReset().mockResolvedValue({ response: 0 });
	pty.writes.mockReset();
	pty.kill.mockReset();
	pty.sessionId = "old";
	pty.room = "room";
	host = new SessionHost({ cwd: "/tmp", resumeFile: "/tmp/visual-omp-missing-session-host-test.jsonl" });
	await host.start();
});
afterEach(async () => {
	vi.useRealTimers();
	if (host.state.phase !== "exited") pty.exit?.({ exitCode: 0 });
	await vi.waitFor(() => expect(host.state.phase).toBe("exited"));
	await rm(pty.root, { recursive: true, force: true });
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

async function exit(code: number): Promise<void> {
	pty.exit?.({ exitCode: code });
	await vi.waitFor(() => expect(host.state.phase).toBe("exited"));
}

async function connect(room = "room", sessionId = "old"): Promise<void> {
	pty.room = room;
	pty.sessionId = sessionId;
	pty.events.onHostOpen?.(room);
	await vi.waitFor(() => expect(host.state).toMatchObject({ phase: "live", sessionId }));
}

describe("host overlay", () => {
	it("keeps only the pins that native rendering does not replace", async () => {
		const overlay = parse(await readFile(pty.args[1]!, "utf8"));
		expect(overlay).toMatchObject({
			collab: { autoStart: "control", relayUrl: "ws://localhost:9999", displayName: "visual-omp" },
			tui: { autoGraph: "always" },
			worktree: { onStart: "off" },
		});
		// Interim replies, SVG, predictions, recaps and worktree exit choices follow the user's omp settings.
		expect(overlay).not.toHaveProperty("out");
		expect(overlay).not.toHaveProperty("composer");
		expect(overlay).not.toHaveProperty("recap");
		expect(overlay.tui).not.toHaveProperty("renderSvg");
		expect(overlay.worktree).not.toHaveProperty("onExit");
	});
});

describe("startup exit", () => {
	it("flushes pending terminal writes and keeps the missing session path as the reason", async () => {
		pty.data?.("\u001b[31mSession file not found: /tmp/visual-omp-missing-session-host-test.jsonl\u001b[0m\r\n\r\n");
		await exit(1);
		expect(host.state.exitReason).toBe("Session file not found: /tmp/visual-omp-missing-session-host-test.jsonl");
		expect(host.state.resumeFileMissing).toBe(true);
		expect(host.state.exitCode).toBe(1);
	});

	it("keeps a named model failure without classifying it as a missing session", async () => {
		pty.data?.("Error: Could not restore model provider/model-name\r\nunrelated startup output\r\n");
		await exit(1);
		expect(host.state.exitReason).toBe("Error: Could not restore model provider/model-name");
		expect(host.state.resumeFileMissing).toBe(false);
	});

	it("retains only the final eight non-empty screen lines", async () => {
		pty.data?.(Array.from({ length: 12 }, (_, i) => `Error: detail ${i + 1}\r\n`).join(""));
		await exit(1);
		expect(host.state.exitReason?.split("\n")).toEqual(Array.from({ length: 8 }, (_, i) => `Error: detail ${i + 5}`));
	});

	it("joins a terminal-wrapped path without losing characters", async () => {
		const path = `/tmp/${"long-folder/".repeat(20)}session.jsonl`;
		pty.data?.(`Session file not found: ${path}\r\n`);
		await exit(1);
		expect(host.state.exitReason).toBe(`Session file not found: ${path}`);
		expect(host.state.resumeFileMissing).toBe(false);
	});

	it("retains the last non-empty startup screen when omp clears it", async () => {
		pty.data?.("Model unavailable: provider/model-name\r\n");
		// A write callback precedes the next output chunk, as it would after a separate terminal frame.
		await vi.waitFor(() => expect(host.serializedScreen()).toContain("Model unavailable"));
		pty.data?.("\u001b[2J\u001b[H");
		await exit(1);
		expect(host.state.exitReason).toBe("Model unavailable: provider/model-name");
	});

	it("leaves an empty exit reason unset", async () => {
		pty.data?.("\r\n   \r\n");
		await exit(1);
		expect(host.state.exitReason).toBeNull();
		expect(host.state.resumeFileMissing).toBe(false);
	});
});

describe("startup diagnostic boundaries", () => {
	it("limits a wrapped diagnostic to 1,200 characters", async () => {
		pty.data?.(`Error: ${"long diagnostic ".repeat(300)}\r\n`);
		await exit(1);
		expect(host.state.exitReason).toHaveLength(1200);
		expect(host.state.exitReason?.endsWith("…")).toBe(true);
	});

	it("excludes editor drafts, status chrome and unrecognized output before collab connects", async () => {
		pty.data?.(
			"private startup output\r\nError: Could not restore model provider/model-name\r\n" +
			"╭── π ▶ ⬢ Model · high ──╮\r\nSession file not found: /tmp/visual-omp-missing-session-host-test.jsonl\r\n" +
			"unsent private draft\r\n╰──────────────────────╯\r\n",
		);
		await exit(1);
		expect(host.state.exitReason).toBe("Error: Could not restore model provider/model-name");
		expect(host.state.resumeFileMissing).toBe(false);
	});

	it("never promotes live TUI content or an unrelated missing-file line after connection", async () => {
		await connect();
		pty.data?.("Session file not found: /tmp/visual-omp-missing-session-host-test.jsonl\r\nprivate draft\r\n");
		await exit(1);
		expect(host.state.exitReason).toBeNull();
		expect(host.state.resumeFileMissing).toBe(false);
	});

	it("forgets an earlier diagnostic as soon as the process opens its own collab room", async () => {
		pty.data?.("Error: transient startup message\r\n");
		await vi.waitFor(() => expect(host.serializedScreen()).toContain("transient"));
		await connect();
		await exit(1);
		expect(host.state.exitReason).toBeNull();
	});

	it("stops capture once the debug channel reports interactive focus", async () => {
		pty.focus = { focused: "Editor", overlays: 0, overlayKinds: [], altScreen: false };
		await vi.waitFor(() => expect(host.state.tui?.focused).toBe("Editor"));
		pty.data?.("Session file not found: /tmp/visual-omp-missing-session-host-test.jsonl\r\n");
		await exit(1);
		expect(host.state.exitReason).toBeNull();
		expect(host.state.resumeFileMissing).toBe(false);
	});

	it("stops capture when terminal input may have created an editable draft", async () => {
		host.write("Session file not found: /tmp/visual-omp-missing-session-host-test.jsonl");
		pty.data?.("Session file not found: /tmp/visual-omp-missing-session-host-test.jsonl\r\n");
		await exit(1);
		expect(host.state.exitReason).toBeNull();
		expect(host.state.resumeFileMissing).toBe(false);
	});

	it("does not classify a different missing path as the requested resume file", async () => {
		pty.data?.("Error: Session file not found: /some/other/chat.jsonl\r\n");
		await exit(1);
		expect(host.state.exitReason).toContain("/some/other/chat.jsonl");
		expect(host.state.resumeFileMissing).toBe(false);
	});

	it("ignores arbitrary screen output", async () => {
		pty.data?.("ordinary output without a recognized diagnostic\r\n");
		await exit(1);
		expect(host.state.exitReason).toBeNull();
	});

	it("does not turn a successful startup exit into an error diagnostic", async () => {
		pty.data?.("Error: Session file not found: /tmp/visual-omp-missing-session-host-test.jsonl\r\n");
		await exit(0);
		expect(host.state.exitReason).toBeNull();
		expect(host.state.resumeFileMissing).toBe(false);
	});
});

describe("session-file ownership", () => {
	it("ignores a sibling continuation from another process and follows only this host's reconnect", async () => {
		const bucket = join(pty.root, "project");
		await mkdir(bucket);
		const oldFile = join(bucket, "old.jsonl");
		const newFile = join(bucket, "new.jsonl");
		const header = (id: string, extra = {}) => `${JSON.stringify({ type: "session", id, cwd: "/tmp", ...extra })}\n`;
		await writeFile(oldFile, header("old"));
		await connect("original-room", "old");
		expect(host.state.sessionFile).toBe(oldFile);
		await writeFile(newFile, header("new", { continuationOf: "old", parentSession: "old" }));
		await host.refreshSessionFile();
		expect(host.state).toMatchObject({ sessionId: "old", sessionFile: oldFile, generation: 1 });
		pty.events.onHostClose?.("original-room");
		await connect("replacement-room", "new");
		expect(host.state).toMatchObject({ sessionId: "new", sessionFile: newFile, generation: 2 });
		await host.refreshSessionFile();
		expect(host.state).toMatchObject({ sessionId: "new", sessionFile: newFile, generation: 2 });
	});
});

describe("native host observations", () => {
	it("parses split OSC records and clears the previous root status", async () => {
		pty.data?.("\u001b]7501;state=blocked:kind=question:app=omp:msg=V2hhdCBuZXh0Pw==\u001b");
		pty.data?.("\\");
		await vi.waitFor(() => expect(host.state.programStatus).toEqual({ state: "blocked", kind: "question", msg: "What next?" }));
		pty.data?.("\u001b]7501;state=clear\u0007");
		await vi.waitFor(() => expect(host.state.programStatus).toBeNull());
	});

	it("captures model substitution notices after collab connects, excluding the editor", async () => {
		await connect();
		pty.data?.("Warning: Default model provider/missing not found. Using provider/available\r\n");
		await vi.waitFor(() => expect(host.state.notices?.[0]?.text).toContain("Using provider/available"));
		host.write("a private draft");
		pty.data?.("Warning: Default model private/draft not found. Using private/model\r\n");
		await exit(0);
		expect(host.state.notices).toHaveLength(1);
	});

	it("offers restore only for a nonzero exit lacking this launch's session_exit record", async () => {
		const bucket = join(pty.root, "crash"); await mkdir(bucket);
		const file = join(bucket, "old.jsonl");
		await writeFile(file, `${JSON.stringify({ type: "session", id: "old", cwd: "/tmp" })}\n`);
		await connect();
		await exit(1);
		expect(host.state.restoreAvailable).toBe(true);
	});

	it("starts an explicit recovery with --restore and follows omp's moved folder", async () => {
		await exit(0);
		host = new SessionHost({ cwd: "/tmp", resumeFile: "/tmp/chat.jsonl", restore: true });
		await host.start();
		expect(pty.args).toContain("--restore");
		expect(pty.args).not.toContain("--resume");
		pty.cwd = "/tmp/worktree";
		await connect("moved", "old");
		expect(host.state.cwd).toBe("/tmp/worktree");
		pty.cwd = "/tmp";
	});
});

describe("native worktree lifecycle", () => {
	it("follows same-id moves without a collab reconnect and ignores unmaterialized paths", async () => {
		pty.location = { cwd: "/tmp/worktree", sessionId: "old", sessionFile: join(pty.root, "not-written.jsonl") };
		await vi.waitFor(() => expect(host.state.cwd).toBe("/tmp/worktree"));
		expect(host.state.sessionFile).toBeNull();
		const file = join(pty.root, "moved.jsonl");
		await writeFile(file, `${JSON.stringify({ type: "session", id: "old", cwd: "/tmp/worktree" })}\n`);
		pty.location = { ...pty.location, sessionFile: file };
		await vi.waitFor(() => expect(host.state.sessionFile).toBe(file));
		expect(host.state.generation).toBe(0);
	});

	it("waits for a native worktree decision before finishing shutdown", async () => {
		await connect();
		const decision = Promise.withResolvers<{ response: number }>();
		pty.confirm.mockImplementationOnce(() => decision.promise);
		pty.keys.mockImplementationOnce(async () => { pty.screen = []; });
		pty.screen = ["╭─ Remove worktree? ───────╮", "│                          │", "│ /tmp/worktree (wt/test): has uncommitted changes │", "│                          │", "│  ❯ Yes                   │", "│    No                    │", "│                          │", "│ ↑/↓ navigate ⏎ select ⎋ cancel │", "╰──────────────────────────╯"];
		pty.focus = { focused: "HookSelector", overlays: 0, overlayKinds: [], altScreen: false };
		const stop = host.stop();
		await vi.waitFor(() => expect(pty.confirm).toHaveBeenCalledOnce());
		expect(pty.kill).not.toHaveBeenCalled();
		decision.resolve({ response: 0 });
		await vi.waitFor(() => expect(pty.keys).toHaveBeenCalledWith("down enter"));
		await exit(0);
		await stop;
		expect(pty.kill).not.toHaveBeenCalled();
	});
});

it("ignores a second relay room until the owning room closes", async () => {
	await connect("owning-room", "old");
	const owned = host.state;
	pty.events.onHostOpen?.("injected-room");
	expect(host.state).toBe(owned);
	pty.events.onHostClose?.("injected-room");
	expect(host.state).toBe(owned);
	pty.events.onHostClose?.("owning-room");
	await connect("successor-room", "old");
	expect(host.state.generation).toBe(2);
});

it("answers a startup worktree question natively before typing a queued message", async () => {
	const decision = Promise.withResolvers<{ response: number }>();
	pty.confirm.mockImplementationOnce(() => decision.promise);
	pty.keys.mockImplementationOnce(async () => { pty.screen = []; });
	pty.screen = ["╭─ Create a worktree for this session? ─╮", "│                                     │", "│ Work happens on a new wt/* branch.   │", "│                                     │", "│  ❯ Yes                              │", "│    No                               │", "│                                     │", "│ ↑/↓ navigate ⏎ select ⎋ cancel      │", "╰─────────────────────────────────────╯"];
	const pending = host.submit("Queued message");
	await vi.waitFor(() => expect(pty.confirm).toHaveBeenCalledOnce());
	expect(pty.writes).not.toHaveBeenCalled();
	decision.resolve({ response: 1 });
	await pending;
	expect(pty.keys).toHaveBeenCalledWith("enter");
	expect(pty.writes).toHaveBeenCalledWith("\u001b[200~Queued message\u001b[201~\r");
});

const startupQuestion = ["╭─ Create a worktree for this session? ─╮", "│                                     │", "│ New wt/* branch                     │", "│                                     │", "│  ❯ Yes                              │", "│    No                               │", "│                                     │", "│ ↑/↓ navigate ⏎ select ⎋ cancel      │", "╰─────────────────────────────────────╯"];

describe("serialized application input", () => {
	it("cancels a pending submission when shutdown supersedes its startup decision", async () => {
		const decision = Promise.withResolvers<{ response: number }>();
		pty.screen = startupQuestion;
		pty.confirm.mockImplementationOnce(() => decision.promise);
		pty.keys.mockImplementationOnce(async () => { pty.screen = []; });
		const pending = host.submit("Must remain unsent");
		const rejected = expect(pending).rejects.toThrow("closing this chat");
		await vi.waitFor(() => expect(pty.confirm).toHaveBeenCalledOnce());
		const stopped = host.stop();
		decision.resolve({ response: 1 });
		await rejected;
		await vi.waitFor(() => expect(pty.writes).toHaveBeenCalledWith("\u001b[200~/exit\u001b[201~\r"));
		expect(pty.keys).toHaveBeenCalledWith("down enter");
		expect(pty.writes.mock.calls.some(call => String(call[0]).includes("Must remain unsent"))).toBe(false);
		await exit(0); await stopped;
	});

	it("rejects concurrently queued input once stop begins, while retaining intentional terminal bytes", async () => {
		const pending = host.submit("Must remain unsent");
		const rejected = expect(pending).rejects.toThrow("closing this chat");
		const stopped = host.stop();
		await rejected;
		await expect(host.submit("Later message")).rejects.toThrow("closing this chat");
		await expect(host.paste("/tmp/image.png")).rejects.toThrow("closing this chat");
		await expect(host.keys("enter")).rejects.toThrow("closing this chat");
		host.write("terminal-only");
		expect(pty.writes).toHaveBeenCalledWith("terminal-only");
		await vi.waitFor(() => expect(pty.writes).toHaveBeenCalledWith("\u001b[200~/exit\u001b[201~\r"));
		expect(pty.writes.mock.calls.some(call => String(call[0]).includes("Must remain unsent"))).toBe(false);
		await exit(0); await stopped;
	});

	it("holds image-only Enter for a native question and never sends an empty paste", async () => {
		await host.paste("/tmp/image.png");
		pty.writes.mockClear();
		pty.screen = startupQuestion;
		const decision = Promise.withResolvers<{ response: number }>();
		pty.confirm.mockImplementationOnce(() => decision.promise);
		pty.keys.mockImplementationOnce(async () => { pty.screen = []; });
		const pending = host.submit("");
		await vi.waitFor(() => expect(pty.confirm).toHaveBeenCalledOnce());
		expect(pty.writes).not.toHaveBeenCalled();
		decision.resolve({ response: 0 });
		await pending;
		expect(pty.keys).toHaveBeenCalledWith("down enter");
		expect(pty.writes).toHaveBeenCalledExactlyOnceWith("\r");
	});
});

describe("bounded explicit shutdown escape", () => {
	it("offers an explicit escape for an unacknowledged exit even while collab remains connected", async () => {
		await connect();
		vi.useFakeTimers();
		const decision = Promise.withResolvers<{ response: number }>();
		pty.confirm.mockImplementationOnce(() => decision.promise);
		pty.kill.mockImplementationOnce(() => { pty.exit?.({ exitCode: 1 }); });
		const stopped = host.stop();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(3999);
		expect(pty.confirm).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(101);
		expect(pty.confirm).toHaveBeenCalledOnce();
		expect(pty.kill).not.toHaveBeenCalled();
		decision.resolve({ response: 1 });
		await vi.advanceTimersByTimeAsync(100);
		await stopped;
		expect(pty.kill).toHaveBeenCalledOnce();
	});

	it("does not auto-kill cleanup after acknowledgement, teardown and room closure", async () => {
		await connect();
		vi.useFakeTimers();
		const decision = Promise.withResolvers<{ response: number }>();
		pty.confirm.mockImplementationOnce(() => decision.promise);
		const stopped = host.stop();
		await vi.advanceTimersByTimeAsync(0);
		pty.data?.("Closing session…\r\n");
		await vi.advanceTimersByTimeAsync(100);
		pty.shutdown = "teardown";
		await vi.advanceTimersByTimeAsync(100);
		pty.events.onHostClose?.("room");
		pty.data?.("\u001b]7501;state=clear\u0007");
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(14_000);
		expect(pty.confirm).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1500);
		expect(pty.confirm).toHaveBeenCalledOnce();
		expect(pty.confirm.mock.calls[0]?.[0]?.detail).toContain("may be removing a worktree");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(pty.kill).not.toHaveBeenCalled();
		pty.exit?.({ exitCode: 0 });
		await vi.advanceTimersByTimeAsync(100);
		await stopped;
		expect(pty.kill).not.toHaveBeenCalled();
	});

	it("does not turn time spent answering a worktree question into a kill deadline", async () => {
		vi.useFakeTimers();
		pty.screen = startupQuestion;
		const decision = Promise.withResolvers<{ response: number }>();
		pty.confirm.mockImplementationOnce(() => decision.promise);
		pty.keys.mockImplementationOnce(async () => { pty.screen = []; });
		const stopped = host.stop();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(pty.confirm).toHaveBeenCalledOnce();
		expect(pty.writes).not.toHaveBeenCalled();
		expect(pty.kill).not.toHaveBeenCalled();
		decision.resolve({ response: 0 });
		await vi.advanceTimersByTimeAsync(100);
		expect(pty.writes).toHaveBeenCalledWith("\u001b[200~/exit\u001b[201~\r");
		pty.exit?.({ exitCode: 0 });
		await vi.advanceTimersByTimeAsync(100);
		await stopped;
	});

	it("bounds an explicit force-stop whose exit cannot be confirmed", async () => {
		vi.useFakeTimers();
		pty.confirm.mockResolvedValueOnce({ response: 1 });
		const stopped = host.stop();
		const rejected = expect(stopped).rejects.toThrow("remains tracked");
		await vi.advanceTimersByTimeAsync(8200);
		await rejected;
		expect(pty.kill).toHaveBeenCalledOnce();
		expect(host.state.phase).not.toBe("exited");
	});
});

function recapDatabase(file: string, text: string): DatabaseSync {
	const db = new DatabaseSync(file);
	db.exec("CREATE TABLE session_recaps(id INTEGER PRIMARY KEY, session_id TEXT, recap TEXT, created_at INTEGER)");
	db.prepare("INSERT INTO session_recaps VALUES(?,?,?,?)").run(1, "old", text, 20);
	return db;
}

describe("owning-process recap paths", () => {
	it.each([
		["default", ".omp/agent/history.db"],
		["explicit agent override", "explicit/history.db"],
		["named profile", ".omp/profiles/work/agent/history.db"],
		["XDG data root", "xdg/omp/history.db"],
	])("reads the owner's resolved %s path instead of guessing from the app environment", async (label, relative) => {
		const file = join(pty.root, relative);
		await mkdir(join(file, ".."), { recursive: true });
		recapDatabase(file, `Recap from ${label}`).close();
		pty.historyDbPath = file;
		pty.location = { cwd: "/tmp", sessionId: "old", sessionFile: null };
		await vi.waitFor(() => expect(host.state.notices?.some(notice => notice.text === `Recap from ${label}`)).toBe(true));
	});

	it("retains the last journal while SQLite is exclusively locked", async () => {
		await exit(0);
		vi.useFakeTimers();
		host = new SessionHost({ cwd: "/tmp" });
		await host.start();
		const file = join(pty.root, "locked.db");
		const db = recapDatabase(file, "Keep this recap visible.");
		pty.historyDbPath = file;
		pty.location = { cwd: "/tmp", sessionId: "old", sessionFile: null };
		try {
			await vi.advanceTimersByTimeAsync(500);
			expect(host.state.notices?.[0]?.text).toBe("Keep this recap visible.");
			db.exec("BEGIN EXCLUSIVE");
			await vi.advanceTimersByTimeAsync(500);
			expect(host.state.notices?.[0]?.text).toBe("Keep this recap visible.");
			db.exec("ROLLBACK");
		} finally { db.close(); }
	});
});

it("cancels a pending native text-dialog paste when shutdown starts", async () => {
	const pending = host.paste("Native dialog answer\nwith a second line");
	const rejected = expect(pending).rejects.toThrow("closing this chat");
	const stopped = host.stop();
	await rejected;
	await vi.waitFor(() => expect(pty.writes).toHaveBeenCalledWith("\u001b[200~/exit\u001b[201~\r"));
	expect(pty.writes.mock.calls.some(call => String(call[0]).includes("Native dialog answer"))).toBe(false);
	await exit(0);
	await stopped;
});

it("holds one input transaction across editor keys and the following exact transfer", async () => {
	const transfer = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const pending = host.withEditorInput(async input => {
		await input.keys("tab");
		entered.resolve();
		await transfer.promise;
		input.assertOpen();
		return "accepted prediction";
	});
	await entered.promise;
	const after = host.paste("next application input");
	expect(pty.keys).toHaveBeenCalledWith("tab");
	expect(pty.writes).not.toHaveBeenCalled();
	transfer.resolve();
	await expect(pending).resolves.toBe("accepted prediction");
	await after;
	expect(pty.writes).toHaveBeenCalledExactlyOnceWith("\u001b[200~next application input\u001b[201~");
});

it("blocks composed input after an uncertain editor transfer without blocking recovery keys or Stop", async () => {
	host.setEditorTransferBlocked("The editor transfer requires recovery.");
	await expect(host.submit("Keep this unsent")).rejects.toThrow("requires recovery");
	await expect(host.paste("Keep this unsent")).rejects.toThrow("requires recovery");
	await host.keys("escape");
	await expect(host.withEditorInput(async input => { input.assertOpen(); return "recovery available"; })).resolves.toBe("recovery available");
	expect(pty.writes).not.toHaveBeenCalled();
	const stopped = host.stop();
	await vi.waitFor(() => expect(pty.writes).toHaveBeenCalledWith("\u001b[200~/exit\u001b[201~\r"));
	await exit(0); await stopped;
});

it("offers a bounded explicit stop while an editor transaction is unresponsive", async () => {
	vi.useFakeTimers();
	const transfer = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const pending = host.withEditorInput(async input => {
		entered.resolve();
		await transfer.promise;
		input.assertOpen();
		return "must not be accepted after closing";
	});
	const rejected = expect(pending).rejects.toThrow("closing this chat");
	await entered.promise;
	pty.confirm.mockResolvedValueOnce({ response: 1 });
	pty.kill.mockImplementationOnce(() => { pty.exit?.({ exitCode: 1 }); });
	const stopped = host.stop();
	await vi.advanceTimersByTimeAsync(4200);
	await stopped;
	expect(pty.confirm).toHaveBeenCalledOnce();
	expect(pty.kill).toHaveBeenCalledOnce();
	transfer.resolve();
	await rejected;
});

it("reads fresh focus without treating the periodic projection as current", async () => {
	expect(host.state.tui).toBeNull();
	pty.focus = { focused: "HookSelector", overlays: 1, overlayKinds: ["HookSelector"], altScreen: false };
	await expect(host.tuiFocus()).resolves.toMatchObject({ overlays: 1, focused: "HookSelector" });
	expect(host.state.tui).toBeNull();
});

it("rejects editor transaction methods after their input lock has been released", async () => {
	let released: EditorInputTransaction | undefined;
	await host.withEditorInput(async input => { released = input; });
	expect(() => released!.assertOpen()).toThrow("already finished");
	await expect(released!.keys("tab")).rejects.toThrow("already finished");
	expect(pty.keys).not.toHaveBeenCalled();
});

async function launchTsp(platform: NodeJS.Platform = "darwin", fakeClock = false): Promise<void> {
	if (host.state.phase !== "exited") await exit(0);
	if (fakeClock) vi.useFakeTimers();
	vi.stubEnv("VOMP_TSP", "1");
	// The spawn and debug bridge are mocked; only launch-policy selection needs the platform.
	vi.stubGlobal("process", new Proxy(process, { get: (target, key) => key === "platform" ? platform : Reflect.get(target, key) }));
	host = new SessionHost({ cwd: tmpdir() });
	await host.start();
}

function tspMessage(verb: string, body: unknown): void {
	pty.data?.(Buffer.from(`\x1b_tsp;${verb};${JSON.stringify(body)}\x1b\\`));
}

function tspComposer(surface = "s:1", editor = "editor", sendable = true): void {
	tspMessage("o", { id: surface, mode: "inline", role: "omp.session" });
	tspMessage("f", { sf: surface, s: 1, ops: [
		["add", "dock", surface, null, { id: "dock", k: "col", p: { role: "omp.editor" }, c: [{ id: editor, k: "editor", p: { sendable, text: "" } }] }],
		["focus", editor],
	] });
}

describe("opt-in semantic transport", () => {
	it("leaves classic launch, raw output and snapshots unchanged by default", () => {
		expect(pty.spawnOptions?.env).toMatchObject({ PI_TUI_NATIVE: "0" });
		expect(pty.spawnOptions?.env).not.toHaveProperty("TERM_PROGRAM");
		expect(pty.spawnOptions).not.toHaveProperty("encoding");
		expect(host.state.transport).toBeUndefined();
		expect(host.tspSnapshot()).toBeNull();
	});

	it("launches a raw-byte Tern client only when explicitly enabled", async () => {
		await launchTsp();
		expect(pty.spawnOptions?.env).toMatchObject({ TERM_PROGRAM: "tern" });
		expect(pty.spawnOptions?.env).not.toHaveProperty("PI_TUI_NATIVE");
		expect(pty.spawnOptions?.encoding).toBeNull();
		expect(host.state.transport).toBe("tsp");
		tspMessage("q", { q: "hello", v: [1], features: ["send"] });
		tspMessage("o", { id: "s:1", mode: "inline" });
		tspMessage("f", { sf: "s:1", s: 1, ops: [["add", "dock", "s:1", null, { id: "dock", k: "col", c: [{ id: "editor", k: "editor", p: { sendable: true, text: "" } }] }]] });
		await connect();
		const snapshot = host.tspSnapshot();
		expect(snapshot).toMatchObject({ hostId: host.id, generation: 1, negotiated: true });
		expect(snapshot?.surfaces[0]?.sequence).toBe(1);
		expect(broadcast).toHaveBeenCalledWith("host:tsp-update", expect.objectContaining({ generation: 1 }));
		await host.tspEvent(1, { ev: "send", sf: "s:1", id: "editor", text: "/btw" });
		expect(pty.writes).toHaveBeenCalledWith(expect.stringContaining('"text":"/btw"'));
		await expect(host.tspEvent(0, { ev: "send", sf: "s:1", id: "editor", text: "/btw" })).rejects.toThrow("session changed");
		await expect(host.tspEvent(1, { ev: "ack", sf: "s:1", s: 99 })).rejects.toThrow("main-owned");
	});

	it("ignores the opt-in flag on Windows and logs a single explanation", async () => {
		const log = vi.spyOn(console, "info").mockImplementation(() => {});
		try {
			await launchTsp("win32");
			expect(host.state.transport).toBeUndefined();
			expect(host.tspSnapshot()).toBeNull();
			expect(pty.spawnOptions?.env).toMatchObject({ PI_TUI_NATIVE: "0" });
			expect(pty.spawnOptions?.env).not.toHaveProperty("TERM_PROGRAM");
			expect(pty.spawnOptions).not.toHaveProperty("encoding");
			expect(pty.spawnOptions).not.toHaveProperty("useConptyDll");
			expect(log).toHaveBeenCalledExactlyOnceWith("[visual-omp] TSP is not supported on Windows yet; using classic transport.");
		} finally { log.mockRestore(); }
	});

	it("keeps OSC status and startup diagnostics on the non-TSP byte path", async () => {
		await launchTsp();
		tspMessage("q", { q: "hello", v: [1] });
		tspMessage("o", { id: "s:1", mode: "inline" });
		tspMessage("f", { sf: "s:1", s: 1, ops: [["add", "main", "s:1", null, { id: "main", k: "text", p: { text: "Error: semantic text is not a startup diagnostic" } }]] });
		pty.data?.(Buffer.from("Error: raw startup café\r\n\x1b]7501;state=working:app=omp\x07"));
		await vi.waitFor(() => expect(host.state.programStatus).toMatchObject({ state: "working" }));
		expect(broadcast).not.toHaveBeenCalledWith("host:data", expect.objectContaining({ data: expect.stringContaining("semantic text") }));
		await exit(1);
		expect(host.state.exitReason).toBe("Error: raw startup café");
	});

	it("returns protocol credits while unsupported painted input is refused without host error", async () => {
		await launchTsp();
		tspMessage("q", { q: "hello", v: [1] });
		tspMessage("o", { id: "s:1", mode: "inline" });
		await connect();
		await expect(host.withEditorInput(async () => {})).rejects.toThrow("not available");
		tspMessage("f", { sf: "s:1", s: 1, ops: [] });
		await vi.waitFor(() => expect(pty.writes).toHaveBeenCalledWith(expect.stringContaining('"ev":"ack"')));
		expect(host.state.error).toBeNull();
	});

	it("rechecks generations for semantic input waiting on the application queue", async () => {
		await launchTsp();
		tspMessage("q", { q: "hello", v: [1], features: ["send"] });
		tspComposer();
		await connect();
		const queued = host.tspEvent(1, { ev: "send", sf: "s:1", id: "editor", text: "/btw" });
		const rejected = expect(queued).rejects.toThrow("session changed");
		pty.events.onHostClose?.("room");
		await rejected;
	});

	it("submits plain text using semantic readiness and keeps painted adapters unavailable", async () => {
		await launchTsp();
		tspMessage("q", { q: "hello", v: [1], features: ["send", "edit"] });
		tspComposer("s:1", "editor", false);
		await connect();
		await expect(host.submit("hello")).rejects.toThrow("not ready");
		tspMessage("f", { sf: "s:1", s: 2, ops: [["set", "editor", { sendable: true }]] });
		await host.submit("/btw", "steer");
		expect(pty.writes).toHaveBeenCalledWith(expect.stringContaining('"ev":"send","sf":"s:1","id":"editor","text":"/btw"'));
		for (const action of [
			() => host.submit("hello", "followUp"),
			() => host.submit("!pwd"),
			() => host.submit(""),
			() => host.paste("image.png"),
			() => host.screenLines(),
			() => host.screenPaint(),
			() => host.debugValues(),
			() => host.tuiFocus(),
		]) await expect(action()).rejects.toThrow("not available in the TSP preview");
		expect(() => host.serializedScreen()).toThrow("not available");
		expect(host.state.error).toBeNull();
		await host.keys("escape", host.state.generation, host.tspSnapshot()!.epoch);
		expect(pty.writes).toHaveBeenCalledWith("\x1b");
	});

	it("gates semantic submits and edits while exact-transfer recovery blocks input", async () => {
		await launchTsp();
		tspMessage("q", { q: "hello", v: [1], features: ["send", "edit"] });
		tspComposer();
		await connect();
		host.setEditorTransferBlocked("Recover the displaced draft first.");
		await expect(host.submit("hello")).rejects.toThrow("Recover");
		await expect(host.tspEvent(1, { ev: "edit", sf: "s:1", id: "editor", from: 0, to: 0, text: "hello", cursor: 5, len: 0 })).rejects.toThrow("Recover");
		expect(host.state.error).toBeNull();
	});

	it("keeps old surface generations stale across room changes and submits only to a fresh surface", async () => {
		await launchTsp();
		tspMessage("q", { q: "hello", v: [1], features: ["send"] });
		tspComposer("s:old", "old-editor");
		await connect();
		expect(host.tspSnapshot()).toMatchObject({ lifecycle: "live", documentGeneration: 1 });
		pty.events.onHostClose?.("room");
		expect(host.tspSnapshot()).toMatchObject({ lifecycle: "transitioning", documentGeneration: null });
		await connect("room2", "new");
		expect(host.tspSnapshot()).toMatchObject({ generation: 2, lifecycle: "transitioning" });
		await expect(host.submit("hello")).rejects.toThrow("semantic UI is not ready");
		tspComposer("s:new", "new-editor");
		expect(host.tspSnapshot()).toMatchObject({ lifecycle: "live", generation: 2 });
		expect(host.tspSnapshot()?.surfaces.map(surface => [surface.open.id, surface.documentGeneration])).toEqual([["s:old", null], ["s:new", 2]]);
		await host.submit("/btw");
		expect(pty.writes).toHaveBeenCalledWith(expect.stringContaining('"sf":"s:new","id":"new-editor","text":"/btw"'));
		expect(pty.writes).not.toHaveBeenCalledWith(expect.stringContaining('"ev":"send","sf":"s:old"'));
		await expect(host.tspEvent(2, { ev: "visible", sf: "s:old", visible: true })).rejects.toThrow("earlier session");
	});

	it("marks documents unavailable on exit without a close and never copies them into a replacement host", async () => {
		await launchTsp();
		tspMessage("q", { q: "hello", v: [1], features: ["send"] });
		tspComposer();
		await connect();
		const previous = host;
		await exit(1);
		expect(previous.tspSnapshot()).toMatchObject({ lifecycle: "exited", documentGeneration: null });
		expect(previous.tspSnapshot()?.surfaces[0]?.documentGeneration).toBeNull();
		await launchTsp();
		expect(host.tspSnapshot()?.surfaces).toEqual([]);
		expect(host.tspSnapshot()?.hostId).not.toBe(previous.id);
	});

	it.each([null, [2]])("shows bounded negotiation failure for absent or incompatible hello %j", async versions => {
		await launchTsp("darwin", true);
		pty.data?.(Buffer.from("classic output"));
		if (versions) tspMessage("q", { q: "hello", v: versions });
		await vi.advanceTimersByTimeAsync(10_001);
		expect(host.tspSnapshot()).toMatchObject({ lifecycle: "failed", negotiated: false, failure: "omp did not start its semantic screen" });
		expect(host.state.tspFailed).toBe(true);
		expect(host.state.error).toBeNull();
	});

	it("cancels failed-negotiation reporting after a supported hello or process exit", async () => {
		await launchTsp("darwin", true);
		tspMessage("q", { q: "hello", v: [1] });
		tspMessage("o", { id: "s:1", mode: "inline" });
		await vi.advanceTimersByTimeAsync(10_001);
		expect(host.tspSnapshot()?.failure).toBeNull();
		pty.exit?.({ exitCode: 0 });
		await vi.advanceTimersByTimeAsync(100);
		expect(host.tspSnapshot()?.lifecycle).toBe("exited");
		expect(host.tspSnapshot()?.failure).toBeNull();
	});

	it("fails a negotiated hello that never opens a surface after five seconds", async () => {
		await launchTsp("darwin", true);
		tspMessage("q", { q: "hello", v: [1] });
		await vi.advanceTimersByTimeAsync(4999);
		expect(host.state.tspFailed).toBe(false);
		await vi.advanceTimersByTimeAsync(2);
		expect(host.state.tspFailed).toBe(true);
		expect(host.tspSnapshot()?.failure).toBe("omp did not start its semantic screen");
	});

	it("does not diagnose a silent process as a failed handshake until output arrives", async () => {
		await launchTsp("darwin", true);
		await vi.advanceTimersByTimeAsync(10_001);
		expect(host.tspSnapshot()?.failure).toBeNull();
		pty.data?.(Buffer.from("late classic output"));
		await vi.advanceTimersByTimeAsync(1);
		expect(host.state.tspFailed).toBe(true);
	});

	it("blocks submission for nonmodal overlays and screen surfaces and exposes the reason", async () => {
		await launchTsp();
		tspMessage("q", { q: "hello", v: [1], features: ["send"] });
		tspComposer(); await connect();
		expect(host.state.tspAvailability?.available).toBe(true);
		tspMessage("f", { sf: "s:1", s: 2, ops: [["add", "layer", "s:1", null, { id: "layer", k: "col", c: [{ id: "overlay", k: "overlay", p: { modal: false } }] }]] });
		expect(host.state.tspAvailability).toMatchObject({ available: false, reason: expect.stringContaining("menu") });
		await expect(host.submit("hello")).rejects.toThrow("menu");
		tspMessage("f", { sf: "s:1", s: 3, ops: [["del", "overlay"]] });
		tspMessage("o", { id: "settings", mode: "screen" });
		await expect(host.submit("hello")).rejects.toThrow("Close the omp screen");
		tspMessage("x", { id: "settings", keep: false });
		expect(host.state.tspAvailability?.available).toBe(true);
	});

	it("resets documents and rejects a previous epoch when a second hello reuses the PTY", async () => {
		await launchTsp();
		tspMessage("q", { q: "hello", v: [1], features: ["send"] });
		tspComposer(); await connect();
		const epoch = host.tspSnapshot()!.epoch!;
		tspMessage("q", { q: "hello", v: [1], features: ["send"] });
		expect(host.tspSnapshot()?.surfaces).toEqual([]);
		expect(host.tspSnapshot()?.epoch).toBe(epoch + 1);
		tspComposer();
		await expect(host.tspEvent(1, { ev: "visible", sf: "s:1", visible: true }, epoch)).rejects.toThrow("restarted");
		await expect(host.keys("\x1b", 1, epoch)).rejects.toThrow("restarted");
		await expect(host.keys("tab")).rejects.toThrow("not available");
		await host.tspEvent(1, { ev: "visible", sf: "s:1", visible: true }, epoch + 1);
	});

	it.each(["none", "overlay", "screen"])("closes through TSP send from %s and refuses new input", async presentation => {
		await launchTsp();
		tspMessage("q", { q: "hello", v: [1], features: ["send"] });
		tspComposer(); await connect();
		if (presentation === "overlay") tspMessage("f", { sf: "s:1", s: 2, ops: [["add", "layer", "s:1", null, { id: "layer", k: "col", c: [{ id: "overlay", k: "overlay" }] }]] });
		if (presentation === "screen") tspMessage("o", { id: "settings", mode: "screen" });
		const stopping = host.stop();
		await expect(host.submit("late")).rejects.toThrow("closing");
		await expect(host.keys("escape")).rejects.toThrow("closing");
		if (presentation !== "none") {
			await vi.waitFor(() => expect(pty.writes).toHaveBeenCalledWith("\x1b"));
			expect(pty.writes).not.toHaveBeenCalledWith(expect.stringContaining('"text":"/exit"'));
			if (presentation === "screen") tspMessage("x", { id: "settings", keep: false });
			else tspMessage("f", { sf: "s:1", s: 3, ops: [["del", "overlay"]] });
		}
		await vi.waitFor(() => expect(pty.writes).toHaveBeenCalledWith(expect.stringContaining('"text":"/exit"')));
		expect(pty.writes).not.toHaveBeenCalledWith("\x1b[200~/exit\x1b[201~\r");
		tspMessage("f", { sf: "s:1", s: 4, ops: [["add", "closing", "s:1", null, { id: "closing", k: "toast", p: { role: "omp.toast.status", text: "Closing session…" } }]] });
		await exit(0); await stopping;
		expect(pty.kill).not.toHaveBeenCalled();
	});

	it.each(["toast", "surface"])("acknowledges shutdown from a semantic %s before the short grace expires", async acknowledgement => {
		await launchTsp("darwin", true);
		tspMessage("q", { q: "hello", v: [1], features: ["send"] });
		tspComposer(); await connect();
		const stopping = host.stop();
		await vi.waitFor(() => expect(pty.writes).toHaveBeenCalledWith(expect.stringContaining('"text":"/exit"')));
		if (acknowledgement === "surface") tspMessage("x", { id: "s:1", keep: true });
		else tspMessage("f", { sf: "s:1", s: 2, ops: [["add", "closing", "s:1", null, { id: "closing", k: "toast", p: { role: "omp.toast.status", text: "Closing session…" } }]] });
		await vi.advanceTimersByTimeAsync(5000);
		expect(pty.confirm).not.toHaveBeenCalled();
		pty.exit?.({ exitCode: 0 });
		await vi.advanceTimersByTimeAsync(100);
		await stopping;
		expect(pty.kill).not.toHaveBeenCalled();
	});

	it("blocks hook answers from sibling raw-key fallbacks and queued semantic events, while allowing Escape", async () => {
		await launchTsp();
		tspMessage("q", { q: "hello", v: [1], features: ["send", "edit"] });
		tspComposer(); await connect();
		const epoch = host.tspSnapshot()!.epoch;
		const queued = host.tspEvent(1, { ev: "action", sf: "s:1", id: "editor", act: "submit" }, epoch);
		const refused = expect(queued).rejects.toThrow("read-only");
		tspMessage("f", { sf: "s:1", s: 2, ops: [["add", "layer", "s:1", null, { id: "layer", k: "col", c: [
			{ id: "hook", k: "overlay", p: { role: "omp.overlay.hook-input" }, c: [{ id: "field", k: "input", p: { text: "", sendable: true } }] },
			{ id: "fallback", k: "rows", p: { lines: ["Extension fallback"] } },
		] }]] });
		await refused;
		for (const keys of ["\r", "\x1b[200~answer\x1b[201~\r", "yes"]) await expect(host.keys(keys, 1, epoch)).rejects.toThrow("read-only");
		for (const event of [
			{ ev: "send", sf: "s:1", id: "field", text: "answer" },
			{ ev: "action", sf: "s:1", id: "fallback", act: "submit" },
			{ ev: "edit", sf: "s:1", id: "field", from: 0, to: 0, len: 0, cursor: 1, text: "x" },
		]) await expect(host.tspEvent(1, event, epoch)).rejects.toThrow("read-only");
		await host.keys("escape", 1, epoch);
		expect(pty.writes).toHaveBeenCalledWith("\x1b");
		expect(pty.writes).not.toHaveBeenCalledWith(expect.stringContaining('"act":"submit"'));
		expect(pty.writes).not.toHaveBeenCalledWith(expect.stringContaining('"text":"answer"'));
	});

	it.each(["overlay", "epoch"])("continues shutdown stages when a queued exit is invalidated by %s", async transition => {
		await launchTsp();
		tspMessage("q", { q: "hello", v: [1], features: ["send"] });
		tspComposer(); await connect();
		const original = TspSession.prototype.submit;
		const submit = vi.spyOn(TspSession.prototype, "submit").mockImplementationOnce(function (this: TspSession, ...args) {
			const pending = original.apply(this, args);
			if (transition === "overlay") tspMessage("f", { sf: "s:1", s: 2, ops: [["add", "layer", "s:1", null, { id: "layer", k: "col", c: [{ id: "menu", k: "overlay" }] }]] });
			else tspMessage("q", { q: "hello", v: [1], features: ["send"] });
			return pending;
		});
		try {
			const stopping = host.stop();
			await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
			if (transition === "overlay") {
				await vi.waitFor(() => expect(pty.writes).toHaveBeenCalledWith("\x1b"));
				tspMessage("f", { sf: "s:1", s: 3, ops: [["del", "menu"]] });
			} else tspComposer();
			await vi.waitFor(() => expect(pty.writes).toHaveBeenCalledWith(expect.stringContaining('"text":"/exit"')));
			expect(submit).toHaveBeenCalledTimes(2);
			await exit(0); await stopping;
			expect(pty.kill).not.toHaveBeenCalled();
		} finally { submit.mockRestore(); }
	});

	it("propagates unrelated semantic writer failures during shutdown", async () => {
		await launchTsp();
		tspMessage("q", { q: "hello", v: [1], features: ["send"] });
		tspComposer(); await connect();
		const submit = vi.spyOn(TspSession.prototype, "submit").mockRejectedValueOnce(new Error("writer failed"));
		try { await expect(host.stop()).rejects.toThrow("writer failed"); }
		finally { submit.mockRestore(); }
	});

	it("contains malformed protocol operations while preserving subsequent ordinary output", async () => {
		await launchTsp();
		tspMessage("q", { q: "hello", v: [1] });
		tspMessage("o", { id: "s:1", mode: "inline" });
		expect(() => pty.data?.(Buffer.from('\x1b_tsp;f;{"sf":"s:1","s":1,"ops":[["add"]]}\x1b\\Error: raw startup failure\r\n'))).not.toThrow();
		expect(host.tspSnapshot()).toMatchObject({ lifecycle: "failed", failure: expect.stringContaining("Invalid TSP frame") });
		expect(host.state.error).toBeNull();
		await exit(1);
		expect(host.state.exitReason).toBe("Error: raw startup failure");
	});
});
