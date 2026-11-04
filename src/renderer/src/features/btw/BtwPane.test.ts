// @vitest-environment happy-dom
import { act, createElement, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BtwState } from "@shared/contracts/btw";
import type { SessionController, SessionView } from "../../state/session";
import "../../i18n";
import { routeSlash } from "../session-tools/slash";
import { TooltipProvider } from "../../ui";
import { BtwDrawerContent, BtwDrawer, BtwPane } from "./BtwPane";
import { BtwPaneContent } from "./BtwPaneContent";
import { PresentationVisibility, presentationClaims } from "../../state/tsp/presentation-claims";
import { useApp } from "../../state/app";

vi.hoisted(() => { Object.assign(window, { vomp: { platform: "darwin", on: () => () => {}, invoke: async () => undefined } }); });
vi.mock("../session-tools/typed", () => ({ sendSlashCommand: vi.fn() }));
vi.mock("../session-tools/drive", () => ({ reportFailure: vi.fn() }));
vi.mock("../panes/common", async original => ({ ...await original<object>(), usePaneVisible: () => true }));
vi.mock("../../shell/Sidebar", () => ({ focusChatSearch: vi.fn() }));
vi.mock("../palette/run", () => ({ runCommand: vi.fn() }));
vi.mock("motion/react", () => {
	const tag = (name: string) => ({ children, initial, animate, exit, transition, layout, layoutId, variants, custom, ...props }: PropsWithChildren<Record<string, unknown>>) => createElement(name, props, children);
	return { AnimatePresence: ({ children }: PropsWithChildren) => children, MotionConfig: ({ children }: PropsWithChildren) => children, motion: { div: tag("div"), section: tag("section"), span: tag("span"), ul: tag("ul"), li: tag("li") }, useReducedMotionConfig: () => true };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mounted: { root: Root; container: HTMLElement }[] = [];
const listeners = new Map<string, Set<(event: unknown) => void>>();
const originalVomp = window.vomp;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const invoke = vi.fn();
beforeEach(async () => {
	await BtwDrawerContent.preload();
	invoke.mockReset();
	listeners.clear();
	useApp.setState({ btwDrawers: { "btw-slash": true, "btw-race": true, "btw-test": true } });
	// The shared TSP document read is not part of these side-question exchanges: no documents.
	const bridgeInvoke = (channel: string, ...args: unknown[]) => channel === "host:tsp-snapshot" ? Promise.resolve(null) : invoke(channel, ...args);
	window.vomp = { platform: "darwin", invoke: bridgeInvoke, on: (channel: string, listener: (event: unknown) => void) => {
		let set = listeners.get(channel); if (!set) listeners.set(channel, set = new Set());
		set.add(listener); return () => set!.delete(listener);
	} } as unknown as typeof window.vomp;
});
afterEach(async () => {
	for (const { root, container } of mounted.splice(0)) { await act(async () => root.unmount()); container.remove(); }
	window.vomp = originalVomp;
	if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
	else Reflect.deleteProperty(navigator, "clipboard");
	useApp.setState({ btwDrawers: {} });
});
const initial = (): BtwState => ({ hostId: "host", generation: 1, epoch: 1, revision: 1,
	topics: [{ id: "topic", title: "Why is the change small?", live: true, turns: [{ question: "Why is the change small?", answer: "The first answer.", status: "complete", createdAt: 1793723247397, updatedAt: 1793723247415 }] }],
	overlay: { epoch: 1, surfaceId: "s", nodeId: "btw", selectedTopic: { id: "topic" }, topics: [{ id: "topic" }], actions: ["close", "copy-answer", "follow-up"], followUp: false, supported: true, notice: null, draft: null } });
// Plain-text mounts and input commit synchronously; await IPC completion separately.
function mountContent(state = initial(), historyOnly = false) {
	const container = document.createElement("div"); document.body.append(container);
	const root = createRoot(container); mounted.push({ root, container });
	const render = (next: BtwState) => { act(() => root.render(createElement(TooltipProvider, null, createElement(BtwPaneContent, { state: next, error: null, hostId: next.hostId, historyOnly, presentation: { active: !historyOnly, available: true } })))); };
	render(state);
	return { container, render };
}
function button(container: HTMLElement, label: string) {
	const match = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === label);
	expect(match, label).toBeDefined(); return match!;
}
function fill(container: HTMLElement, text: string) {
	const input = container.querySelector("textarea")!;
	act(() => {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));
	});
	return input;
}
async function chooseHistory(container: HTMLElement, title: string) {
	const trigger = [...container.querySelectorAll("button")].find(button => button.textContent?.startsWith("History ("))!;
	await act(async () => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse", ctrlKey: false })); });
	const choice = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(row => row.textContent?.includes(title));
	expect(choice, title).toBeDefined();
	await act(async () => choice!.click());
}
function secondTopic(state: BtwState, scope?: string) {
	const topic = structuredClone(state.topics[0]!);
	topic.id = scope ? topic.id : "second";
	topic.scope = scope;
	topic.title = scope ? "Helper question" : "Second question";
	topic.turns[0]!.answer = scope ? "Helper answer" : "Second answer";
	state.topics.push(topic);
	state.overlay!.topics.push({ id: topic.id, ...(scope ? { scope } : {}) });
	return topic;
}

describe("native side-question pane", () => {
	it("consumes only the submitted draft when its own ask opens a new native topic", async () => {
		const pending = Promise.withResolvers<void>(); invoke.mockReturnValue(pending.promise);
		const empty = initial(); empty.topics = []; empty.overlay = null;
		const h = mountContent(empty);
		fill(h.container, "The question being submitted");
		act(() => button(h.container, "Ask question").click());
		expect(invoke).toHaveBeenCalledExactlyOnceWith("btw:ask", "host", "The question being submitted", { generation: 1, epoch: 1 });
		const next = initial(); next.topics[0]!.title = "The question being submitted"; next.topics[0]!.turns[0]!.question = "The question being submitted";
		next.topics[0]!.turns[0]!.status = "running"; next.topics[0]!.turns[0]!.answer = "The new native answer"; next.overlay!.actions = ["close", "stop"];
		h.render(next);
		expect(h.container.querySelector("details")?.textContent).toContain("The question being submitted");
		expect(button(h.container, "Stop side answer").disabled).toBe(true);
		await act(async () => pending.resolve());
		expect(h.container.querySelector("details")).toBeNull();
		expect(h.container.textContent).toContain("The new native answer");
		expect(button(h.container, "Stop side answer").disabled).toBe(false);
	});
	it("streams every update and leaves an unchanged running answer marked Answering", async () => {
		const state = initial(); state.topics[0]!.turns[0]!.status = "running"; state.topics[0]!.turns[0]!.answer = "First fragment";
		state.overlay!.actions = ["close", "stop"];
		const h = mountContent(state);
		expect(h.container.textContent).toContain("First fragment");
		expect(h.container.querySelector('[role="status"]')?.textContent).toContain("Answering");
		const next = structuredClone(state); next.revision++; next.topics[0]!.turns[0]!.answer += " and the next fragment.";
		h.render(next);
		expect(h.container.textContent).toContain("First fragment and the next fragment.");
		expect(h.container.textContent).toContain("Answering");
		expect(button(h.container, "Stop side answer").disabled).toBe(false);
		expect([...h.container.querySelectorAll("button")].some(button => /delete/i.test(button.textContent ?? ""))).toBe(false);
	});

	it("preserves a failed follow-up draft and sends the selected topic on retry", async () => {
		const h = mountContent();
		await act(async () => button(h.container, "Follow up").click());
		const input = fill(h.container, "Explain the smaller change.\nKeep Unicode: café ✓");
		invoke.mockRejectedValueOnce(new Error("The side question is unavailable. Try again."));
		await act(async () => button(h.container, "Send follow-up").click());
		expect(h.container.querySelector('[role="alert"]')?.textContent).toContain("Try again");
		expect(input.value).toBe("Explain the smaller change.\nKeep Unicode: café ✓");
		invoke.mockResolvedValueOnce(undefined);
		await act(async () => button(h.container, "Send follow-up").click());
		expect(invoke).toHaveBeenLastCalledWith("btw:followUp", "host", { id: "topic" }, "Explain the smaller change.\nKeep Unicode: café ✓", { generation: 1, epoch: 1 });
		expect(h.container.querySelector("textarea")).toBeNull();
	});

	it("keeps Stop side answer in the content and reserves Done for the drawer header", async () => {
		const state = initial(); state.topics[0]!.turns[0]!.status = "running"; state.overlay!.actions = ["close", "stop"];
		state.topics[0]!.scope = "main"; state.overlay!.selectedTopic = { id: "topic", scope: "main" }; state.overlay!.topics = [{ id: "topic", scope: "main" }];
		const h = mountContent(state); invoke.mockResolvedValue(undefined);
		expect(h.container.textContent).not.toContain("Put away");
		expect([...h.container.querySelectorAll("button")].some(button => button.textContent?.trim() === "Done")).toBe(false);
		await act(async () => button(h.container, "Stop side answer").click());
		expect(invoke).toHaveBeenLastCalledWith("btw:stop", "host", { id: "topic", scope: "main" }, { generation: 1, epoch: 1 });
		expect(invoke.mock.calls.every(([channel]) => channel !== "host:keys" && channel !== "host:tsp-event")).toBe(true);
	});

	it("shows steering content but offers injection only when omp declares the action", async () => {
		const state = initial(); state.topics[0]!.turns[0]!.answer = "Useful context.\n\n<inject>\nKeep the change small.\n</inject>";
		state.topics[0]!.turns[0]!.inject = { text: "Keep the change small.", sent: false };
		const h = mountContent(state);
		expect(h.container.textContent).toContain("Steering prompt for the main chat");
		expect(h.container.textContent).toContain("Keep the change small.");
		expect([...h.container.querySelectorAll("button")].some(button => button.textContent === "Inject into main")).toBe(false);
		expect(h.container.textContent).toContain("Side answers are separate.");
		expect(h.container.textContent).not.toContain("Inject into main sends");
		const next = structuredClone(state); next.overlay!.actions.push("inject"); next.revision++;
		h.render(next); invoke.mockResolvedValue(undefined);
		expect(h.container.textContent).toContain("Side answers are separate. Inject into main sends the steering prompt to the main chat.");
		await act(async () => button(h.container, "Inject into main").click());
		expect(invoke).toHaveBeenLastCalledWith("btw:inject", "host", { id: "topic" }, { generation: 1, epoch: 1 });
	});

	it("presents a native follow-up field left open by omp and keeps its draft", async () => {
		const state = initial(); state.overlay!.followUp = true; state.overlay!.draft = "Recovered side draft"; state.overlay!.actions = ["discard", "send"];
		const h = mountContent(state);
		expect(h.container.querySelector("textarea")?.value).toBe("Recovered side draft");
		expect(button(h.container, "Send follow-up").disabled).toBe(false);
	});

	it("keeps duplicate main and helper ids distinct and leaves helper history read-only", async () => {
		const state = initial();
		state.topics[0]!.scope = "main";
		state.overlay!.selectedTopic = { id: "topic", scope: "main" };
		state.overlay!.topics = [{ id: "topic", scope: "main" }];
		secondTopic(state, "helper");
		state.overlay!.topics.pop();
		state.overlay!.actions.push("inject", "stop");
		const clipboard = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
		const h = mountContent(state);
		expect(h.container.textContent).toContain("The first answer.");
		await chooseHistory(h.container, "Helper question");
		expect(h.container.textContent).toContain("Helper answer");
		expect(h.container.textContent).not.toContain("The first answer.");
		expect(invoke).not.toHaveBeenCalled();
		expect(presentationClaims.getSnapshot()).toEqual([]);
		for (const label of ["Follow up", "Inject into main", "Stop side answer", "Put away"]) expect([...h.container.querySelectorAll("button")].some(button => button.textContent?.trim() === label)).toBe(false);
		await act(async () => button(h.container, "Copy answers").click());
		expect(clipboard).toHaveBeenCalledWith("Helper answer");
		await chooseHistory(h.container, "Why is the change small?");
		expect(invoke).toHaveBeenLastCalledWith("btw:select", "host", { id: "topic", scope: "main" }, { generation: 1, epoch: 1 });
		expect(h.container.textContent).toContain("The first answer.");
		await act(async () => button(h.container, "Inject into main").click());
		expect(invoke).toHaveBeenLastCalledWith("btw:inject", "host", { id: "topic", scope: "main" }, { generation: 1, epoch: 1 });
		await act(async () => button(h.container, "Follow up").click());
		fill(h.container, "Scoped follow-up");
		await act(async () => button(h.container, "Send follow-up").click());
		expect(invoke).toHaveBeenLastCalledWith("btw:followUp", "host", { id: "topic", scope: "main" }, "Scoped follow-up", { generation: 1, epoch: 1 });
	});

	it("retains unsent drafts at their original topic across history selection", async () => {
		const state = initial(); secondTopic(state);
		const h = mountContent(state);
		await act(async () => button(h.container, "Follow up").click());
		fill(h.container, "Draft for the first topic");
		await chooseHistory(h.container, "Second question");
		expect(h.container.querySelector("textarea")).toBeNull();
		const second = structuredClone(state); second.revision++; second.overlay!.selectedTopic = { id: "second" };
		h.render(second);
		await act(async () => button(h.container, "Follow up").click());
		expect(h.container.querySelector("textarea")?.value).toBe("");
		fill(h.container, "Draft for the second topic");
		await chooseHistory(h.container, "Why is the change small?");
		h.render({ ...state, revision: 3 });
		await act(async () => button(h.container, "Follow up").click());
		expect(h.container.querySelector("textarea")?.value).toBe("Draft for the first topic");
	});

	it.each(["host", "generation", "epoch"] as const)("keeps %s replacements isolated from a pending completion and retains unsent replacement drafts", async field => {
		const original = initial();
		const oldOperation = Promise.withResolvers<void>();
		const newOperation = Promise.withResolvers<void>();
		invoke.mockReturnValueOnce(oldOperation.promise).mockReturnValueOnce(newOperation.promise);
		const h = mountContent(original);
		await act(async () => button(h.container, "Follow up").click());
		fill(h.container, "Original draft");
		await act(async () => button(h.container, "Send follow-up").click());
		const replacement = structuredClone(original);
		if (field === "host") replacement.hostId = "replacement-host";
		else if (field === "generation") replacement.generation = 2;
		else { replacement.epoch = 2; replacement.overlay!.epoch = 2; }
		h.render(replacement);
		expect(h.container.querySelector("textarea")).toBeNull();
		await act(async () => button(h.container, "Follow up").click());
		fill(h.container, "Replacement draft");
		expect(button(h.container, "Send follow-up").disabled).toBe(false);
		await act(async () => button(h.container, "Send follow-up").click());
		expect(invoke).toHaveBeenNthCalledWith(1, "btw:followUp", "host", { id: "topic" }, "Original draft", { generation: 1, epoch: 1 });
		expect(invoke).toHaveBeenNthCalledWith(2, "btw:followUp", replacement.hostId, { id: "topic" }, "Replacement draft", { generation: replacement.generation, epoch: replacement.epoch });
		await act(async () => oldOperation.resolve());
		expect(h.container.querySelector("textarea")?.value).toBe("Replacement draft");
		expect(button(h.container, "Send follow-up").disabled).toBe(true);
		await act(async () => newOperation.reject(new Error("Keep the replacement draft.")));
		expect(h.container.querySelector("textarea")?.value).toBe("Replacement draft");
		expect(button(h.container, "Send follow-up").disabled).toBe(false);
		h.render(original);
		h.render(replacement);
		expect(h.container.querySelector("textarea")?.value).toBe("Replacement draft");
		expect(h.container.querySelector('[role="alert"]')?.textContent).toContain("Keep the replacement draft.");
	});

	it("retains an unsent draft when the same host returns to its original epoch", async () => {
		const state = initial();
		const h = mountContent(state);
		await act(async () => button(h.container, "Follow up").click());
		fill(h.container, "Keep in epoch one");
		const next = structuredClone(state); next.epoch = 2; next.overlay!.epoch = 2;
		h.render(next);
		await act(async () => button(h.container, "Follow up").click());
		fill(h.container, "Keep in epoch two");
		h.render(state);
		expect(h.container.querySelector("textarea")?.value).toBe("Keep in epoch one");
		h.render(next);
		expect(h.container.querySelector("textarea")?.value).toBe("Keep in epoch two");
		expect(invoke).not.toHaveBeenCalled();
	});

	it("does not let a late completion clear the next topic's native draft or selection", async () => {
		const state = initial(); secondTopic(state);
		const pending = Promise.withResolvers<void>(); invoke.mockReturnValueOnce(pending.promise);
		const h = mountContent(state);
		await act(async () => button(h.container, "Follow up").click());
		fill(h.container, "First topic request");
		await act(async () => button(h.container, "Send follow-up").click());
		const next = structuredClone(state); next.revision++; next.overlay!.selectedTopic = { id: "second" }; next.overlay!.followUp = true; next.overlay!.draft = "Second topic native draft"; next.overlay!.actions = ["send", "discard"];
		h.render(next);
		expect(h.container.textContent).toContain("Second answer");
		expect(h.container.querySelector("textarea")?.value).toBe("Second topic native draft");
		expect(button(h.container, "Send follow-up").disabled).toBe(true);
		await act(async () => pending.resolve());
		expect(h.container.textContent).toContain("Second answer");
		expect(h.container.querySelector("textarea")?.value).toBe("Second topic native draft");
		expect(button(h.container, "Send follow-up").disabled).toBe(false);
		await act(async () => button(h.container, "Send follow-up").click());
		expect(invoke).toHaveBeenLastCalledWith("btw:followUp", "host", { id: "second" }, "Second topic native draft", { generation: 1, epoch: 1 });
	});

	it("synchronously guards duplicate submissions and blocks history mutations while busy", async () => {
		const pending = Promise.withResolvers<void>(); invoke.mockReturnValue(pending.promise);
		const state = initial(); secondTopic(state);
		const h = mountContent(state);
		await act(async () => button(h.container, "Follow up").click());
		fill(h.container, "Only once");
		await act(async () => {
			const form = h.container.querySelector("form")!;
			form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
			form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(button(h.container, "History (2)").disabled).toBe(true);
		expect(button(h.container, "New question").disabled).toBe(true);
		expect([...h.container.querySelectorAll("button")].some(button => button.textContent?.trim() === "Done")).toBe(false);
		expect(invoke).toHaveBeenCalledTimes(1);
		await act(async () => pending.resolve());
		expect(button(h.container, "History (2)").disabled).toBe(false);
	});

	it("reopens native history explicitly before offering durable topic mutations", async () => {
		const state = initial(); state.overlay = null;
		const h = mountContent(state);
		expect(h.container.textContent).toContain("The first answer.");
		for (const label of ["Follow up", "Inject into main", "Stop side answer", "Done", "Put away"]) expect([...h.container.querySelectorAll("button")].some(button => button.textContent?.trim() === label)).toBe(false);
		await act(async () => button(h.container, "Open history").click());
		expect(invoke).toHaveBeenLastCalledWith("btw:ask", "host", "", { generation: 1, epoch: 1 });
		h.render(initial());
		expect(button(h.container, "Follow up").disabled).toBe(false);
	});

	it("leaves empty native content close controls to the drawer header", () => {
		const state = initial(); state.topics = []; state.overlay!.selectedTopic = null; state.overlay!.topics = [];
		const h = mountContent(state);
		expect(h.container.textContent).toContain("No side questions yet");
		expect([...h.container.querySelectorAll("button")].some(button => button.textContent?.trim() === "Done")).toBe(false);
		expect(invoke).not.toHaveBeenCalled();
	});

	it("keeps the history-only pane browseable and copyable without native mutations", async () => {
		const state = initial(); secondTopic(state); state.overlay!.actions.push("inject", "stop");
		const clipboard = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
		const h = mountContent(state, true);
		await chooseHistory(h.container, "Second question");
		expect(h.container.textContent).toContain("Second answer");
		expect(h.container.querySelector("textarea")).toBeNull();
		const labels = [...h.container.querySelectorAll("button")].map(button => button.textContent?.trim());
		for (const label of ["Done", "Follow up", "Ask question", "New question", "Open history", "Inject into main", "Stop side answer"]) expect(labels).not.toContain(label);
		await act(async () => button(h.container, "Copy answers").click());
		expect(clipboard).toHaveBeenCalledWith("Second answer");
		expect(invoke).not.toHaveBeenCalled();
		expect(presentationClaims.getSnapshot()).toEqual([]);
	});

	it.each(["host", "generation", "epoch"] as const)("keeps a displaced %s draft visibly readable and copyable without retargeting", async field => {
		const state = initial(); state.topics[0]!.scope = "original-main"; state.overlay!.selectedTopic = { id: "topic", scope: "original-main" }; state.overlay!.topics = [{ id: "topic", scope: "original-main" }];
		const h = mountContent(state);
		await act(async () => button(h.container, "Follow up").click());
		fill(h.container, "Keep the original draft accessible.");
		const replacement = structuredClone(state);
		if (field === "host") replacement.hostId = "replacement";
		else if (field === "generation") replacement.generation = 2;
		else { replacement.epoch = 2; replacement.overlay!.epoch = 2; }
		h.render(replacement);
		expect(h.container.querySelector("textarea")).toBeNull();
		const saved = h.container.querySelector("details")!;
		expect(saved.querySelector("summary")?.textContent).toBe("Saved drafts (1)");
		await act(async () => saved.querySelector("summary")!.click());
		expect(saved.textContent).toContain("Conversation host, generation 1, epoch 1");
		expect(saved.textContent).toContain("Topic topic, scope original-main");
		expect(saved.querySelector('[aria-label="Saved draft text"]')?.textContent).toBe("Keep the original draft accessible.");
		expect(saved.querySelector("textarea")).toBeNull();
		expect([...saved.querySelectorAll("button")].map(button => button.textContent?.trim())).toEqual(["Copy draft"]);
		const clipboard = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
		await act(async () => button(saved, "Copy draft").click());
		expect(clipboard).toHaveBeenCalledWith("Keep the original draft accessible.");
		expect(invoke).not.toHaveBeenCalled();
		await act(async () => button(h.container, "Follow up").click());
		expect(h.container.querySelector("textarea")?.value).toBe("");
	});

	it("keeps the initial empty-history draft accessible after a native topic opens", async () => {
		const empty = initial(); empty.topics = []; empty.overlay = null;
		const h = mountContent(empty);
		fill(h.container, "Draft before the first topic opened");
		h.render(initial());
		expect(h.container.querySelector("textarea")).toBeNull();
		const saved = h.container.querySelector("details")!;
		expect(saved.querySelector("summary")?.textContent).toBe("Saved drafts (1)");
		await act(async () => saved.querySelector("summary")!.click());
		expect(saved.querySelector('[aria-label="Saved draft text"]')?.textContent).toBe("Draft before the first topic opened");
		expect(saved.textContent).toContain("Conversation host, generation 1, epoch 1");
		const clipboard = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
		await act(async () => button(saved, "Copy draft").click());
		expect(clipboard).toHaveBeenCalledWith("Draft before the first topic opened");
		expect(invoke).not.toHaveBeenCalled();
		await act(async () => button(h.container, "New question").click());
		expect(h.container.querySelector("textarea")?.value).toBe("");
		expect(saved.querySelector('[aria-label="Saved draft text"]')?.textContent).toBe("Draft before the first topic opened");
	});
});

describe("slash-driven BTW presentation", () => {
	it("follows streaming B after historical A was selected and put away", async () => {
		let state = initial(); secondTopic(state);
		const emit = () => { for (const listener of listeners.get("btw:changed") ?? []) listener(structuredClone(state)); };
		invoke.mockImplementation(async (channel: string, _host: string, value: unknown) => {
			if (channel === "btw:list") return structuredClone(state);
			if (channel === "btw:select") { state = structuredClone(state); state.revision++; state.overlay!.selectedTopic = value as { id: string }; emit(); }
			if (channel === "btw:close") { state = { ...state, revision: state.revision + 1, overlay: null }; emit(); }
			if (channel === "btw:ask") {
				const next = initial(); next.revision = state.revision + 1; next.topics = [...state.topics, { ...structuredClone(next.topics[0]!), id: "streaming-b", title: "Question B", turns: [{ question: "Question B", answer: "Streaming B first fragment", status: "running", createdAt: 0 }] }];
				next.overlay!.selectedTopic = { id: "streaming-b" }; next.overlay!.topics = next.topics.map(topic => ({ id: topic.id })); next.overlay!.actions = ["stop", "close"];
				state = next; emit();
			}
		});
		const view = { mode: "live", readOnly: false, host: { hostId: "host", generation: 1, phase: "live", transport: "tsp", tspEpoch: 1 } } as unknown as SessionView;
		const session = { tabId: "btw-slash", projectPath: "/project", getSnapshot: () => view, subscribe: () => () => {} } as unknown as SessionController;
		const container = document.createElement("div"); document.body.append(container);
		const root = createRoot(container); mounted.push({ root, container });
		await act(async () => root.render(createElement(TooltipProvider, null, createElement(BtwDrawer, { session }))));
		await chooseHistory(container, "Second question");
		expect(container.textContent).toContain("Second answer");
		// omp can close its overlay independently; the next slash request chooses the new topic.
		await act(async () => { await window.vomp.invoke("btw:close", "host", { id: "second" }, { generation: 1, epoch: 1 }); });
		expect(presentationClaims.getSnapshot()).toEqual([]);
		await act(async () => { expect(await routeSlash(session, "/btw Question B")).toBe(true); });
		expect(invoke).toHaveBeenLastCalledWith("btw:ask", "host", "Question B", { generation: 1, epoch: 1 });
		expect(container.textContent).toContain("Streaming B first fragment");
		expect(container.textContent).not.toContain("Second answer");
		expect(button(container, "Stop side answer").disabled).toBe(false);
		expect(presentationClaims.getSnapshot()).toContainEqual({ hostId: "host", epoch: 1, surfaceId: "s", nodeId: "btw" });
		state = structuredClone(state); state.revision++; state.topics.at(-1)!.turns[0]!.answer += " and the next fragment";
		await act(async () => emit());
		expect(container.textContent).toContain("Streaming B first fragment and the next fragment");
		expect(button(container, "Stop side answer").disabled).toBe(false);
	});
});

describe("BTW presentation ownership", () => {
	it("keeps a newer streamed answer when the initial history read arrives late", async () => {
		const read = Promise.withResolvers<BtwState>();
		invoke.mockReturnValue(read.promise);
		const view = { mode: "live", readOnly: false, host: { hostId: "host", generation: 1, phase: "live", transport: "tsp", tspEpoch: 1 } } as unknown as SessionView;
		const session = { tabId: "btw-race", getSnapshot: () => view, subscribe: () => () => {} } as unknown as SessionController;
		const container = document.createElement("div"); document.body.append(container);
		const root = createRoot(container); mounted.push({ root, container });
		await act(async () => root.render(createElement(TooltipProvider, null, createElement(BtwDrawer, { session }))));
		const newer = initial(); newer.revision = 2; newer.topics[0]!.turns[0]!.answer = "The answer from the newer frame.";
		await act(async () => { for (const listener of listeners.get("btw:changed") ?? []) listener(newer); });
		await act(async () => read.resolve(initial()));
		expect(container.textContent).toContain("The answer from the newer frame.");
		expect(container.textContent).not.toContain("The first answer.");
	});
	it("claims only a visible supported overlay, and restores fallback when hidden", async () => {
		const state = initial(); invoke.mockResolvedValue(state);
		const view = { mode: "live", readOnly: false, host: { hostId: "host", generation: 1, phase: "live", transport: "tsp", tspEpoch: 1 } } as unknown as SessionView;
		const session = { tabId: "btw-test", getSnapshot: () => view, subscribe: () => () => {} } as unknown as SessionController;
		const container = document.createElement("div"); document.body.append(container);
		const root = createRoot(container); mounted.push({ root, container });
		const render = async (visible: boolean) => { await act(async () => root.render(createElement(TooltipProvider, null, createElement(PresentationVisibility, { visible }, createElement(BtwDrawer, { session }))))); };
		await render(true);
		expect(presentationClaims.getSnapshot()).toContainEqual({ hostId: "host", epoch: 1, surfaceId: "s", nodeId: "btw" });
		await render(false);
		expect(presentationClaims.getSnapshot()).toEqual([]);
		await render(true);
		await act(async () => { for (const listener of listeners.get("btw:changed") ?? []) listener({ ...state, revision: 2, overlay: { ...state.overlay, supported: false } }); });
		expect(presentationClaims.getSnapshot()).toEqual([]);
		expect(container.textContent).toContain("Open omp screen");
	});

	it("does not read or claim BTW state for classic chats", async () => {
		const view = { host: { transport: "classic" } };
		const session = { tabId: "classic", getSnapshot: () => view, subscribe: () => () => {} } as unknown as SessionController;
		const container = document.createElement("div"); document.body.append(container);
		const root = createRoot(container); mounted.push({ root, container });
		await act(async () => root.render(createElement(TooltipProvider, null, createElement(BtwPane, { session, projectPath: null }))));
		expect(invoke).not.toHaveBeenCalled();
		expect(presentationClaims.getSnapshot()).toEqual([]);
	});
});
