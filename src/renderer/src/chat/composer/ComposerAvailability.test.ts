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

vi.hoisted(() => { Object.assign(window, { vomp: { platform: "darwin", invoke: async () => [], on: () => () => {} } }); });
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
const session = { tabId: "availability", projectPath: "/tmp", subscribe: () => () => {}, getSnapshot: () => view } as unknown as SessionController;
const host = (transport: HostState["transport"], tspAvailability: HostState["tspAvailability"]): HostState => ({ hostId: "host", generation: 1, transport, tspAvailability }) as HostState;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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
