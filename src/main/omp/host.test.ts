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
import type { TspRendererEvent } from "@shared/tsp-host";
import { hookQuestions } from "@shared/tsp/question-match";

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

	it("keeps matched collab questions read-only through both event and answer routes", async () => {
		await launchTsp();
		tspMessage("q", { q: "hello", v: [1], features: ["send", "edit"] });
		tspComposer();
		await connect();
		const epoch = host.tspSnapshot()!.epoch;
		tspMessage("f", { sf: "s:1", s: 2, ops: [["add", "layer", "s:1", null, { id: "layer", k: "col", c: [{ id: "hook", k: "overlay", p: { role: "omp.overlay.hook-select", head: "Choose" }, c: [{ id: "pick", k: "picker", p: { items: [{ id: "yes", label: "Yes" }] } }] }] }]] });
		const state = { hostId: host.id, generation: 1, epoch, connection: 1, revision: 1, connected: true, requests: [{ reqId: 4, kind: "select", title: "Choose", options: ["Yes"] }] };
		await vi.waitFor(() => expect(pty.writes).toHaveBeenCalledWith(expect.stringContaining('"s":2')));
		const writesBeforeMirror = pty.writes.mock.calls.length;
		host.tspQuestions(state);
		expect(host.tspSnapshot()?.questionMatches).toMatchObject([{ status: "matched", reqId: 4 }]);
		await expect(host.tspEvent(1, { ev: "activate", sf: "s:1", id: "pick", item: "yes" }, epoch)).rejects.toThrow("guarded question");
		await expect(host.tspAnswer(1, { kind: "choose", sf: "s:1", id: "hook", target: "pick", item: "yes" }, epoch)).rejects.toThrow("matched");
		host.tspQuestions({ ...state, epoch: epoch - 1, revision: 2, requests: [] });
		expect(host.tspSnapshot()?.questionMatches?.[0]?.status).toBe("matched");
		host.tspQuestions({ ...state, revision: 2, requests: [] });
		expect(host.tspSnapshot()?.questionMatches?.[0]?.status).toBe("settling");
		expect(pty.writes).toHaveBeenCalledTimes(writesBeforeMirror);
		tspMessage("f", { sf: "s:1", s: 3, ops: [["del", "hook"]] });
		expect(host.tspSnapshot()?.questionMatches).toEqual([]);
		expect(pty.writes.mock.calls.some(([bytes]) => String(bytes).includes('"ev":"activate"'))).toBe(false);
	});

	it("rejects malformed question mirrors and never writes payload answer fields to the PTY", async () => {
		await launchTsp();
		tspMessage("q", { q: "hello", v: [1], features: ["send"] });
		tspComposer(); await connect();
		await vi.waitFor(() => expect(pty.writes).toHaveBeenCalledWith(expect.stringContaining('"ev":"ack"')));
		const writesBeforeMirror = pty.writes.mock.calls.length;
		const initial = host.tspSnapshot()!;
		const state = { hostId: host.id, generation: 1, epoch: initial.epoch, connection: 1, revision: 1, connected: true, requests: [] };
		for (const input of [undefined, null, [], { ...state, generation: "1" }, { ...state, revision: -1 }, { ...state, requests: [{ reqId: "4", kind: "editor", title: "Bad" }] }, { ...state, requests: [{ reqId: 4, kind: "select", title: "Bad", options: [3] }] }, { ...state, answer: "yes", ev: "activate" }]) {
			host.tspQuestions(input);
			expect(host.tspSnapshot()?.revision).toBe(initial.revision);
			expect(pty.writes).toHaveBeenCalledTimes(writesBeforeMirror);
		}
		host.tspQuestions({ ...state, requests: [{ reqId: 4, kind: "editor", title: "Question", prefill: "", answer: "yes", value: "yes", ev: "send", sf: "s:1", id: "editor" }] });
		expect(host.tspSnapshot()?.revision).toBe(initial.revision + 1);
		expect(pty.writes).toHaveBeenCalledTimes(writesBeforeMirror);
	});
	it.each(["select", "confirm", "input", "editor"] as const)("answers an unmatched %s through the application writer and waits for node departure", async kind => {
		await launchTsp(); tspMessage("q", { q: "hello", v: [1], features: ["send", "edit"] }); tspComposer(); await connect();
		const epoch = host.tspSnapshot()!.epoch;
		const text = kind === "input" || kind === "editor";
		const node = { id: "hook", k: "overlay", p: { role: `omp.overlay.hook-${kind}`, head: "Local question" }, c: text
			? [{ id: "field", k: kind, p: { text: "seed" } }, { id: "submit", k: "text", p: { text: "Submit", actions: { click: "submit" } } }]
			: [{ id: "pick", k: "picker", p: { items: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] } }] };
		tspMessage("f", { sf: "s:1", s: 2, ops: [["add", "hook", "s:1", null, node]] });
		host.tspQuestions({ hostId: host.id, generation: 1, epoch, connection: 1, revision: 1, connected: true, requests: [] });
		const answer = text ? { kind: "text", sf: "s:1", id: "hook", target: "field", text: "Answer", len: 4 } : { kind: "choose", sf: "s:1", id: "hook", target: "pick", item: "yes" };
		await host.tspAnswer(1, answer, epoch);
		expect(host.tspSnapshot()?.questionMatches).toMatchObject([{ status: "answering" }]);
		await expect(host.tspAnswer(1, answer, epoch)).rejects.toThrow("answering");
		const output = pty.writes.mock.calls.map(([bytes]) => String(bytes)).join("");
		expect(output).toContain(text ? '"ev":"edit"' : '"ev":"activate"');
		if (text) expect(output).toContain('"id":"submit","act":"submit"');
		tspMessage("f", { sf: "s:1", s: 3, ops: [["del", "hook"]] });
		expect(host.tspSnapshot()?.questionMatches).toEqual([]);
	});

	it("refuses unavailable, ambiguous, stale and missing hook answers without answer bytes", async () => {
		await launchTsp(); tspMessage("q", { q: "hello", v: [1], features: ["send", "edit"] }); tspComposer(); await connect();
		const epoch = host.tspSnapshot()!.epoch;
		tspMessage("f", { sf: "s:1", s: 2, ops: [["add", "hook", "s:1", null, { id: "hook", k: "overlay", p: { role: "omp.overlay.hook-select", head: "Choose" }, c: [{ id: "pick", k: "picker", p: { items: [{ id: "yes", label: "Yes" }] } }] }]] });
		const answer = { kind: "choose", sf: "s:1", id: "hook", target: "pick", item: "yes" };
		await expect(host.tspAnswer(1, answer, epoch)).rejects.toThrow("unavailable");
		const state = { hostId: host.id, generation: 1, epoch, connection: 1, revision: 1, connected: true, requests: [{ reqId: 4, kind: "select", title: "Other", options: ["No"] }] };
		host.tspQuestions(state);
		await expect(host.tspAnswer(1, answer, epoch)).rejects.toThrow("ambiguous");
		host.tspQuestions({ ...state, revision: 2, requests: [] });
		await expect(host.tspAnswer(0, answer, epoch)).rejects.toThrow("session changed");
		await expect(host.tspAnswer(1, answer, epoch - 1)).rejects.toThrow("restarted");
		for (const key of ["enter", "\r", "x"]) await expect(host.keys(key, 1, epoch)).rejects.toThrow("Raw keys");
		tspMessage("f", { sf: "s:1", s: 3, ops: [["del", "hook"]] });
		await expect(host.tspAnswer(1, answer, epoch)).rejects.toThrow("node is no longer available");
		expect(pty.writes.mock.calls.some(([bytes]) => /"ev":"(?:activate|edit|action)"/.test(String(bytes)))).toBe(false);
	});
	it("rechecks a newly matched question after a local answer enters the application queue", async () => {
		await launchTsp(); tspMessage("q", { q: "hello", v: [1], features: ["send", "edit"] }); tspComposer(); await connect();
		const epoch = host.tspSnapshot()!.epoch;
		tspMessage("f", { sf: "s:1", s: 2, ops: [["add", "hook", "s:1", null, { id: "hook", k: "overlay", p: { role: "omp.overlay.hook-select", head: "Choose" }, c: [{ id: "pick", k: "picker", p: { items: [{ id: "yes", label: "Yes" }] } }] }]] });
		const state = { hostId: host.id, generation: 1, epoch, connection: 1, revision: 1, connected: true, requests: [] };
		host.tspQuestions(state);
		const queued = host.tspAnswer(1, { kind: "choose", sf: "s:1", id: "hook", target: "pick", item: "yes" }, epoch);
		const rejected = expect(queued).rejects.toThrow("matched");
		host.tspQuestions({ ...state, revision: 2, requests: [{ reqId: 4, kind: "select", title: "Choose", options: ["Yes"] }] });
		await rejected;
		await expect(host.keys("escape", 1, epoch)).rejects.toThrow("matched");
		expect(pty.writes.mock.calls.some(([bytes]) => /"ev":"(?:activate|edit|action)"/.test(String(bytes)))).toBe(false);
	});
	it("cancels an unmatched hook with its declared close action instead of raw Escape", async () => {
		await launchTsp(); tspMessage("q", { q: "hello", v: [1], features: ["send", "edit"] }); tspComposer(); await connect();
		const epoch = host.tspSnapshot()!.epoch;
		tspMessage("f", { sf: "s:1", s: 2, ops: [["add", "hook", "s:1", null, { id: "hook", k: "picker", p: { title: "Choose", noun: "options", layout: "rows", items: [{ id: "0", label: "Yes" }], actions: [{ id: "confirm", label: "Select" }, { id: "close", label: "Cancel" }] } }]] });
		host.tspQuestions({ hostId: host.id, generation: 1, epoch, connection: 1, revision: 1, connected: true, requests: [] });
		await host.keys("escape", 1, epoch);
		expect(pty.writes).toHaveBeenCalledWith(expect.stringContaining('"id":"hook","act":"close"'));
		expect(host.tspSnapshot()?.questionMatches).toMatchObject([{ status: "answering" }]);
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

	it("points to the question card only while the blocking hook has a unique collab match", async () => {
		await launchTsp();
		tspMessage("q", { q: "hello", v: [1], features: ["send"] });
		tspComposer(); await connect();
		const epoch = host.tspSnapshot()!.epoch;
		tspMessage("f", { sf: "s:1", s: 2, ops: [["add", "layer", "s:1", null, { id: "layer", k: "col", c: [
			{ id: "hook", k: "overlay", p: { role: "omp.overlay.hook-select", head: "Choose" }, c: [{ id: "pick", k: "picker", p: { items: [{ id: "yes", label: "Yes" }] } }] },
		] }]] });
		expect(host.state.tspAvailability?.reason).toContain("menu");
		host.tspQuestions({ hostId: host.id, generation: 1, epoch, connection: 1, revision: 1, connected: true, requests: [{ reqId: 4, kind: "select", title: "Choose", options: ["Yes"] }] });
		expect(host.state.tspAvailability).toEqual({ available: false, reason: "Answer the question card before sending a message.", reasonCode: "matched-question" });
		expect(host.tspSnapshot()?.availability).toEqual(host.state.tspAvailability);
		tspMessage("o", { id: "settings", mode: "screen" });
		expect(host.state.tspAvailability).toEqual({ available: false, reason: "Close the omp screen before sending a message." });
		tspMessage("x", { id: "settings", keep: false });
		host.tspQuestions({ hostId: host.id, generation: 1, epoch, connection: 1, revision: 2, connected: true, requests: [] });
		expect(host.state.tspAvailability?.reason).toContain("menu");
		expect(host.state.tspAvailability?.reasonCode).toBeUndefined();
		tspMessage("f", { sf: "s:1", s: 3, ops: [["del", "hook"], ["add", "menu", "layer", null, { id: "menu", k: "overlay", p: { head: "Other menu" } }]] });
		expect(host.state.tspAvailability?.reason).toBe("Close the open omp menu before sending a message.");
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
	it.each(["matched", "ambiguous", "unavailable", "answering"].flatMap(status => ["layer", "dock"].map(place => ({ status, place }))))("never writes shutdown Escape for a $status hook in $place", async ({ status, place }) => {
		await launchTsp("darwin", true);
		tspMessage("q", { q: "hello", v: [1], features: ["send", "edit"] }); tspComposer(); await connect();
		const epoch = host.tspSnapshot()!.epoch;
		const editor = place === "dock";
		const hook = editor
			? { id: "hook", k: "col", p: { role: "omp.overlay.hook-editor" }, c: [{ id: "title", k: "text", p: { role: "omp.hook-editor.title", spans: [{ t: "Choose" }] } }, { id: "field", k: "editor", p: { text: "seed" } }, { id: "submit", k: "text", p: { text: "Submit", actions: { click: "submit" } } }] }
			: { id: "hook", k: "overlay", p: { role: "omp.overlay.hook-select", head: "Choose" }, c: [{ id: "pick", k: "picker", p: { items: [{ id: "yes", label: "Yes" }] } }] };
		tspMessage("f", { sf: "s:1", s: 2, ops: place === "layer" ? [["add", "layer", "s:1", null, { id: "layer", k: "col", c: [hook] }]] : [["add", "hook", "dock", null, hook]] });
		const request = editor ? { reqId: 4, kind: "editor", title: "Choose", prefill: "seed" } : { reqId: 4, kind: "select", title: "Choose", options: ["Yes"] };
		if (status !== "unavailable") host.tspQuestions({ hostId: host.id, generation: 1, epoch, connection: 1, revision: 1, connected: true, requests: status === "answering" ? [] : [{ ...request, title: status === "ambiguous" ? "Other" : "Choose" }] });
		if (status === "answering") await host.tspAnswer(1, editor ? { kind: "text", sf: "s:1", id: "hook", target: "field", len: 4, text: "Answer" } : { kind: "choose", sf: "s:1", id: "hook", target: "pick", item: "yes" }, epoch);
		expect(host.tspSnapshot()?.questionMatches?.[0]?.status).toBe(status);
		await host.tspEvent(1, { ev: "visible", sf: "s:1", visible: true }, epoch); pty.writes.mockClear();
		const stopping = host.stop();
		expect(host.tspSnapshot()).toMatchObject({ closing: true, availability: { available: false, reason: "This chat is closing." } });
		await expect(host.tspAnswer(1, { kind: "cancel", sf: "s:1", id: "hook" }, epoch)).rejects.toThrow("closing");
		await vi.advanceTimersByTimeAsync(4200);
		expect(pty.writes).not.toHaveBeenCalledWith("\x1b");
		expect(pty.writes).not.toHaveBeenCalledWith(expect.stringContaining('"text":"/exit"'));
		expect(pty.confirm).toHaveBeenCalledOnce();
		expect(pty.kill).not.toHaveBeenCalled();
		pty.exit?.({ exitCode: 0 }); await vi.advanceTimersByTimeAsync(100); await stopping;
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

	it("blocks sibling raw keys and queued semantic events, and arbitrates Escape before cancellation", async () => {
		await launchTsp();
		tspMessage("q", { q: "hello", v: [1], features: ["send", "edit"] });
		tspComposer(); await connect();
		const epoch = host.tspSnapshot()!.epoch;
		const queued = host.tspEvent(1, { ev: "action", sf: "s:1", id: "editor", act: "submit" }, epoch);
		const refused = expect(queued).rejects.toThrow("guarded question");
		tspMessage("f", { sf: "s:1", s: 2, ops: [["add", "layer", "s:1", null, { id: "layer", k: "col", c: [
			{ id: "hook", k: "overlay", p: { role: "omp.overlay.hook-input" }, c: [{ id: "field", k: "input", p: { text: "", sendable: true } }] },
			{ id: "fallback", k: "rows", p: { lines: ["Extension fallback"] } },
		] }]] });
		await refused;
		for (const keys of ["\r", "\x1b[200~answer\x1b[201~\r", "yes"]) await expect(host.keys(keys, 1, epoch)).rejects.toThrow("Raw keys");
		for (const event of [
			{ ev: "send", sf: "s:1", id: "field", text: "answer" },
			{ ev: "action", sf: "s:1", id: "fallback", act: "submit" },
			{ ev: "edit", sf: "s:1", id: "field", from: 0, to: 0, len: 0, cursor: 1, text: "x" },
		]) await expect(host.tspEvent(1, event, epoch)).rejects.toThrow("guarded question");
		await expect(host.keys("escape", 1, epoch)).rejects.toThrow("unavailable");
		host.tspQuestions({ hostId: host.id, generation: 1, epoch, connection: 1, revision: 1, connected: true, requests: [] });
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

async function recording<T = unknown>(name: string, suffix: string): Promise<{ verb: string; body: T; keys?: string; afterMessage: number }[]> {
	return (await readFile(new URL(`./tsp/fixtures/18.14.0/${name}.${suffix}.jsonl`, import.meta.url), "utf8")).trim().split("\n").map(line => JSON.parse(line));
}
describe("recorded TSP lifecycle gate", () => {
	it("allows a recorded startup import picker before collab attaches, then adopts its replacement session", async () => {
		await launchTsp();
		const messages = await recording("import-claude", "messages");
		const events = await recording<TspRendererEvent>("import-claude", "events");
		const choices = events.filter(event => event.body?.ev === "select" || event.body?.ev === "activate");
		const boundary = choices[0]!.afterMessage;
		for (const message of messages.slice(0, boundary)) tspMessage(message.verb, message.body);
		expect(host.state).toMatchObject({ phase: "connecting", link: null, generation: 0 });
		expect(host.tspSnapshot()).toMatchObject({ negotiated: true, epoch: 1, lifecycle: "live", failure: null, surfaces: [{ documentGeneration: null }, { documentGeneration: 0 }] });
		const epoch = host.tspSnapshot()!.epoch;
		await host.keys("\x1b[B", 0, epoch);
		for (const choice of choices) await host.tspEvent(0, choice.body, epoch);
		for (const choice of choices) expect(pty.writes).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify(choice.body)));
		const exitBoundary = events.find(event => event.body?.ev === "send")!.afterMessage;
		for (const message of messages.slice(boundary, exitBoundary)) tspMessage(message.verb, message.body);
		expect(host.tspSnapshot()).toMatchObject({ epoch: 2, lifecycle: "live" });
		await expect(host.tspEvent(0, choices[0]!.body, epoch)).rejects.toThrow("restarted");
		await connect("imported", "imported-session");
		expect(host.tspSnapshot()).toMatchObject({ epoch: 2, generation: 1, lifecycle: "live", documentGeneration: 1 });
		await host.submit("Continue imported chat");
		expect(pty.writes).toHaveBeenCalledWith(expect.stringContaining('"text":"Continue imported chat"'));
	});
	it("keeps startup hooks mirror-gated while ordinary startup pickers accept input before the first room", async () => {
		await launchTsp();
		tspMessage("q", { q: "hello", v: [1], features: ["send"] });
		tspComposer();
		const hook = { id: "hook", k: "picker", p: { title: "Start in a worktree?", noun: "options", layout: "rows", items: [{ id: "0", label: "Yes" }, { id: "1", label: "No" }], actions: [{ id: "confirm", label: "Select" }, { id: "close", label: "Cancel" }] } };
		tspMessage("f", { sf: "s:1", s: 2, ops: [["add", "hook", "s:1", null, hook]] });
		const epoch = host.tspSnapshot()!.epoch;
		expect(host.tspSnapshot()?.questionMatches).toMatchObject([{ status: "unavailable" }]);
		await expect(host.tspAnswer(0, { kind: "choose", sf: "s:1", id: "hook", target: "hook", item: "1" }, epoch)).rejects.toThrow("unavailable");
		await expect(host.tspEvent(0, { ev: "activate", sf: "s:1", id: "hook", item: "1" }, epoch)).rejects.toThrow("guarded question");
		tspMessage("f", { sf: "s:1", s: 3, ops: [["del", "hook"], ["add", "import", "s:1", null, { id: "import", k: "picker", p: { title: "Import a session", noun: "sessions", layout: "cards", items: [{ id: "fixture", label: "Fixture session" }], actions: [{ id: "resume", label: "Import" }, { id: "close", label: "Cancel" }] } }]] });
		await host.tspEvent(0, { ev: "activate", sf: "s:1", id: "import", item: "fixture" }, epoch);
		expect(pty.writes).toHaveBeenCalledWith(expect.stringContaining('"ev":"activate","sf":"s:1","id":"import","item":"fixture"'));
		tspMessage("f", { sf: "s:1", s: 4, ops: [["del", "import"], ["add", "hook", "s:1", null, hook]] });
		await connect();
		expect(host.tspSnapshot()?.questionMatches).toMatchObject([{ status: "unavailable" }]);
		await expect(host.tspAnswer(1, { kind: "choose", sf: "s:1", id: "hook", target: "hook", item: "1" }, epoch)).rejects.toThrow("unavailable");
		host.tspQuestions({ hostId: host.id, generation: 1, epoch, connection: 1, revision: 1, connected: true, requests: [{ reqId: 9, kind: "select", title: "Start in a worktree?", options: ["Yes", "No"] }] });
		expect(host.tspSnapshot()?.questionMatches).toMatchObject([{ status: "matched", reqId: 9 }]);
		await expect(host.tspAnswer(1, { kind: "choose", sf: "s:1", id: "hook", target: "hook", item: "1" }, epoch)).rejects.toThrow("matched");
	});
	it("retains pre-room input across an epoch restart and permanently revokes it at the first room-open callback", async () => {
		await launchTsp();
		tspMessage("q", { q: "hello", v: [1], features: ["send"] }); tspComposer();
		const firstEpoch = host.tspSnapshot()!.epoch;
		tspMessage("q", { q: "hello", v: [1], features: ["send"] }); tspComposer();
		expect(host.tspSnapshot()).toMatchObject({ epoch: firstEpoch + 1, generation: 0, lifecycle: "live" });
		await expect(host.keys("\x1b[B", 0, firstEpoch)).rejects.toThrow("restarted");
		await host.keys("\x1b[B", 0, firstEpoch + 1);
		const queued = host.tspEvent(0, { ev: "visible", sf: "s:1", visible: true }, firstEpoch + 1);
		const refused = expect(queued).rejects.toThrow("semantic UI is not ready");
		pty.events.onHostOpen?.("room");
		expect(host.tspSnapshot()?.lifecycle).toBe("transitioning");
		await refused;
		await vi.waitFor(() => expect(host.state.phase).toBe("live"));
		pty.events.onHostClose?.("room");
		tspMessage("q", { q: "hello", v: [1], features: ["send"] }); tspComposer();
		expect(host.tspSnapshot()).toMatchObject({ generation: 1, lifecycle: "transitioning", surfaces: [{ documentGeneration: null }] });
		await expect(host.keys("\x1b[B", 1, firstEpoch + 2)).rejects.toThrow("semantic UI is not ready");
		await connect("replacement", "replacement-session");
		expect(host.tspSnapshot()).toMatchObject({ generation: 2, lifecycle: "transitioning" });
		tspMessage("f", { sf: "s:1", s: 2, ops: [["set", "editor", { sendable: true }]] });
		expect(host.tspSnapshot()?.lifecycle).toBe("live");
	});
	it.each(["new", "resume", "sibling-continuation"])("keeps recorded documents through a %s room generation change and renews authority per surface", async name => {
		await launchTsp();
		const messages = await recording(name, "messages");
		const events = await recording<TspRendererEvent>(name, "events");
		const boundary = events.find(event => event.body?.ev === "send")!.afterMessage;
		const exitBoundary = events.find(event => event.body?.ev === "send" && "text" in event.body && event.body.text === "/exit")!.afterMessage;
		for (const message of messages.slice(0, boundary)) tspMessage(message.verb, message.body);
		await connect();
		const before = host.tspSnapshot()!;
		pty.events.onHostClose?.("room");
		expect(host.tspSnapshot()!.surfaces[0]!.document).toEqual(before.surfaces[0]!.document);
		await connect(`${name}-room`, `${name}-session`);
		expect(host.tspSnapshot()).toMatchObject({ epoch: before.epoch, generation: 2, lifecycle: "transitioning" });
		expect(host.tspSnapshot()!.surfaces[0]!.document).toEqual(before.surfaces[0]!.document);
		await expect(host.tspEvent(1, { ev: "visible", sf: "s:1", visible: true }, before.epoch)).rejects.toThrow("session changed");
		for (const message of messages.slice(boundary, exitBoundary)) tspMessage(message.verb, message.body);
		expect(host.tspSnapshot()).toMatchObject({ epoch: before.epoch, generation: 2, lifecycle: "live" });
		await host.submit("Current room input");
		expect(pty.writes).toHaveBeenCalledWith(expect.stringContaining('"text":"Current room input"'));
	});
	it("resets retained documents on the recorded restart hello and refuses events from the reused surface's previous epoch", async () => {
		await launchTsp();
		const messages = await recording("restart", "messages");
		const restart = messages.findIndex((message, index) => index > 0 && message.verb === "q");
		expect(restart).toBeGreaterThan(0);
		for (const message of messages.slice(0, 4)) tspMessage(message.verb, message.body);
		await connect();
		const before = host.tspSnapshot()!;
		for (const message of messages.slice(4, restart)) tspMessage(message.verb, message.body);
		expect(host.tspSnapshot()?.surfaces[0]?.closed).toBe(true);
		tspMessage(messages[restart]!.verb, messages[restart]!.body);
		expect(host.tspSnapshot()).toMatchObject({ epoch: before.epoch + 1, surfaces: [] });
		for (const message of messages.slice(restart + 1, restart + 4)) tspMessage(message.verb, message.body);
		expect(host.tspSnapshot()).toMatchObject({ epoch: before.epoch + 1, lifecycle: "live", surfaces: [{ open: { id: "s:1" }, closed: false }] });
		await expect(host.tspEvent(1, { ev: "visible", sf: "s:1", visible: true }, before.epoch)).rejects.toThrow("restarted");
		await host.tspEvent(1, { ev: "visible", sf: "s:1", visible: true }, before.epoch + 1);
	});
	it("keeps a closed surface read-only and routes application input to its live replacement", async () => {
		await launchTsp();
		tspMessage("q", { q: "hello", v: [1], features: ["send"] }); tspComposer(); await connect();
		tspMessage("f", { sf: "s:1", s: 2, ops: [["add", "main", "s:1", null, { id: "main", k: "col", c: [{ id: "history", k: "text", p: { text: "Retained output" } }] }]] });
		tspMessage("x", { id: "s:1", keep: true });
		tspComposer("s:2", "replacement-editor");
		expect(host.tspSnapshot()?.surfaces[0]).toMatchObject({ closed: true, document: { c: [{ id: "main", c: [{ id: "history", p: { text: "Retained output" } }] }] } });
		await expect(host.tspEvent(1, { ev: "action", sf: "s:1", id: "history", act: "close" })).rejects.toThrow("surface is no longer available");
		await host.submit("Replacement input");
		expect(pty.writes).toHaveBeenCalledWith(expect.stringContaining('"sf":"s:2","id":"replacement-editor","text":"Replacement input"'));
	});
	it.each(["exit", "exit-with-overlay"])("replays recorded %s through shutdown and rejects application input after closing begins", async name => {
		await launchTsp();
		const messages = await recording("exit-with-overlay" === name ? name : "exit", "messages");
		const closeOverlay = name === "exit-with-overlay";
		const boundary = closeOverlay ? 5 : 4;
		for (const message of messages.slice(0, boundary)) tspMessage(message.verb, message.body);
		await connect();
		const epoch = host.tspSnapshot()!.epoch;
		pty.writes.mockClear();
		const stopping = host.stop();
		await expect(host.submit("late input")).rejects.toThrow("closing");
		await expect(host.keys("\x1b", 1, epoch)).rejects.toThrow("closing");
		await expect(host.tspEvent(1, { ev: "visible", sf: "s:1", visible: true }, epoch)).rejects.toThrow("closing");
		if (closeOverlay) {
			await vi.waitFor(() => expect(pty.writes).toHaveBeenCalledWith("\x1b"));
			expect(pty.writes).not.toHaveBeenCalledWith(expect.stringContaining('"text":"/exit"'));
			tspMessage(messages[boundary]!.verb, messages[boundary]!.body);
		}
		const expected = (await recording<TspRendererEvent>(name, "events")).find(event => event.body?.ev === "send" && "text" in event.body && event.body.text === "/exit")!.body;
		await vi.waitFor(() => expect(pty.writes).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify(expected))));
		for (const message of messages.slice(boundary + Number(closeOverlay))) tspMessage(message.verb, message.body);
		await exit(0); await stopping;
		expect(pty.kill).not.toHaveBeenCalled(); expect(pty.confirm).not.toHaveBeenCalled();
	});
});

it.each(["matched", "ambiguous"] as const)("writes no answer bytes for recorded hook-collab-aware with %s requests", async status => {
	await launchTsp();
	const messages = await recording("hook-collab-aware", "messages");
	for (const message of messages.slice(0, -1)) tspMessage(message.verb, message.body);
	await connect();
	const snapshot = host.tspSnapshot()!;
	const dialog = hookQuestions(snapshot.surfaces, 1)[0]!;
	expect(dialog).toBeDefined();
	const request = { reqId: 4, kind: "select", title: dialog.title, options: dialog.options ?? [] };
	const requests = status === "matched" ? [request] : [request, { ...request, reqId: 5 }];
	await host.tspEvent(1, { ev: "visible", sf: dialog.surfaceId, visible: true }, snapshot.epoch);
	pty.writes.mockClear();
	host.tspQuestions({ hostId: host.id, generation: 1, epoch: snapshot.epoch, connection: 1, revision: 1, connected: true, requests });
	expect(host.tspSnapshot()?.questionMatches).toMatchObject([{ status }]);
	await expect(host.tspAnswer(1, { kind: "choose", sf: dialog.surfaceId, id: dialog.nodeId, target: dialog.nodeId, item: "1" }, snapshot.epoch)).rejects.toThrow(status);
	await expect(host.keys("escape", 1, snapshot.epoch)).rejects.toThrow(status);
	expect(pty.writes).not.toHaveBeenCalled();
	expect(requests.map(request => request.reqId)).toEqual(status === "matched" ? [4] : [4, 5]);
});

it("marks the recorded unconfirmed optimistic surface fallback tspFailed instead of waiting on an empty screen", async () => {
	await launchTsp("darwin", true);
	const raw = await readFile(new URL("./tsp/fixtures/18.14.0/handshake-timeout.raw.bin", import.meta.url));
	pty.data?.(raw);
	expect(host.tspSnapshot()).toMatchObject({ negotiated: true, lifecycle: "transitioning", surfaces: [] });
	await vi.advanceTimersByTimeAsync(4999);
	expect(host.state.tspFailed).toBe(false);
	await vi.advanceTimersByTimeAsync(2);
	expect(host.state.tspFailed).toBe(true);
	expect(host.tspSnapshot()).toMatchObject({ lifecycle: "failed", failure: "omp did not start its semantic screen" });
	await expect(host.keys("\x1b", 0, host.tspSnapshot()!.epoch)).rejects.toThrow("semantic UI is not ready");
});
