// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostState } from "@shared/ipc";
import { routeSlash } from "../../features/session-tools/slash";
import { ResumeDeclinedError } from "../../registry/guards";
import type { SessionController, SessionView } from "../../state/session";
import { toast } from "../../ui/toast";
import type * as ToastModule from "../../ui/toast";
import { TooltipProvider } from "../../ui/Tooltip";
import { useComposerDrafts } from "./drafts";
import { Composer } from "./Composer";
import "../../i18n";

vi.hoisted(() => {
	Object.assign(window, { vomp: { platform: "darwin", invoke: async (channel: string) => channel === "composer:assist" ? { items: null, keywords: [] } : [], on: () => () => {} } });
	// Exercise Motion's JS fallback: happy-dom's cancelled WAAPI promises reject during draft transitions.
	Reflect.deleteProperty(Element.prototype, "animate");
});
vi.mock("../../state/app", () => ({ useApp: (select: (state: { prefs: { voiceInput: boolean }; btwDrawers: Record<string, boolean> }) => unknown) => select({ prefs: { voiceInput: false }, btwDrawers: {} }) }));
vi.mock("../../features/session-tools/slash", () => ({ routeSlash: vi.fn() }));
vi.mock("../../features/session-tools/typed", () => ({ sendSlashCommand: vi.fn() }));
vi.mock("../../registry/slots", () => ({ chatSlots: { use: () => [] } }));
vi.mock("../branch", () => ({ useBranchEntries: () => [] }));
vi.mock("./attach", () => ({ attachFiles: vi.fn(), attachPaths: vi.fn(), useThumbnail: () => null }));
vi.mock("./MentionPicker", () => ({ MentionPicker: () => null, useProjectFiles: () => null }));
vi.mock("./SlashMenu", () => ({ SlashMenu: () => null, useSlashCommands: () => [], slashOptions: () => null, slashAtCaret: () => null }));
vi.mock("./PromptLibrary", () => ({ PromptLibrary: () => null }));
vi.mock("./QueueTray", () => ({ QueueTray: () => null }));
vi.mock("./VoiceTool", () => ({ VoiceTool: () => null, useVoiceRequests: { getState: () => ({ requestStart: vi.fn() }) } }));
vi.mock("./predictions", () => ({ useGhostText: () => ({ suffix: "" }), ghostSourceUnchanged: () => true }));
vi.mock("./tools", () => ({ QUICK_MODES: [] }));
vi.mock("./PredictionRecovery", () => ({ PredictionRecovery: () => null, acknowledgePrediction: vi.fn(), usePredictionCaptures: { getState: () => ({ merge: vi.fn() }) } }));
vi.mock("../../ui/toast", async importOriginal => ({ ...await importOriginal<typeof ToastModule>(), toast: vi.fn() }));

let root: Root; let element: HTMLDivElement; let view: SessionView;
let fontsDescriptor: PropertyDescriptor | undefined;
const subscribers = new Set<() => void>();
async function publish(patch: Partial<SessionView>) {
	await act(async () => {
		view = { ...view, ...patch };
		for (const listener of subscribers) listener();
	});
}
// These tests mount Composer itself; only unrelated data sources and auxiliary tools are replaced.
const session = { tabId: "availability", projectPath: "/tmp", subscribe: (listener: () => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; }, getSnapshot: () => view, send: vi.fn(), steer: vi.fn(), preserveFailedMessage: vi.fn() } as unknown as SessionController;
const host = (transport: HostState["transport"], tspAvailability: HostState["tspAvailability"]): HostState => ({ hostId: "host", generation: 1, transport, tspAvailability }) as HostState;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	subscribers.clear();
	vi.mocked(session.send).mockReset().mockResolvedValue(undefined);
	vi.mocked(session.preserveFailedMessage).mockReset();
	// happy-dom omits FontFaceSet; Composer only subscribes to its loadingdone event here.
	fontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");
	Object.defineProperty(document, "fonts", { configurable: true, value: new EventTarget() });
	view = { mode: "live", readOnly: false, working: false, workingSince: null, follow: null, ownerUnverified: false, guest: null, history: null, carryover: null, displayLeaf: null, inputHistory: [], queue: [], strandedImages: false, host: null, error: null };
	useComposerDrafts.getState().setDraft("availability", "A message ready to send");
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
	await act(async () => root.unmount()); useComposerDrafts.getState().forget("availability"); element.remove();
	if (fontsDescriptor) Object.defineProperty(document, "fonts", fontsDescriptor);
	else Reflect.deleteProperty(document, "fonts");
});
it("renders the matched question instruction and keeps ordinary menu and classic composer behavior distinct", async () => {
	view = { ...view, host: host("tsp", { available: false, reason: "Main fallback text", reasonCode: "matched-question" }) };
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(Composer, { session }))));
	expect(element.querySelector('[role="status"]')?.textContent).toBe("Answer the question card before sending a message.");
	expect(element.textContent).not.toContain("Main fallback text");
	expect(element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(true);
	await publish({ host: host("tsp", { available: false, reason: "Close the open omp menu before sending a message." }) });
	expect(element.querySelector('[role="status"]')?.textContent).toBe("Close the open omp menu before sending a message.");
	await publish({ host: host("classic", { available: false, reason: "Main fallback text", reasonCode: "matched-question" }) });
	expect(element.querySelector('[role="status"]')).toBeNull();
	expect(element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(false);
});


it("leaves the side-question explanation and Done action to the chat layer", async () => {
	const original = window.vomp.invoke;
	const invoke = vi.fn(async (_channel: string) => []);
	window.vomp.invoke = invoke as typeof window.vomp.invoke;
	try {
		view = { ...view, host: { ...host("tsp", { available: false, reason: "Put away the side question to send a message.", reasonCode: "btw" }), tspEpoch: 7 } };
		await act(async () => root.render(createElement(TooltipProvider, null, createElement(Composer, { session }))));
		expect(element.querySelector('[role="status"]')).toBeNull();
		expect(element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(true);
		invoke.mockClear();
		await act(async () => element.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		expect(invoke.mock.calls.some(([channel]) => channel === "btw:close" || channel === "btw:list")).toBe(false);
		expect(session.send).not.toHaveBeenCalled();
		expect([...element.querySelectorAll("button")].some(button => button.textContent?.trim() === "Put away")).toBe(false);
		expect(useComposerDrafts.getState().drafts.availability).toBe("A message ready to send");
		expect(session.send).not.toHaveBeenCalled();
		await publish({ host: { ...view.host!, tspAvailability: { available: true, reason: null } } });
		expect(element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(false);
	} finally { window.vomp.invoke = original; }
});


it.each(["classic", "tsp"] as const)("offers Send message rather than Queue message for a live ask in %s", async transport => {
	const args = { questions: [{ id: "db", question: "Which database?", options: [{ label: "SQLite" }] }] };
	view = { ...view, working: true, host: host(transport, { available: false, reason: "Answer the question card before sending a message.", reasonCode: "ask-editor" }), guest: {
		phase: "live", endedReason: null, header: null, readOnly: false, entries: [], state: null, stream: null, streamDone: false, working: true,
		agents: [], progress: new Map(), lifecycle: new Map(), backgroundTools: new Map(), awaitingAsyncWork: false, notices: [], thinkingSelector: null, loading: null,
		uiRequest: { reqId: 7, kind: "select", title: "Which database?", options: ["SQLite", "Other (type your own)", "Chat about this"] },
		activeTools: new Map([["ask-1", { toolCallId: "ask-1", toolName: "ask", args, startedAt: 0 }]]),
	} };
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(Composer, { session }))));
	const button = element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
	expect(button?.disabled).toBe(false);
	expect(element.textContent).not.toContain("Queue message");
	expect(element.textContent).not.toContain("Answer the question card before sending a message.");
	expect(element.querySelector<HTMLTextAreaElement>("textarea")?.placeholder).not.toContain("Queue");
});

it("keeps the ask exception unavailable for a different blocking hook or without a live ask", async () => {
	const args = { questions: [{ id: "db", question: "Which database?", options: [{ label: "SQLite" }] }] };
	view = { ...view, working: true, host: host("tsp", { available: false, reason: "Blocking extension question", reasonCode: "matched-question", questionReqId: 8 }), guest: {
		phase: "live", endedReason: null, header: null, readOnly: false, entries: [], state: null, stream: null, streamDone: false, working: true,
		agents: [], progress: new Map(), lifecycle: new Map(), backgroundTools: new Map(), awaitingAsyncWork: false, notices: [], thinkingSelector: null, loading: null,
		uiRequest: { reqId: 7, kind: "select", title: "Which database?", options: ["SQLite", "Other (type your own)", "Chat about this"] },
		activeTools: new Map([["ask-1", { toolCallId: "ask-1", toolName: "ask", args, startedAt: 0 }]]),
	} };
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(Composer, { session }))));
	expect(element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(true);
	expect(element.querySelector('[role="status"]')?.textContent).toBe("Answer the question card before sending a message.");
	view = { ...view, working: false, host: host("tsp", { available: false, reason: "Rich ask owns dock", reasonCode: "ask-editor" }), guest: {
		...view.guest!, working: false, activeTools: new Map(),
	} };
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(Composer, { session }))));
	expect(element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(true);
});

it("restores a rejected submitted draft with its attachments when the composer is still empty", async () => {
	const pending = Promise.withResolvers<void>();
	vi.mocked(session.send).mockReturnValueOnce(pending.promise);
	const image = { path: "/tmp/failed.png", name: "failed.png" };
	useComposerDrafts.getState().addAttachments("availability", [image]);
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(Composer, { session }))));
	await act(async () => element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.click());
	expect(useComposerDrafts.getState().drafts.availability).toBe("");
	expect(useComposerDrafts.getState().attachments.availability).toEqual([]);
	await act(async () => pending.reject(new Error("Disconnected before send")));
	expect(useComposerDrafts.getState().drafts.availability).toBe("A message ready to send");
	expect(useComposerDrafts.getState().attachments.availability).toEqual([image]);
	expect(session.preserveFailedMessage).not.toHaveBeenCalled();
});

it("preserves a failed message separately when a newer draft and attachments were entered during its send", async () => {
	const pending = Promise.withResolvers<void>();
	vi.mocked(session.send).mockReturnValueOnce(pending.promise);
	const failedImage = { path: "/tmp/failed.png", name: "failed.png" };
	const newerImage = { path: "/tmp/newer.png", name: "newer.png" };
	useComposerDrafts.getState().addAttachments("availability", [failedImage]);
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(Composer, { session }))));
	await act(async () => element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.click());
	await act(async () => {
		const store = useComposerDrafts.getState();
		store.setDraft("availability", "My newer draft");
		store.addAttachments("availability", [newerImage]);
		store.setMode("availability", "shell");
	});
	await act(async () => pending.reject(new Error("Disconnected before send")));
	const store = useComposerDrafts.getState();
	expect(store.drafts.availability).toBe("My newer draft");
	expect(store.attachments.availability).toEqual([newerImage]);
	expect(store.modes.availability).toBe("shell");
	expect(session.preserveFailedMessage).toHaveBeenCalledExactlyOnceWith("A message ready to send", [failedImage]);
	expect(session.send).toHaveBeenCalledTimes(1);
});

it.each([["a message", "A message ready to send"], ["an app command", "/plan"]])("gives %s back without an error when resuming the chat is declined", async (_kind, text) => {
	vi.mocked(toast).mockClear();
	useComposerDrafts.getState().setDraft("availability", text);
	vi.mocked(session.send).mockRejectedValueOnce(new ResumeDeclinedError());
	vi.mocked(routeSlash).mockRejectedValueOnce(new ResumeDeclinedError());
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(Composer, { session }))));
	await act(async () => element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.click());
	expect(useComposerDrafts.getState().drafts.availability).toBe(text);
	expect(session.preserveFailedMessage).not.toHaveBeenCalled();
	expect(toast).not.toHaveBeenCalled();
});

it("keeps a newer draft and queues the declined message without an error", async () => {
	vi.mocked(toast).mockClear();
	const pending = Promise.withResolvers<void>();
	vi.mocked(session.send).mockReturnValueOnce(pending.promise);
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(Composer, { session }))));
	await act(async () => element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.click());
	await act(async () => useComposerDrafts.getState().setDraft("availability", "My newer draft"));
	await act(async () => pending.reject(new ResumeDeclinedError()));
	expect(useComposerDrafts.getState().drafts.availability).toBe("My newer draft");
	expect(session.preserveFailedMessage).toHaveBeenCalledExactlyOnceWith("A message ready to send", []);
	expect(toast).not.toHaveBeenCalled();
});

it("completes model efforts with Tab without sending, then preserves the selected tag on send", async () => {
	const original = window.vomp.invoke;
	window.vomp.invoke = vi.fn(async () => ({ items: [{ value: "fixture/reasoner:high", description: "Fixture reasoner · high" }], keywords: [] })) as typeof window.vomp.invoke;
	try {
		view = { ...view, host: host("classic", { available: true, reason: null }) };
		useComposerDrafts.getState().setDraft("availability", "use ^fixture/reasoner:h");
		await act(async () => root.render(createElement(TooltipProvider, null, createElement(Composer, { session }))));
		const editor = element.querySelector("textarea")!;
		await act(async () => { editor.setSelectionRange(editor.value.length, editor.value.length); editor.focus(); });
		await vi.waitFor(async () => { await act(async () => {}); expect(element.querySelector('[role="option"]')?.textContent).toContain("^fixture/reasoner:high"); });
		await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
		expect(useComposerDrafts.getState().drafts.availability).toBe("use ^fixture/reasoner:high ");
		expect(session.send).not.toHaveBeenCalled();
		await act(async () => useComposerDrafts.getState().setDraft("availability", "use ^fixture/reasoner:high and chillax"));
		await act(async () => { editor.blur(); editor.setSelectionRange(editor.value.length, editor.value.length); editor.focus(); });
		await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		expect(session.send).toHaveBeenCalledExactlyOnceWith("use ^fixture/reasoner:high and chillax", []);
	} finally { window.vomp.invoke = original; }
});

it("keeps tags as ordinary editable text without a running omp", async () => {
	const original = window.vomp.invoke;
	const invoke = vi.fn(async (_channel: string) => []);
	window.vomp.invoke = invoke as typeof window.vomp.invoke;
	try {
		view = { ...view, mode: "history", host: null };
		useComposerDrafts.getState().setDraft("availability", "^fixture/reasoner:high chillax");
		await act(async () => root.render(createElement(TooltipProvider, null, createElement(Composer, { session }))));
		await act(async () => element.querySelector("textarea")!.focus());
		expect(element.querySelector('[role="listbox"]')).toBeNull();
		expect(invoke.mock.calls.some(([channel]) => channel === "composer:assist")).toBe(false);
		expect(element.querySelector("textarea")!.value).toBe("^fixture/reasoner:high chillax");
	} finally { window.vomp.invoke = original; }
});

it("keeps plain Enter from sending while model completion is awaiting omp", async () => {
	const original = window.vomp.invoke;
	const response = Promise.withResolvers<{ items: { value: string; description: string }[]; keywords: [] }>();
	let completionRequested = false;
	window.vomp.invoke = vi.fn(async (channel: string, _host: string, _generation: number, request: { complete?: boolean }) => {
		if (channel === "composer:assist" && request.complete) { completionRequested = true; return response.promise; }
		return { items: null, keywords: [] };
	}) as typeof window.vomp.invoke;
	try {
		view = { ...view, host: host("classic", { available: true, reason: null }) };
		useComposerDrafts.getState().setDraft("availability", "use ^fixture/reasoner:h");
		await act(async () => root.render(createElement(TooltipProvider, null, createElement(Composer, { session }))));
		const editor = element.querySelector("textarea")!;
		await act(async () => { editor.setSelectionRange(editor.value.length, editor.value.length); editor.focus(); });
		await vi.waitFor(() => expect(completionRequested).toBe(true));
		await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
		expect(session.send).not.toHaveBeenCalled();
		expect(editor.value).toBe("use ^fixture/reasoner:h");
		await act(async () => response.resolve({ items: [{ value: "fixture/reasoner:high", description: "High" }], keywords: [] }));
		await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
		expect(session.send).not.toHaveBeenCalled();
		expect(useComposerDrafts.getState().drafts.availability).toBe("use ^fixture/reasoner:high ");
	} finally { window.vomp.invoke = original; }
});
