import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Sessions from "./sessions";
import type { RelayEvents } from "./relay";
import type { TuiFocus } from "@shared/ipc";

const pty = vi.hoisted(() => ({
	data: null as ((data: string) => void) | null,
	exit: null as ((event: { exitCode: number }) => void) | null,
	args: [] as string[],
	root: "",
	events: {} as RelayEvents,
	room: "room",
	sessionId: "old",
	focus: null as TuiFocus | null,
}));
vi.mock("node-pty", () => ({
	spawn: vi.fn((_bin, args: string[]) => {
		pty.args = args;
		return { pid: 123, onData: (fn: typeof pty.data) => (pty.data = fn), onExit: (fn: typeof pty.exit) => (pty.exit = fn), write: vi.fn() };
	}),
}));
vi.mock("../env", () => ({ userEnv: async () => ({}), ptyEnv: (env: unknown) => env }));
vi.mock("../ipc", () => ({ broadcast: vi.fn() }));
vi.mock("../prefs", () => ({ getPrefs: () => ({ archivedSessions: [], extraProjects: [] }) }));
vi.mock("./cli", () => ({
	runOmpJson: async (args: string[]) =>
		args[1] === "list"
			? { hosts: [{ instanceId: "host", generation: 1, pid: 123, sessionId: pty.sessionId, cwd: "/tmp" }] }
			: { url: `ws://localhost:9999/r/${pty.room}.key`, generation: 1 },
}));
vi.mock("./locate", () => ({ ompPath: async () => "/omp" }));
vi.mock("./refused", () => ({ ompStartError: (error: unknown) => error }));
vi.mock("./paths", () => ({ sessionsDir: () => pty.root }));
vi.mock("./sessions", async importOriginal => ({ ...(await importOriginal<typeof Sessions>()), onSessionsChanged: vi.fn() }));
vi.mock("./relay", () => ({
	LoopbackRelay: class {
		url = "ws://localhost:9999";
		set events(events: RelayEvents) { pty.events = events; }
		start = async () => {};
		stop() {}
	},
}));
vi.mock("./tui-debug", () => ({ TuiDebugClient: class { info = async () => pty.focus; close() {} } }));

import { SessionHost } from "./host";

let host: SessionHost;
beforeEach(async () => {
	pty.root = await mkdtemp(join(tmpdir(), "vomp-host-test-"));
	pty.events = {};
	pty.focus = null;
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
	it("pins unsupported terminal-only features for each hosted chat", async () => {
		const overlay = parse(await readFile(pty.args[1]!, "utf8"));
		expect(overlay).toMatchObject({
			collab: { autoStart: "control", relayUrl: "ws://localhost:9999", displayName: "visual-omp" },
			out: { enabled: false },
			tui: { renderSvg: false, autoGraph: "off" },
			worktree: { onStart: "off", onExit: "keep" },
			composer: { predictions: false },
			recap: { enabled: false },
		});
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
