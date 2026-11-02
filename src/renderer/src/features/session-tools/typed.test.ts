import type { HostState, TuiFocus } from "@shared/ipc";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestSnapshot } from "../../collab/lib/client";
import { SessionController } from "../../state/session";
import { commandResults } from "./results";
import { sendSlashCommand } from "./typed";
import { OmpBusyError, readyEditor, runCommand, TspEditorWatch } from "./drive";

const fake = vi.hoisted(() => {
	class Guest {
		snapshot = { phase: "live", entries: [], notices: [], working: true, uiRequest: null } as unknown as GuestSnapshot;
		listeners = new Set<() => void>();
		getSnapshot = () => this.snapshot;
		subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
		connect() {}
		close() {}
	}
	const app = { view: "chat", activeTabId: "chat", splitTabId: null as string | null, terminalTabId: null as string | null, openTerminal: vi.fn(), closeTerminal: vi.fn() };
	return { Guest, app, autoOpened: { tabId: null as string | null }, toast: vi.fn() };
});
vi.mock("../../collab/lib/client", () => ({ APP_GUEST_NAME: "visual-omp", GuestClient: fake.Guest }));
vi.mock("../../state/app", () => ({ useApp: { getState: () => fake.app } }));
vi.mock("../palette/TerminalSheet", () => ({ autoOpened: fake.autoOpened }));
vi.mock("../palette/overlays", () => ({ isNativeOverlay: () => false }));
vi.mock("./slash", () => ({
	routeSlash: async () => false,
	parseSlash: (line: string) => ({ name: line.trim().slice(1).split(/[\s:]/)[0], args: line.trim().replace(/^\/[^\s:]+[\s:]?/, "").trim() }),
}));
vi.mock("@/ui", () => ({ toast: fake.toast }));

const EDITOR = ["╭── π ▶ ⬢ Opus 5.5 · ◕ xhigh ▶ 🗑 project ▶──3%────────╮", "╰─                                ─╯"];
let session: SessionController;
let screen: string[];
let submitted: string[];
let focus: TuiFocus | null;
let failure: Error | null;
let submission: Promise<void> | null;
let submissionStarted: PromiseWithResolvers<void>;
let tsp: TspHostSnapshot | null;
let tspSubmit: ((text: string) => void) | null;
let channels: string[];
const tspListeners = new Set<(snapshot: TspHostSnapshot) => void>();

beforeEach(() => {
	vi.useFakeTimers();
	submitted = [];
	failure = null;
	focus = { overlays: 0, focused: "editor", overlayKinds: [], altScreen: false };
	submission = null;
	submissionStarted = Promise.withResolvers<void>();
	tsp = null;
	tspSubmit = null;
	channels = [];
	tspListeners.clear();
	fake.app.view = "chat";
	fake.app.activeTabId = "chat";
	fake.app.splitTabId = null;
	screen = ["Main reply so far", ...EDITOR];
	fake.autoOpened.tabId = null;
	fake.app.terminalTabId = null;
	fake.app.openTerminal.mockReset().mockImplementation((id: string) => { fake.app.terminalTabId = id; });
	vi.stubGlobal("window", { vomp: {
		on: (channel: string, listener: (snapshot: TspHostSnapshot) => void) => {
			if (channel === "host:tsp-update") tspListeners.add(listener);
			return () => tspListeners.delete(listener);
		},
		invoke: async (channel: string, _host: string, text: string) => {
			channels.push(channel);
			if (channel === "host:tsp-snapshot") return tsp;
			if (channel === "host:screen") return screen;
			if (channel === "host:tui-focus") return focus;
			if (channel === "composer:isSideCommand") return ["explain", "user-side", "nested", "folder:nested"].includes(text);
			if (channel === "host:submit") {
				submissionStarted.resolve();
				await submission;
				if (failure) throw failure;
				submitted.push(text);
				if (session.getSnapshot().host?.transport === "tsp") {
					tspSubmit?.(text);
					return null;
				}
				if (text === "/btw") {
					screen = ["Side-answer history"];
					focus = { overlays: 1, focused: "history", overlayKinds: ["history"], altScreen: false };
					session.attach({ ...session.getSnapshot().host!, tui: focus });
				} else {
					// omp's side answer is inline. Its editor and overlay count do not change.
					screen = ["Main reply so far", "╭─ btw ─╮", "Side answer", ...EDITOR];
					const guest = session.guestClient() as unknown as InstanceType<typeof fake.Guest>;
					setTimeout(() => {
						guest.snapshot = { ...guest.snapshot, stream: {} as GuestSnapshot["stream"] };
						for (const listener of guest.listeners) listener();
					}, 30);
				}
			}
			return null;
		},
	} });
	session = new SessionController({ tabId: "chat", projectPath: "/tmp", sessionFile: null });
	session.attach({ hostId: "host", phase: "live", cwd: "/tmp", sessionFile: "/tmp/chat.jsonl", sessionId: "room", generation: 1, link: "fake", tui: { overlays: 0, focused: "editor", overlayKinds: [] } } as unknown as HostState);
	for (const listener of (session.guestClient() as unknown as InstanceType<typeof fake.Guest>).listeners) listener();
});

afterEach(async () => {
	await session.dispose();
	await vi.advanceTimersByTimeAsync(1000);
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("slash commands sent while omp works", () => {
	it("shows a queued /btw side answer in the terminal after Send now", async () => {
		await sendSlashCommand(session, "/btw what changed?");
		const item = session.getSnapshot().queue[0]!;
		expect(submitted).toEqual([]);
		const sending = session.sendNow(item.id);
		await vi.advanceTimersByTimeAsync(1000);
		await sending;
		expect(submitted).toEqual(["/btw what changed?"]);
		expect(session.getSnapshot().queue).toEqual([]);
		expect(fake.app.terminalTabId).toBe("chat");
		expect(fake.autoOpened.tabId).toBeNull();
		expect(commandResults(session)).toEqual([]);
	});

	it("shows a directly submitted /btw side answer during the main turn", async () => {
		await sendSlashCommand(session, "/btw what changed?", { now: true });
		expect(submitted).toEqual(["/btw what changed?"]);
		expect(fake.app.terminalTabId).toBe("chat");
	});

	it.each(["/explain", "/explain this code", "/user-side", "/nested", "/folder:nested this code"])("opens an effective file side command without scraping its partial answer: %s", async line => {
		await sendSlashCommand(session, line, { now: true });
		await vi.advanceTimersByTimeAsync(2000);
		expect(submitted).toEqual([line]);
		expect(fake.app.terminalTabId).toBe("chat");
		expect(commandResults(session)).toEqual([]);
	});

	it("preserves normal result routing for a file command without side: true", async () => {
		await sendSlashCommand(session, "/ordinary", { now: true });
		expect(fake.app.terminalTabId).toBeNull();
	});

	it.each(["/fast status", "/queue next task", "/tan inspect tests"])("keeps existing result watching without opening a terminal for %s", async line => {
		await sendSlashCommand(session, line, { now: true });
		expect(submitted).toEqual([line]);
		expect(fake.app.terminalTabId).toBeNull();
	});

	it.each([
		{ label: "a hidden chat", view: "chat", active: "other" },
		{ label: "a non-chat page", view: "home", active: "chat" },
	])("does not open a terminal for $label", async ({ view, active }) => {
		await sendSlashCommand(session, "/btw what changed?");
		fake.app.view = view;
		fake.app.activeTabId = active;
		await session.sendNow(session.getSnapshot().queue[0]!.id);
		expect(submitted).toEqual(["/btw what changed?"]);
		expect(fake.app.openTerminal).not.toHaveBeenCalled();
		expect(session.getSnapshot().queue).toEqual([]);
	});

	it("opens the terminal for a visible split chat", async () => {
		fake.app.activeTabId = "other";
		fake.app.splitTabId = "chat";
		await sendSlashCommand(session, "/btw what changed?", { now: true });
		expect(fake.app.terminalTabId).toBe("chat");
		expect(fake.autoOpened.tabId).toBeNull();
	});

	it.each(["other", "chat"])("preserves the existing %s terminal and its automatic ownership", async target => {
		fake.app.terminalTabId = target;
		fake.autoOpened.tabId = target;
		await sendSlashCommand(session, "/btw what changed?", { now: true });
		expect(fake.app.openTerminal).not.toHaveBeenCalled();
		expect(fake.app.terminalTabId).toBe(target);
		expect(fake.autoOpened.tabId).toBe(target);
	});

	it("checks visibility again when submission finishes", async () => {
		const pending = Promise.withResolvers<void>();
		submission = pending.promise;
		const sending = sendSlashCommand(session, "/btw what changed?", { now: true });
		await submissionStarted.promise;
		fake.app.activeTabId = "other";
		pending.resolve();
		await sending;
		expect(submitted).toEqual(["/btw what changed?"]);
		expect(fake.app.openTerminal).not.toHaveBeenCalled();
	});

	it("holds the queue while bare /btw shows history, then releases it when the editor returns", async () => {
		const guest = session.guestClient() as unknown as InstanceType<typeof fake.Guest>;
		guest.snapshot.working = false;
		for (const listener of guest.listeners) listener();
		await sendSlashCommand(session, "/btw");
		await session.send("after history");
		await vi.advanceTimersByTimeAsync(900);
		expect(submitted).toEqual(["/btw"]);
		expect(session.getSnapshot().queue.map(item => item.text)).toEqual(["after history"]);
		expect(fake.app.terminalTabId).toBe("chat");
		screen = [...EDITOR];
		focus = { overlays: 0, focused: "editor", overlayKinds: [], altScreen: false };
		session.attach({ ...session.getSnapshot().host!, tui: focus });
		await vi.advanceTimersByTimeAsync(1000);
		expect(submitted).toEqual(["/btw", "after history"]);
		expect(session.getSnapshot().queue).toEqual([]);
		expect(fake.app.terminalTabId).toBe("chat");
		expect(commandResults(session)).toEqual([]);
	});

	it("shows /btw when omp is idle too, without scraping a partial side answer", async () => {
		const guest = session.guestClient() as unknown as InstanceType<typeof fake.Guest>;
		guest.snapshot.working = false;
		for (const listener of guest.listeners) listener();
		await sendSlashCommand(session, "/btw what changed?");
		await vi.advanceTimersByTimeAsync(2000);
		expect(fake.app.terminalTabId).toBe("chat");
		expect(commandResults(session)).toEqual([]);
		expect(submitted).toEqual(["/btw what changed?"]);
	});

	it("restores the exact queued command and rejects with the reason when submission fails", async () => {
		await sendSlashCommand(session, "/btw what changed?");
		await session.send("afterwards");
		const before = session.getSnapshot().queue;
		failure = new Error("omp stopped before submission");
		await expect(session.sendNow(before[0]!.id)).rejects.toThrow("omp stopped before submission");
		expect(session.getSnapshot().queue).toEqual(before);
		expect(submitted).toEqual([]);
		expect(fake.app.terminalTabId).toBeNull();
	});

	it("rejects a direct send before typing when an omp menu owns the editor", async () => {
		screen = ["Pick a model"];
		const sending = sendSlashCommand(session, "/btw what changed?", { now: true });
		const rejected = expect(sending).rejects.toThrow();
		await vi.advanceTimersByTimeAsync(8500);
		await rejected;
		expect(submitted).toEqual([]);
		expect(fake.app.terminalTabId).toBeNull();
	});
});

describe("slash input history ownership", () => {
	it("does not record old input or open its terminal after the session changes during submission", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(session, "command").mockImplementation(async () => {
			started.resolve();
			await release.promise;
		});
		const sending = sendSlashCommand(session, "/btw old question", { now: true });
		await started.promise;
		session.attach({
			...session.getSnapshot().host!,
			sessionId: "other-room",
			sessionFile: "/tmp/other.jsonl",
			generation: 2,
			link: "other-link",
		});
		release.resolve();
		await sending;
		expect(session.getSnapshot().inputHistory).toEqual([]);
		expect(fake.app.terminalTabId).toBeNull();
	});
});

function semanticSnapshot(blocked: "overlay" | "screen" | null = null): TspHostSnapshot {
	return {
		hostId: "host", generation: 1, epoch: 1, revision: 1, negotiated: true,
		lifecycle: "live", documentGeneration: 1, failure: null,
		availability: { available: !blocked, reason: blocked ? "Close omp's menu." : null },
		surfaces: [{
			open: { id: "s:1", mode: blocked === "screen" ? "screen" : "inline", role: "omp.session" },
			documentGeneration: 1, sequence: 1, closed: false, focus: "editor", suspended: false, settled: [],
			document: { id: "s:1", k: "col", c: [
				{ id: "main", k: "col" },
				{ id: "dock", k: "col", p: { role: "omp.editor" }, c: [{ id: "editor", k: "editor", p: { sendable: true, text: "" } }] },
				{ id: "layer", k: "col", c: blocked === "overlay" ? [{ id: "dialog", k: "overlay", p: { role: "omp.overlay.hook-select" } }] : [] },
			] },
		}],
	};
}

function publishTsp(patch: Partial<TspHostSnapshot> = {}, blocked: "overlay" | "screen" | null = null): void {
	tsp = { ...semanticSnapshot(blocked), ...tsp, surfaces: semanticSnapshot(blocked).surfaces,
		availability: semanticSnapshot(blocked).availability, revision: (tsp?.revision ?? 0) + 1, ...patch };
	for (const listener of tspListeners) listener(tsp);
}

function semanticSession(working = false): void {
	tsp = semanticSnapshot();
	session.attach({ ...session.getSnapshot().host!, transport: "tsp", tui: null });
	setWorking(working);
}

function setWorking(working: boolean): void {
	const guest = session.guestClient() as unknown as InstanceType<typeof fake.Guest>;
	guest.snapshot = { ...guest.snapshot, working };
	for (const listener of guest.listeners) listener();
}

describe("TSP slash delivery", () => {
	afterEach(() => {
		expect(channels).not.toContain("host:screen");
		expect(channels).not.toContain("host:tui-focus");
	});

	it.each(["overlay", "screen"] as const)("submits once and holds following messages while an omp %s is open", async blocked => {
		semanticSession();
		tspSubmit = text => { if (text.startsWith("/")) publishTsp({}, blocked); };
		await sendSlashCommand(session, "/vomp-fixture-confirm");
		await session.send("after the command");
		await vi.advanceTimersByTimeAsync(2000);
		expect(submitted).toEqual(["/vomp-fixture-confirm"]);
		expect(session.getSnapshot().queue.map(item => item.text)).toEqual(["after the command"]);
		expect(commandResults(session)).toEqual([]);
		publishTsp();
		await vi.advanceTimersByTimeAsync(650);
		expect(submitted).toEqual(["/vomp-fixture-confirm", "after the command"]);
		expect(session.getSnapshot().queue).toEqual([]);
		// OverlayWatcher owns semantic sheet opening and closure.
		expect(fake.app.openTerminal).not.toHaveBeenCalled();
	});

	it("observes an overlay published shortly after the submit response", async () => {
		semanticSession();
		tspSubmit = text => { if (text.startsWith("/")) setTimeout(() => publishTsp({}, "overlay"), 50); };
		await sendSlashCommand(session, "/vomp-fixture-confirm");
		await session.send("afterwards");
		await vi.advanceTimersByTimeAsync(1200);
		expect(submitted).toEqual(["/vomp-fixture-confirm"]);
		publishTsp();
		await vi.advanceTimersByTimeAsync(650);
		expect(submitted).toEqual(["/vomp-fixture-confirm", "afterwards"]);
	});

	it("releases a sendable editor despite continuous unrelated document and session updates", async () => {
		semanticSession();
		await sendSlashCommand(session, "/extension-ui-only");
		await session.send("afterwards");
		for (let i = 0; i < 6; i++) {
			await vi.advanceTimersByTimeAsync(100);
			publishTsp();
			session.recordInput(`unrelated input ${i}`);
		}
		expect(submitted).toEqual(["/extension-ui-only", "afterwards"]);
		expect(session.getSnapshot().queue).toEqual([]);
	});

	it("restarts editor settling only after ownership becomes blocked", async () => {
		semanticSession();
		await sendSlashCommand(session, "/extension-ui-only");
		await session.send("afterwards");
		await vi.advanceTimersByTimeAsync(400);
		publishTsp({}, "overlay");
		await vi.advanceTimersByTimeAsync(400);
		publishTsp();
		await vi.advanceTimersByTimeAsync(400);
		expect(submitted).toEqual(["/extension-ui-only"]);
		await vi.advanceTimersByTimeAsync(200);
		expect(submitted).toEqual(["/extension-ui-only", "afterwards"]);
	});

	it("drains a queued slash through the same semantic submit and releases without a collab acknowledgement", async () => {
		semanticSession(true);
		tspSubmit = text => { if (text.startsWith("/")) publishTsp({}, "overlay"); };
		await sendSlashCommand(session, "/hotkeys");
		await session.send("after the queued command");
		expect(submitted).toEqual([]);
		setWorking(false);
		await vi.advanceTimersByTimeAsync(1000);
		expect(submitted).toEqual(["/hotkeys"]);
		publishTsp();
		await vi.advanceTimersByTimeAsync(650);
		expect(submitted).toEqual(["/hotkeys", "after the queued command"]);
	});

	it.each(["overlay", "screen"] as const)("refuses an already open %s with OmpBusyError before submission", async blocked => {
		semanticSession();
		publishTsp({}, blocked);
		await expect(readyEditor(session)).rejects.toBeInstanceOf(OmpBusyError);
		await expect(sendSlashCommand(session, "/vomp-fixture-confirm")).rejects.toBeInstanceOf(OmpBusyError);
		expect(submitted).toEqual([]);
	});

	it("retries a queued slash when the busy semantic editor returns", async () => {
		semanticSession(true);
		await sendSlashCommand(session, "/vomp-fixture-confirm");
		publishTsp({}, "overlay");
		setWorking(false);
		await vi.advanceTimersByTimeAsync(1000);
		expect(submitted).toEqual([]);
		expect(session.getSnapshot().queue).toHaveLength(1);
		publishTsp();
		await vi.advanceTimersByTimeAsync(1000);
		expect(submitted).toEqual(["/vomp-fixture-confirm"]);
		expect(session.getSnapshot().queue).toEqual([]);
		expect(session.busy).toBe(false);
	});

	it("waits for a queued command's editor when collab becomes idle before sendable", async () => {
		semanticSession(true);
		await sendSlashCommand(session, "/extension-ui-only");
		publishTsp({ availability: { available: false, reason: "Wait for omp to finish opening its main editor." } });
		setWorking(false);
		await vi.advanceTimersByTimeAsync(1000);
		expect(submitted).toEqual([]);
		publishTsp();
		await vi.advanceTimersByTimeAsync(650);
		expect(submitted).toEqual(["/extension-ui-only"]);
		expect(session.getSnapshot().queue).toEqual([]);
		expect(session.busy).toBe(false);
	});

	it("leaves an unsupported queued send untouched after one bounded readiness attempt", async () => {
		semanticSession(true);
		await sendSlashCommand(session, "/extension-ui-only");
		publishTsp({ availability: { available: false, reason: "omp does not accept send events." } });
		setWorking(false);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(submitted).toEqual([]);
		expect(session.getSnapshot().queue.map(item => item.text)).toEqual(["/extension-ui-only"]);
		// Failed readiness does not reinstall an overlay retry hold or loop requests.
		expect(channels.filter(channel => channel === "host:tsp-snapshot")).toHaveLength(3);
	});

	it.each(["exit", "epoch", "generation"] as const)("releases a command hold after %s invalidates its scope", async change => {
		semanticSession();
		tspSubmit = () => publishTsp({}, "overlay");
		await sendSlashCommand(session, "/vomp-fixture-confirm");
		expect(session.busy).toBe(true);
		if (change === "exit") session.attach({ ...session.getSnapshot().host!, phase: "exited" });
		else if (change === "epoch") publishTsp({ epoch: 2 }, "overlay");
		else session.attach({ ...session.getSnapshot().host!, generation: 2 });
		await vi.advanceTimersByTimeAsync(50);
		if (change === "exit") session.attach({ ...session.getSnapshot().host!, phase: "live" });
		expect(session.busy).toBe(false);
	});

	it("releases the watch when the command starts a turn", async () => {
		semanticSession();
		const held = vi.spyOn(session, "holdQueue");
		tspSubmit = () => setWorking(true);
		await sendSlashCommand(session, "/extension-starts-turn");
		await vi.advanceTimersByTimeAsync(0);
		await expect(held.mock.calls[0]![0]).resolves.toBeUndefined();
	});

	it("preserves main's unavailable reason without falling back to the screen", async () => {
		semanticSession();
		publishTsp({ availability: { available: false, reason: "omp does not accept send events." } });
		const refused = expect(readyEditor(session)).rejects.toThrow("omp does not accept send events.");
		await vi.advanceTimersByTimeAsync(8100);
		await refused;
	});

	it("uses semantic readiness for runCommand and leaves feedback to notices", async () => {
		semanticSession();
		const running = runCommand(session, "/rename example");
		await vi.advanceTimersByTimeAsync(650);
		await expect(running).resolves.toEqual({ output: [], screen: [] });
		expect(submitted).toEqual(["/rename example"]);
	});

	it("ends an editor-back hold on an epoch change", async () => {
		semanticSession();
		publishTsp({}, "overlay");
		const watch = new TspEditorWatch(session);
		const back = watch.back();
		await vi.advanceTimersByTimeAsync(0);
		publishTsp({ epoch: 2 }, "overlay");
		await expect(back).resolves.toBeUndefined();
		watch.dispose();
	});

	it("releases an editor-back hold when the snapshot request fails", async () => {
		semanticSession();
		vi.spyOn(window.vomp, "invoke").mockRejectedValueOnce(new Error("snapshot read failed"));
		const watch = new TspEditorWatch(session);
		const back = watch.back();
		session.holdQueue(back);
		await expect(back).resolves.toBeUndefined();
		await vi.advanceTimersByTimeAsync(0);
		expect(session.busy).toBe(false);
		watch.dispose();
	});

	it("keeps a received document authoritative when its initial snapshot request later fails", async () => {
		semanticSession();
		vi.spyOn(window.vomp, "invoke").mockRejectedValueOnce(new Error("late snapshot read failure"));
		const watch = new TspEditorWatch(session);
		publishTsp({ availability: { available: false, reason: "Wait for omp's editor." } });
		const ready = watch.ready();
		await vi.advanceTimersByTimeAsync(0);
		publishTsp();
		await expect(ready).resolves.toBeUndefined();
		watch.dispose();
	});

	it("releases an editor-back hold when main no longer has a semantic snapshot", async () => {
		semanticSession();
		tsp = null;
		const watch = new TspEditorWatch(session);
		const back = watch.back();
		session.holdQueue(back);
		await expect(back).resolves.toBeUndefined();
		await vi.advanceTimersByTimeAsync(0);
		expect(session.busy).toBe(false);
		watch.dispose();
	});
});
