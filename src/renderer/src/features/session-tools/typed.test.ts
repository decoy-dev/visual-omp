import type { HostState } from "@shared/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestSnapshot } from "../../collab/lib/client";
import { SessionController } from "../../state/session";
import { commandResults } from "./results";
import { sendSlashCommand } from "./typed";

const fake = vi.hoisted(() => {
	class Guest {
		snapshot = { phase: "live", entries: [], working: true, uiRequest: null } as unknown as GuestSnapshot;
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
let failure: Error | null;
let submission: Promise<void> | null;
let submissionStarted: PromiseWithResolvers<void>;

beforeEach(() => {
	vi.useFakeTimers();
	submitted = [];
	failure = null;
	submission = null;
	submissionStarted = Promise.withResolvers<void>();
	fake.app.view = "chat";
	fake.app.activeTabId = "chat";
	fake.app.splitTabId = null;
	screen = ["Main reply so far", ...EDITOR];
	fake.autoOpened.tabId = null;
	fake.app.terminalTabId = null;
	fake.app.openTerminal.mockReset().mockImplementation((id: string) => { fake.app.terminalTabId = id; });
	vi.stubGlobal("window", { vomp: {
		on: () => () => undefined,
		invoke: async (channel: string, _host: string, text: string) => {
			if (channel === "host:screen") return screen;
			if (channel === "composer:isSideCommand") return ["explain", "user-side", "nested", "folder:nested"].includes(text);
			if (channel === "host:submit") {
				submissionStarted.resolve();
				await submission;
				if (failure) throw failure;
				submitted.push(text);
				if (text === "/btw") {
					screen = ["Side-answer history"];
					session.attach({ ...session.getSnapshot().host!, tui: { overlays: 1, focused: "history", overlayKinds: ["history"], altScreen: false } });
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
		session.attach({ ...session.getSnapshot().host!, tui: { overlays: 0, focused: "editor", overlayKinds: [], altScreen: false } });
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
