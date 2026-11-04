// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionController, SessionView } from "../../state/session";
import { TooltipProvider } from "../../ui/Tooltip";
import { Composer } from "../../chat/composer/Composer";
import { useComposerDrafts } from "../../chat/composer/drafts";
import { cancelPreviewRedirect, stopAndRedirect } from "./redirect";
import "../../i18n";

vi.hoisted(() => {
	Object.assign(window, { vomp: { platform: "darwin", invoke: async () => [], on: () => () => {} } });
	Reflect.deleteProperty(Element.prototype, "animate");
});
vi.mock("../../state/app", () => ({ useApp: (select: (state: unknown) => unknown) => select({ prefs: { voiceInput: false }, btwDrawers: {} }) }));
vi.mock("../session-tools/slash", () => ({ routeSlash: vi.fn() }));
vi.mock("../session-tools/typed", () => ({ sendSlashCommand: vi.fn() }));
vi.mock("../../registry/slots", () => ({ chatSlots: { use: () => [] } }));
vi.mock("../../chat/branch", () => ({ useDisplayedEntries: () => [] }));
vi.mock("../../chat/composer/attach", () => ({ attachFiles: vi.fn(), attachPaths: vi.fn(), useThumbnail: () => null }));
vi.mock("../../chat/composer/MentionPicker", () => ({ MentionPicker: () => null, useProjectFiles: () => null }));
vi.mock("../../chat/composer/SlashMenu", () => ({ SlashMenu: () => null, useSlashCommands: () => [], slashOptions: () => null, slashAtCaret: () => null }));
vi.mock("../../chat/composer/PromptLibrary", () => ({ PromptLibrary: () => null }));
vi.mock("../../chat/composer/QueueTray", () => ({ QueueTray: () => null }));
vi.mock("../../chat/composer/VoiceTool", () => ({ VoiceTool: () => null, useVoiceRequests: { getState: () => ({ requestStart: vi.fn() }) } }));
vi.mock("../../chat/composer/predictions", () => ({ useGhostText: () => ({ suffix: "" }), ghostSourceUnchanged: () => true }));
vi.mock("../../chat/composer/tools", () => ({ QUICK_MODES: [] }));
vi.mock("../../chat/composer/PredictionRecovery", () => ({ PredictionRecovery: () => null, acknowledgePrediction: vi.fn(), usePredictionCaptures: { getState: () => ({ merge: vi.fn() }) } }));

let element: HTMLDivElement;
let root: Root;
let view: SessionView;
let held: boolean;
let listeners: Set<() => void>;
let session: SessionController;
let fonts: PropertyDescriptor | undefined;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	fonts = Object.getOwnPropertyDescriptor(document, "fonts");
	Object.defineProperty(document, "fonts", { configurable: true, value: new EventTarget() });
	view = { mode: "live", readOnly: false, working: true, workingSince: Date.now(), guest: null, history: null, inputHistory: [], queue: [], strandedImages: false, host: null, follow: null, ownerUnverified: false, displayLeaf: null, carryover: null, error: null };
	held = false; listeners = new Set();
	session = { tabId: "redirect", projectPath: "/project", subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getSnapshot: () => view,
		abort: vi.fn(), send: vi.fn(async () => {}), holdQueue: (promise: Promise<unknown>) => { held = true; void promise.then(() => { held = false; }); }, preserveFailedMessage: vi.fn(),
	} as unknown as SessionController;
	useComposerDrafts.getState().setDraft("redirect", "Keep these words");
	useComposerDrafts.getState().addAttachments("redirect", [{ path: "/image.png", name: "image.png" }]);
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
	await act(async () => { cancelPreviewRedirect("redirect"); root.unmount(); });
	useComposerDrafts.getState().forget("redirect"); element.remove();
	if (fonts) Object.defineProperty(document, "fonts", fonts); else Reflect.deleteProperty(document, "fonts");
});
it.each(["send", "Escape"])("releases a correction hold when the mounted composer receives %s", async action => {
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(Composer, { session }))));
	await act(async () => stopAndRedirect(session, "poster.svg", name => `About ${name}: `));
	expect(held).toBe(true);
	await act(async () => { view = { ...view, working: false }; for (const listener of [...listeners]) listener(); });
	const textarea = element.querySelector("textarea")!;
	expect(textarea.value).toBe("About poster.svg: Keep these words"); expect(document.activeElement).toBe(textarea);
	expect(useComposerDrafts.getState().attachments.redirect).toEqual([{ path: "/image.png", name: "image.png" }]);
	expect(held).toBe(true);
	await act(async () => {
		if (action === "send") element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.click();
		else textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	});
	expect(held).toBe(false);
	if (action === "send") expect(session.send).toHaveBeenCalledWith("About poster.svg: Keep these words", [{ path: "/image.png", name: "image.png" }]);
	else expect(textarea.value).toBe("About poster.svg: Keep these words");
});
