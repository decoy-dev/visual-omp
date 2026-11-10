// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { commandPanelFrames } from "@shared/tsp/testing/command-panel-fixtures";
import { walkNodes } from "@shared/tsp/view-state";
import type { SessionController, SessionView } from "../../state/session";
import { openRequestedScreen, runCommand } from "./drive";
import { commandResults } from "./results";
import { screenActivity } from "../../state/tsp/screen-activity";
import { currentPresentationConsumers, presentationClaims } from "../../state/tsp/presentation-claims";
import { screenCandidateKey } from "../palette/auto-screen";

const fake = vi.hoisted(() => ({
	snapshot: null as TspHostSnapshot | null, listeners: new Set<() => void>(),
	sessionListeners: new Set<() => void>(), appListeners: new Set<() => void>(),
	app: { view: "chat", activeTabId: "tab", splitTabId: null, terminalTabId: null as string | null, sheet: null as object | null, openTerminal: vi.fn() },
}));
vi.mock("../../state/tsp/hosts", () => ({ tspHost: (hostId: string) => ({ hostId, getSnapshot: () => fake.snapshot, failed: () => false, subscribe: (listener: () => void) => { fake.listeners.add(listener); return () => fake.listeners.delete(listener); } }) }));
vi.mock("../../state/app", () => ({ useApp: { getState: () => fake.app, subscribe: (listener: () => void) => { fake.appListeners.add(listener); return () => fake.appListeners.delete(listener); } } }));
vi.mock("@/ui", () => ({ toast: vi.fn() }));
const publish = (snapshot: TspHostSnapshot) => { fake.snapshot = snapshot; for (const listener of fake.listeners) listener(); };
let requestOnce: MockInstance<typeof screenActivity.requestOnce>;
let claimReleases: (() => void)[];
let visibilityDescriptor: PropertyDescriptor | undefined;
function session(command: () => Promise<void>, earlierWrite?: () => void) {
	const listeners = fake.sessionListeners;
	const guest = { entries: [], phase: "live", loading: false, header: { id: "room" } };
	const view = { mode: "live", working: false, host: { hostId: "host", sessionId: "room", generation: 1, transport: "tsp" }, guest, displayLeaf: null, history: null } as unknown as SessionView;
	return { tabId: "tab", hostId: "host", getSnapshot: () => view, guestClient: () => guest, whenLive: async () => {}, holdQueue: () => {}, command: async (_line: string, beforeSubmit?: () => void) => { earlierWrite?.(); beforeSubmit?.(); await command(); },
		subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }, onEvent: () => () => {}, tspNotices: { beginCommand: vi.fn() } } as unknown as SessionController;
}
beforeEach(() => {
	vi.useFakeTimers(); fake.listeners.clear(); fake.sessionListeners.clear(); fake.appListeners.clear();
	Object.assign(fake.app, { view: "chat", activeTabId: "tab", splitTabId: null, terminalTabId: null, sheet: null });
	requestOnce = vi.spyOn(screenActivity, "requestOnce");
	claimReleases = [];
	visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
	fake.app.openTerminal.mockReset().mockImplementation((tabId: string) => { fake.app.terminalTabId = tabId; });
});
afterEach(async () => {
	for (const result of requestOnce.mock.results) if (result.type === "return") { result.value.cancel(); await result.value.done; }
	for (const release of claimReleases) release();
	if (visibilityDescriptor) Object.defineProperty(document, "visibilityState", visibilityDescriptor);
	else Reflect.deleteProperty(document, "visibilityState");
	requestOnce.mockRestore();
	vi.useRealTimers(); fake.listeners.clear(); fake.sessionListeners.clear(); fake.appListeners.clear();
});
it("collects bare native cleanse through its question without a second toast outcome", async () => {
	const frames = commandPanelFrames("cleanse"); fake.snapshot = frames[0]!;
	const chat = session(async () => { publish(frames.at(-2)!); }); const present = vi.fn(() => false);
	const pending = runCommand(chat, "/cleanse", { present });
	await vi.advanceTimersByTimeAsync(10);
	publish(frames.at(-1)!); await vi.advanceTimersByTimeAsync(650);
	expect(await pending).toEqual({ output: [], screen: [] });
	expect(chat.tspNotices.beginCommand).not.toHaveBeenCalled();
	expect(commandResults(chat)).toMatchObject([{ command: "/cleanse", tone: "warn", lines: ["No runnable checker", "No supported checker with an available executable was found."] }]);
	expect(present).toHaveBeenCalledExactlyOnceWith({ output: [], screen: [] });
});
it("stops native report collection when its submission rejects", async () => {
	const frames = commandPanelFrames("advisor-status"); fake.snapshot = frames[0]!;
	const chat = session(async () => { throw new Error("Submission refused"); });
	await expect(runCommand(chat, "/advisor status")).rejects.toThrow("Submission refused");
	expect(screenActivity.has(frames[0]!, "drive")).toBe(false);
	expect(screenActivity.has(frames[0]!, "request")).toBe(false);
	publish(frames.at(-1)!);
	expect(commandResults(chat)).toEqual([]); expect(fake.listeners.size).toBe(0);
});

it("excludes a report published by an earlier serialized write before this command submits", async () => {
	const frames = commandPanelFrames("advisor-status"); fake.snapshot = frames[0]!;
	const chat = session(async () => {}, () => { publish(frames.at(-1)!); publish(frames[0]!); });
	const pending = runCommand(chat, "/advisor status");
	await vi.advanceTimersByTimeAsync(650);
	expect(await pending).toEqual({ output: [], screen: [] });
	expect(commandResults(chat)).toEqual([]);
});

it("holds drive only during the actual write, leaving a native question eligible afterwards", async () => {
	const frames = commandPanelFrames("cleanse"); fake.snapshot = frames[0]!;
	const write = Promise.withResolvers<void>();
	const chat = session(async () => { publish(frames.at(-2)!); await write.promise; }, () => {
		expect(screenActivity.has(frames[0]!, "drive")).toBe(false);
	});
	let completed = false;
	const pending = runCommand(chat, "/cleanse").then(result => { completed = true; return result; });
	await vi.advanceTimersByTimeAsync(0);
	expect(screenActivity.has(frames[0]!, "drive")).toBe(true);
	expect(screenActivity.has(frames[0]!, "request")).toBe(false);
	write.resolve(); await vi.advanceTimersByTimeAsync(0);
	expect(screenActivity.has(frames[0]!, "drive")).toBe(false);
	expect(completed).toBe(false);
	publish(frames.at(-1)!); await vi.advanceTimersByTimeAsync(650);
	await pending;
});

it("keeps a deliberate live-board request through its native question without a drive hold", async () => {
	const frames = commandPanelFrames("cleanse"); fake.snapshot = frames[0]!;
	const chat = session(async () => { publish(frames.at(-2)!); });
	const pending = runCommand(chat, "/cleanse", { screenIntent: "request" });
	await vi.advanceTimersByTimeAsync(20);
	expect(screenActivity.has(frames[0]!, "request")).toBe(true);
	expect(screenActivity.has(frames[0]!, "drive")).toBe(false);
	expect(fake.app.openTerminal).not.toHaveBeenCalled();
	expect(requestOnce).toHaveBeenCalledExactlyOnceWith(frames.at(-2), frames.at(-2)!.revision, screenCandidateKey(frames.at(-2)!, currentPresentationConsumers(frames[0]!.hostId, frames[0]!.epoch)));
	screenActivity.consumeRequests(frames.at(-2)!, frames.at(-2)!.revision);
	publish(frames.at(-1)!); await vi.advanceTimersByTimeAsync(650);
	await pending;
	expect(screenActivity.has(frames[0]!, "request")).toBe(false);
	expect(fake.app.openTerminal).not.toHaveBeenCalled();
	expect(fake.appListeners.size).toBe(0);
});

it.each(["drive", "request"] as const)("releases %s on scope change even while submission is pending", async kind => {
	const frames = commandPanelFrames("advisor-status"); fake.snapshot = frames[0]!;
	const write = Promise.withResolvers<void>();
	const pending = runCommand(session(() => write.promise), "/advisor status", kind === "request" ? { screenIntent: "request" } : {});
	await vi.advanceTimersByTimeAsync(0);
	expect(screenActivity.has(frames[0]!, kind)).toBe(true);
	publish({ ...frames[0]!, epoch: frames[0]!.epoch + 1, revision: frames[0]!.revision + 1 });
	expect(screenActivity.has(frames[0]!, kind)).toBe(false);
	write.resolve(); await pending;
});

it("queues no absent candidate and keeps request intent for a later publication", async () => {
	const frames = commandPanelFrames("cleanse"); fake.snapshot = frames[0]!;
	const pending = runCommand(session(async () => {}), "/cleanse", { screenIntent: "request" });
	await vi.advanceTimersByTimeAsync(0);
	expect(requestOnce).not.toHaveBeenCalled();
	expect(screenActivity.has(frames[0]!, "request")).toBe(true);
	publish(frames.at(-2)!);
	expect(screenActivity.has(frames[0]!, "request")).toBe(true);
	expect(fake.app.openTerminal).not.toHaveBeenCalled();
	publish(frames.at(-1)!); await vi.advanceTimersByTimeAsync(650);
	await pending;
	expect(screenActivity.has(frames[0]!, "request")).toBe(false);
});

it.each(["cancels", "consumes"] as const)("cleans handoff subscriptions when policy %s a pending request", async policy => {
	const candidate = commandPanelFrames("cleanse").at(-2)!; fake.snapshot = candidate;
	openRequestedScreen(session(async () => {}), candidate);
	expect(requestOnce).toHaveBeenCalledExactlyOnceWith(candidate, candidate.revision, screenCandidateKey(candidate, currentPresentationConsumers(candidate.hostId, candidate.epoch)));
	expect(fake.listeners.size).toBe(1);
	expect(fake.sessionListeners.size).toBe(1);
	expect(fake.appListeners.size).toBe(1);
	const request = requestOnce.mock.results[0]!.value!;
	if (policy === "cancels") request.cancel();
	else screenActivity.consumeRequests(candidate, candidate.revision);
	await request.done;
	expect(fake.listeners.size).toBe(0);
	expect(fake.sessionListeners.size).toBe(0);
	expect(fake.appListeners.size).toBe(0);
	expect(fake.app.openTerminal).not.toHaveBeenCalled();
});

it.each(["disappearance", "replacement", "epoch", "session", "consumer", "hidden document", "hidden chat", "manual terminal", "another sheet"] as const)("cancels a queued native handoff on %s", async change => {
	const frames = commandPanelFrames("cleanse"), candidate = frames.at(-2)!;
	fake.snapshot = candidate;
	const chat = session(async () => {});
	openRequestedScreen(chat, candidate);
	expect(requestOnce).toHaveBeenCalledOnce();
	const request = requestOnce.mock.results[0]!.value!;
	let done = false;
	void request.done.then(() => { done = true; });
	await Promise.resolve(); expect(done).toBe(false);
	if (change === "disappearance") publish(frames[0]!);
	else if (change === "replacement") {
		const next = structuredClone(candidate); next.revision++;
		for (const surface of next.surfaces) surface.open.id = `${surface.open.id}-replacement`;
		const key = screenCandidateKey(next, currentPresentationConsumers(next.hostId, next.epoch));
		expect(key).not.toBeNull();
		expect(key).not.toBe(screenCandidateKey(candidate, currentPresentationConsumers(candidate.hostId, candidate.epoch)));
		publish(next);
	} else if (change === "epoch") publish({ ...candidate, epoch: candidate.epoch + 1, revision: candidate.revision + 1 });
	else if (change === "session") {
		chat.getSnapshot().host!.sessionId = "other-room";
		for (const listener of fake.sessionListeners) listener();
	} else if (change === "consumer") {
		for (const surface of candidate.surfaces) for (const node of walkNodes(surface.document)) claimReleases.push(presentationClaims.acquire({ hostId: candidate.hostId, epoch: candidate.epoch, surfaceId: surface.open.id, nodeId: node.id }));
	} else if (change === "hidden document") {
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
		document.dispatchEvent(new Event("visibilitychange"));
	} else {
		if (change === "hidden chat") fake.app.activeTabId = "other";
		if (change === "manual terminal") fake.app.terminalTabId = "tab";
		if (change === "another sheet") fake.app.sheet = {};
		for (const listener of fake.appListeners) listener();
	}
	await Promise.resolve();
	expect(done).toBe(true);
	expect(fake.listeners.size).toBe(0);
	expect(fake.sessionListeners.size).toBe(0);
	expect(fake.appListeners.size).toBe(0);
	expect(fake.app.openTerminal).not.toHaveBeenCalled();
});
