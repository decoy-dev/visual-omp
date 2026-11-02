// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostState } from "@shared/ipc";
import type { SessionController, SessionView } from "../../state/session";
import { TooltipProvider } from "../../ui/Tooltip";
import { useComposerDrafts } from "./drafts";
import { Composer } from "./Composer";
import "../../i18n";

vi.hoisted(() => {
	Object.assign(window, { vomp: { platform: "darwin", invoke: async () => [], on: () => () => {} } });
	// Exercise Motion's JS fallback: happy-dom's cancelled WAAPI promises reject during draft transitions.
	Reflect.deleteProperty(Element.prototype, "animate");
});
vi.mock("../../state/app", () => ({ useApp: (select: (state: { prefs: { voiceInput: boolean } }) => unknown) => select({ prefs: { voiceInput: false } }) }));
vi.mock("../../features/session-tools/slash", () => ({ routeSlash: vi.fn() }));
vi.mock("../../features/session-tools/typed", () => ({ sendSlashCommand: vi.fn() }));
vi.mock("../../registry/slots", () => ({ chatSlots: { use: () => [] } }));
vi.mock("../branch", () => ({ useDisplayedEntries: () => [] }));
vi.mock("./attach", () => ({ attachFiles: vi.fn(), attachPaths: vi.fn(), useThumbnail: () => null }));
vi.mock("./MentionPicker", () => ({ MentionPicker: () => null, useProjectFiles: () => null }));
vi.mock("./SlashMenu", () => ({ SlashMenu: () => null, useSlashCommands: () => [], slashOptions: () => null, slashAtCaret: () => null }));
vi.mock("./PromptLibrary", () => ({ PromptLibrary: () => null }));
vi.mock("./QueueTray", () => ({ QueueTray: () => null }));
vi.mock("./VoiceTool", () => ({ VoiceTool: () => null, useVoiceRequests: { getState: () => ({ requestStart: vi.fn() }) } }));
vi.mock("./predictions", () => ({ useGhostText: () => ({ suffix: "" }), ghostSourceUnchanged: () => true }));
vi.mock("./tools", () => ({ QUICK_MODES: [] }));
vi.mock("./PredictionRecovery", () => ({ PredictionRecovery: () => null, acknowledgePrediction: vi.fn(), usePredictionCaptures: { getState: () => ({ merge: vi.fn() }) } }));

let root: Root; let element: HTMLDivElement; let view: SessionView;
let fontsDescriptor: PropertyDescriptor | undefined;
// These tests mount Composer itself; only unrelated data sources and auxiliary tools are replaced.
const session = { tabId: "availability", projectPath: "/tmp", subscribe: () => () => {}, getSnapshot: () => view, send: vi.fn(), steer: vi.fn(), preserveFailedMessage: vi.fn() } as unknown as SessionController;
const host = (transport: HostState["transport"], tspAvailability: HostState["tspAvailability"]): HostState => ({ hostId: "host", generation: 1, transport, tspAvailability }) as HostState;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.mocked(session.send).mockReset().mockResolvedValue(undefined);
	vi.mocked(session.preserveFailedMessage).mockReset();
	// happy-dom omits FontFaceSet; Composer only subscribes to its loadingdone event here.
	fontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");
	Object.defineProperty(document, "fonts", { configurable: true, value: new EventTarget() });
	view = { mode: "live", readOnly: false, working: false, guest: null, history: null, inputHistory: [], queue: [], strandedImages: [], host: null } as unknown as SessionView;
	useComposerDrafts.getState().setDraft("availability", "A message ready to send");
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
	await act(async () => root.unmount()); useComposerDrafts.getState().forget("availability"); element.remove();
	if (fontsDescriptor) Object.defineProperty(document, "fonts", fontsDescriptor);
	else Reflect.deleteProperty(document, "fonts");
});
it("renders the matched question instruction and keeps ordinary menu and classic composer behavior distinct", async () => {
	const render = async () => { await act(async () => root.render(createElement(TooltipProvider, null, createElement(Composer, { session })))); };
	view = { ...view, host: host("tsp", { available: false, reason: "Main fallback text", reasonCode: "matched-question" }) };
	await render();
	expect(element.querySelector('[role="status"]')?.textContent).toBe("Answer the question card before sending a message.");
	expect(element.textContent).not.toContain("Main fallback text");
	expect(element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(true);
	view = { ...view, host: host("tsp", { available: false, reason: "Close the open omp menu before sending a message." }) };
	await render();
	expect(element.querySelector('[role="status"]')?.textContent).toBe("Close the open omp menu before sending a message.");
	view = { ...view, host: host("classic", { available: false, reason: "Main fallback text", reasonCode: "matched-question" }) };
	await render();
	expect(element.querySelector('[role="status"]')).toBeNull();
	expect(element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(false);
});

it.each(["classic", "tsp"] as const)("offers Send message rather than Queue message for a live ask in %s", async transport => {
	const args = { questions: [{ id: "db", question: "Which database?", options: [{ label: "SQLite" }] }] };
	view = { ...view, working: true, host: host(transport, { available: false, reason: "Answer the question card before sending a message.", reasonCode: "ask-editor" }), guest: {
		phase: "live", readOnly: false, entries: [], stream: null, working: true,
		uiRequest: { reqId: 7, kind: "select", title: "Which database?", options: ["SQLite", "Other (type your own)", "Chat about this"] },
		activeTools: new Map([["ask-1", { toolCallId: "ask-1", toolName: "ask", args, startedAt: 0 }]]),
	} as unknown as SessionView["guest"] };
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
		phase: "live", readOnly: false, entries: [], stream: null, working: true,
		uiRequest: { reqId: 7, kind: "select", title: "Which database?", options: ["SQLite", "Other (type your own)", "Chat about this"] },
		activeTools: new Map([["ask-1", { toolCallId: "ask-1", toolName: "ask", args, startedAt: 0 }]]),
	} as unknown as SessionView["guest"] };
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
