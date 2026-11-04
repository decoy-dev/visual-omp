// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import type { SessionSummary } from "@shared/ipc";
import type { SessionController } from "../state/session";
import "../i18n";
import { ChangeChatIconDialog } from "./ChangeChatIconDialog";

const fake = vi.hoisted(() => ({ invoke: vi.fn(), runCommand: vi.fn(), loadSessions: vi.fn(), loadHistory: vi.fn(), tabs: [{ id: "tab", sessionFile: "/project/chat.jsonl", title: "Original" }] }));
vi.mock("../features/session-tools/drive", () => ({ runCommand: fake.runCommand }));
vi.mock("../state/app", () => ({
	controllerFor: () => ({ loadHistory: fake.loadHistory }),
	useApp: { getState: () => ({ tabs: fake.tabs, loadSessions: fake.loadSessions }), setState: (update: (state: { tabs: typeof fake.tabs }) => { tabs: typeof fake.tabs }) => { fake.tabs = update({ tabs: fake.tabs }).tabs; } },
}));
const saved: SessionSummary = { id: "session", file: "/project/chat.jsonl", cwd: "/project", title: "Original", createdAt: 1, updatedAt: 2, parentSession: null, preview: null, archived: false };
let root: Root;
let element: HTMLDivElement;
let close: Mock;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	Object.assign(window, { vomp: { invoke: fake.invoke } });
	fake.invoke.mockReset().mockImplementation(async (channel: string, _file?: string, title?: string) => channel === "app:emojiPanelSupported" ? true : channel === "sessions:rename" ? { title, file: saved.file, id: saved.id, movedFrom: null } : undefined);
	fake.runCommand.mockReset().mockResolvedValue({ output: ["Session renamed to \"🗄️ PREV: Build live previews\"."], screen: [], status: "success" });
	fake.loadSessions.mockReset().mockResolvedValue(undefined);
	fake.loadHistory.mockReset().mockResolvedValue(undefined);
	fake.tabs = [{ id: "tab", sessionFile: saved.file, title: "Original" }];
	close = vi.fn();
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label)!;
const field = (label: string) => { const node = [...document.querySelectorAll("label")].find(node => node.textContent === label)!; return document.getElementById(node.htmlFor) as HTMLInputElement; };
async function fill(label: string, value: string) {
	await act(async () => {
		const input = field(label);
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
it("preserves a card's code and title while sending its normalized emoji through the live rename path", async () => {
	const live = {} as SessionController;
	await act(async () => root.render(createElement(ChangeChatIconDialog, { title: "\u{F0208} PREV: Build live previews", live, session: saved, close })));
	expect(document.body.textContent).toContain("This chat uses a terminal icon that visual-omp cannot draw.");
	expect(document.querySelectorAll("input")).toHaveLength(1);
	expect(button("Save icon").disabled).toBe(true);
	await fill("Emoji", "🗄");
	expect(document.querySelector('[aria-label="Chat title preview"]')?.textContent).toContain("🗄️");
	await act(async () => button("Save icon").click());
	expect(fake.runCommand).toHaveBeenCalledWith(live, "/rename 🗄️ PREV: Build live previews", expect.any(Object));
	expect(fake.invoke).not.toHaveBeenCalledWith("sessions:rename", expect.anything(), expect.anything());
	expect(close).toHaveBeenCalledOnce();
});
it("requires an emoji and code for a plain title, renames the saved chat and refreshes its views", async () => {
	await act(async () => root.render(createElement(ChangeChatIconDialog, { title: "Build live previews", live: null, session: saved, close })));
	await fill("Emoji", "A"); await fill("Chat code", "PREV");
	expect(button("Save icon").disabled).toBe(true);
	await fill("Emoji", "👩🏽‍💻"); await fill("Chat code", "A_B");
	expect(button("Save icon").disabled).toBe(true);
	await fill("Chat code", "prev");
	expect(field("Chat code").value).toBe("PREV");
	expect(button("Save icon").disabled).toBe(false);
	await act(async () => button("Save icon").click());
	expect(fake.invoke).toHaveBeenCalledWith("sessions:rename", saved.file, "👩🏽‍💻 PREV: Build live previews");
	expect(fake.runCommand).not.toHaveBeenCalled();
	expect(fake.tabs[0].title).toBe("👩🏽‍💻 PREV: Build live previews");
	expect(fake.loadHistory).toHaveBeenCalledOnce();
	expect(fake.loadSessions).toHaveBeenCalledWith(saved.cwd);
	expect(close).toHaveBeenCalledOnce();
});
it("focuses the emoji field before opening the supported system picker", async () => {
	await act(async () => root.render(createElement(ChangeChatIconDialog, { title: "🧪 PREV: Build previews", live: null, session: saved, close })));
	await act(async () => button("Choose emoji").click());
	expect(document.activeElement).toBe(field("Emoji"));
	expect(fake.invoke).toHaveBeenCalledWith("app:showEmojiPanel");
});
it("hides an unsupported picker and keeps a failed change available for correction", async () => {
	fake.invoke.mockImplementation(async (channel: string) => { if (channel === "app:emojiPanelSupported") return false; throw new Error("The saved chat is running in omp."); });
	await act(async () => root.render(createElement(ChangeChatIconDialog, { title: "🧪 PREV: Build previews", live: null, session: saved, close })));
	expect(button("Choose emoji")).toBeUndefined();
	await fill("Emoji", "🗄️");
	await act(async () => button("Save icon").click());
	expect(document.querySelector('[role="alert"]')?.textContent).toBe("The saved chat is running in omp.");
	expect(field("Emoji").value).toBe("🗄️");
	expect(close).not.toHaveBeenCalled();
});
it("keeps a live error in the dialog without updating the saved file", async () => {
	fake.runCommand.mockResolvedValue({ output: ["Rename refused"], screen: [], status: "error" });
	await act(async () => root.render(createElement(ChangeChatIconDialog, { title: "🧪 PREV: Build previews", live: {} as SessionController, session: saved, close })));
	await act(async () => button("Save icon").click());
	expect(document.querySelector('[role="alert"]')?.textContent).toBe("Rename refused");
	expect(close).not.toHaveBeenCalled();
});

it("accepts recognized classic rename success without a semantic status", async () => {
	fake.runCommand.mockResolvedValue({ output: ["Session renamed to \"🧪 PREV: Build previews\"."], screen: [] });
	await act(async () => root.render(createElement(ChangeChatIconDialog, { title: "🧪 PREV: Build previews", live: {} as SessionController, session: saved, close })));
	await act(async () => button("Save icon").click());
	expect(close).toHaveBeenCalledOnce();
});
it.each([
	["Rename failed: The session file could not be saved.", "Rename failed: The session file could not be saved."],
	["Another command finished.", "omp did not confirm the icon change."],
	["", "omp did not confirm the icon change."],
])("keeps unsuccessful classic output in the dialog: %s", async (output, expected) => {
	fake.runCommand.mockResolvedValue({ output: output ? [output] : [], screen: [] });
	await act(async () => root.render(createElement(ChangeChatIconDialog, { title: "🧪 PREV: Build previews", live: {} as SessionController, session: saved, close })));
	await act(async () => button("Save icon").click());
	expect(document.querySelector('[role="alert"]')?.textContent).toContain(expected);
	if (output) expect(document.querySelector('[role="alert"]')?.textContent).toContain(output);
	expect(close).not.toHaveBeenCalled();
});

/** happy-dom omits implicit keyboard submission, so perform that browser default through the associated submit button. */
async function pressEnter(label: string, isComposing = false) {
	await act(async () => {
		const input = field(label);
		input.focus();
		const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing });
		input.dispatchEvent(event);
		if (!event.defaultPrevented) {
			const submitter = [...document.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].find(node => node.form === input.form);
			submitter?.click();
		}
	});
}
it("submits a card title from Emoji with Enter while preserving IME composition", async () => {
	await act(async () => root.render(createElement(ChangeChatIconDialog, { title: "🧪 PREV: Build previews", live: {} as SessionController, session: saved, close })));
	await pressEnter("Emoji", true);
	expect(fake.runCommand).not.toHaveBeenCalled();
	await pressEnter("Emoji");
	expect(fake.runCommand).toHaveBeenCalledWith(expect.anything(), "/rename 🧪 PREV: Build previews", expect.any(Object));
	expect(close).toHaveBeenCalledOnce();
});
it("submits a plain title from Chat code with Enter while preserving IME composition", async () => {
	await act(async () => root.render(createElement(ChangeChatIconDialog, { title: "Build previews", live: null, session: saved, close })));
	await fill("Emoji", "🧪");
	await fill("Chat code", "PREV");
	await pressEnter("Chat code", true);
	expect(fake.invoke.mock.calls.some(call => call[0] === "sessions:rename")).toBe(false);
	await pressEnter("Chat code");
	expect(fake.invoke).toHaveBeenCalledWith("sessions:rename", saved.file, "🧪 PREV: Build previews");
	expect(close).toHaveBeenCalledOnce();
});
it.each(["#️⃣", "👩🏻‍❤️‍💋‍👨🏿"])("explains a rejected edited emoji beside its field: %s", async emoji => {
	await act(async () => root.render(createElement(ChangeChatIconDialog, { title: "🧪 PREV: Build previews", live: null, session: saved, close })));
	expect(field("Emoji").getAttribute("aria-invalid")).toBeNull();
	await fill("Emoji", emoji);
	const input = field("Emoji");
	expect(input.getAttribute("aria-invalid")).toBe("true");
	const described = input.getAttribute("aria-describedby")!.split(" ").map(id => document.getElementById(id)?.textContent).join(" ");
	expect(described).toContain("omp cannot use this emoji.");
	expect(button("Save icon").disabled).toBe(true);
	await fill("Emoji", "🗄");
	expect(input.getAttribute("aria-invalid")).toBeNull();
	expect(button("Save icon").disabled).toBe(false);
});
