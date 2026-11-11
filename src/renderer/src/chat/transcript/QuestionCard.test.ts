// @vitest-environment happy-dom
import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { SessionController } from "../../state/session";
import type * as Ui from "../../ui";
import { QuestionCard } from "./QuestionCard";
import { ASK_CHAT, ASK_OTHER, CUSTOM_ANSWER_PREFIX } from "./askSeries";
import { ChoiceGrid } from "./QuestionChoices";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;


interface TestButton {
	label: ReactNode;
	approvalChoice?: string;
	click(): void;
}
const controls = vi.hoisted(() => ({
	buttons: [] as TestButton[],
	focused: null as TestButton | null,
	answer: vi.fn(),
}));
// As in ChatView.test, render the controls and capture their callbacks. Enter activates the
// focused native button; this seam models that platform behavior without inspecting HTML attributes.
vi.mock("../../ui", async importOriginal => {
	const ui = await importOriginal<typeof Ui>();
	return {
		...ui,
		Button: ({ onClick, autoFocus, children, "data-approval-choice": approvalChoice, ...props }: { onClick: () => void; autoFocus?: boolean; children: ReactNode; "data-approval-choice"?: string }) => {
			const button = { label: children, approvalChoice, click: onClick };
			controls.buttons.push(button);
			if (autoFocus) controls.focused = button;
			return createElement(ui.Button, { ...props, onClick, autoFocus }, children);
		},
	};
});
const keyboard = {
	press(key: string): void {
		if (key === "Enter") controls.focused?.click();
	},
};
beforeEach(() => {
	controls.buttons.length = 0;
	controls.focused = null;
	controls.answer.mockClear();
});
const session = { answer: controls.answer, getSnapshot: () => ({ strandedImages: false }) } as unknown as SessionController;
const render = (options: Extract<CollabUiRequest, { kind: "select" }>["options"]) => renderToStaticMarkup(createElement(QuestionCard, {
	session,
	request: { reqId: 7, kind: "select", title: "Read /tmp/project/secret.txt?\nFolder: /tmp/project", options, initialIndex: 0 },
}));

describe("tool approval card", () => {
	it.each([
		["Approve", "Deny"],
		["Approve", "Approve bash for this session", "Deny"],
		["Approve bash for this session", "Approve", "Deny"],
		["Approve Directory: /tmp/project", "Approve File", "Always Approve Directory: /tmp/project", "Always Approve File", "Approve Once", "Approve read for this session", "Deny"],
		["Approve Once", "Always Approve File", "Approve File", "Approve read for this session", "Deny"],
	])("sends the one-time label with Enter and exact secondary labels for options %j", (...labels) => {
		render(labels);
		const once = labels.includes("Approve Once") ? "Approve Once" : "Approve";
		expect(controls.answer).not.toHaveBeenCalled();
		keyboard.press("Enter");
		expect(controls.answer).toHaveBeenCalledExactlyOnceWith(7, once);

		for (const label of labels.filter(value => value !== once)) {
			controls.answer.mockClear();
			const name = label === "Deny" ? "Deny action" : label;
			const button = controls.buttons.find(control => label === "Deny" ? control.label === "Deny action" : control.approvalChoice === label);
			expect(button, `Missing approval action: ${name}`).toBeDefined();
			button!.click();
			expect(controls.answer).toHaveBeenCalledExactlyOnceWith(7, label);
		}
	});

	it("sends exact one-time and secondary labels from object options", () => {
		render([{ label: "Always Approve File" }, { label: "Approve Once" }, { label: "Deny" }]);
		keyboard.press("Enter");
		expect(controls.answer).toHaveBeenCalledExactlyOnceWith(7, "Approve Once");
		controls.answer.mockClear();
		controls.buttons.find(control => control.approvalChoice === "Always Approve File")!.click();
		expect(controls.answer).toHaveBeenCalledExactlyOnceWith(7, "Always Approve File");
	});

	it("keeps generic selects generic when they lack a final Deny or a one-time approval", () => {
		expect(render(["Approve Once", "Other"])).not.toContain("Permission needed");
		expect(render(["Always Approve File", "Deny"])).not.toContain("Permission needed");
	});

	it("always explains that a new message denies the request", () => {
		const html = render(["Approve", "Deny"]);
		expect(html).toContain("Sending a message now denies this request.");
		expect(html).toContain("Deny and say why");
		expect(render(["One", "Two"])).not.toContain("Sending a message now denies this request.");
	});
});

it("explains message closure only for an identified live ask question", () => {
	const request: CollabUiRequest = { reqId: 7, kind: "select", title: "Which database?", options: ["SQLite", "Other (type your own)", "Chat about this"] };
	const activeTools = new Map([["ask-1", { toolCallId: "ask-1", toolName: "ask", args: { questions: [{ id: "db", question: request.title, options: [{ label: "SQLite" }] }] }, startedAt: 0 }]]);
	const askSession = { answer: controls.answer, getSnapshot: () => ({ mode: "live", readOnly: false, guest: { phase: "live", readOnly: false, uiRequest: request, activeTools, entries: [], stream: null, working: true } }) } as unknown as SessionController;
	const html = renderToStaticMarkup(createElement(QuestionCard, { session: askSession, request }));
	expect(html).toContain("Sending a message closes this question without stopping the reply.");
	expect(html).not.toContain("Sending a message now denies this request.");
	expect(render(["One", "Two"])).not.toContain("Sending a message closes this question");
});

it("shows swatches in question text, option labels and descriptions without changing the answer", () => {
	const request: CollabUiRequest = {
		reqId: 8, kind: "select", title: "Use #aabbcc and `#123` or issue #123?",
		options: [{ label: "#112233 or `#abc`", description: "Transparent #11223344 or `#fff`" }, "#445566"],
	};
	const html = renderToStaticMarkup(createElement(QuestionCard, { session, request }));
	const root = document.createElement("div");
	root.innerHTML = html;
	expect(root.querySelector('[data-question-card="8"] p code .vomp-color-swatch')).not.toBeNull();
	expect(root.querySelector('[data-choice="0"]')?.querySelectorAll(".vomp-color-swatch")).toHaveLength(4);
	expect(root.querySelector('[data-choice="0"]')?.querySelectorAll("code .vomp-color-swatch")).toHaveLength(2);
	expect(root.querySelectorAll(".vomp-color-swatch")).toHaveLength(7);
	expect(root.querySelector('[data-choice="0"]')?.textContent).toContain("#112233 or #abc");
	controls.buttons.find(control => control.label === "Send answer")!.click();
	expect(controls.answer).toHaveBeenCalledExactlyOnceWith(8, "#112233 or `#abc`");
});

it("shows swatches in an editor question without changing its input", () => {
	const request: CollabUiRequest = { reqId: 9, kind: "editor", title: "Describe #aabbcc", prefill: "#112233" };
	const html = renderToStaticMarkup(createElement(QuestionCard, { session, request }));
	expect(html.match(/class="vomp-color-swatch"/g)).toHaveLength(1);
	expect(html).toContain(">#112233</textarea>");
});
it("renders question and option code safely", () => {
	const request: CollabUiRequest = {
		reqId: 10, kind: "select", title: "Save `task.agentModelOverrides` <script>?",
		helpText: "Set `mode` first",
		options: [{ label: "Use `config.yml`", description: "Keep `#abc`" }, "Other (type your own)"],
	};
	const html = renderToStaticMarkup(createElement(QuestionCard, { session, request }));
	const root = document.createElement("div");
	root.innerHTML = html;
	expect(root.querySelector('[data-question-card="10"] p code')?.textContent).toBe("task.agentModelOverrides");
	expect(root.querySelector("script")).toBeNull();
	expect(root.querySelectorAll("code").length).toBeGreaterThanOrEqual(4);
	expect(root.querySelector(".vomp-color-swatch")).not.toBeNull();
	expect(root.textContent).not.toContain("`task.agentModelOverrides`");
});

it("keeps shared native choice labels literal and submits the original question label", async () => {
	const choice = createElement(ChoiceGrid, {
		choices: [{ label: "Use `config.yml`" }], multi: false, labelledBy: "question",
		isOn: () => false, activeIndex: 0, onSelect: () => {},
	});
	const nativeHtml = renderToStaticMarkup(choice);
	expect(nativeHtml).not.toContain("<code");
	expect(nativeHtml).toContain("Use `config.yml`");

	const request: CollabUiRequest = { reqId: 11, kind: "select", title: "Choose a file", options: ["Use `config.yml`"] };
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () => { root.render(createElement(QuestionCard, { session, request })); });
		const option = container.querySelector<HTMLButtonElement>('[data-choice="0"]')!;
		expect(option.querySelector("code")?.textContent).toBe("config.yml");
		await act(async () => { option.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
		expect(controls.answer).toHaveBeenCalledExactlyOnceWith(11, "Use `config.yml`");
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});

it("sends typed Other text with its backticks unchanged", async () => {
	const request: CollabUiRequest = { reqId: 12, kind: "select", title: "Choose or add one", options: ["One", ASK_OTHER, ASK_CHAT], initialIndex: -1 };
	const answer = "Keep `my answer` literal";
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () => { root.render(createElement(QuestionCard, { session, request })); });
		const input = container.querySelector<HTMLInputElement>("input")!;
		const propsKey = Object.keys(input).find(key => key.startsWith("__reactProps$"))!;
		const inputProps = (input as unknown as Record<string, { onChange?: (event: { target: HTMLInputElement }) => void }>)[propsKey]!;
		await act(async () => {
			input.value = answer;
			inputProps.onChange!({ target: input });
		});
		await act(async () => { root.render(createElement(QuestionCard, { session, request })); });
		expect(input.value).toBe(answer);
		await act(async () => {
			[...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Send answer")!.click();
		});
		expect(controls.answer).toHaveBeenNthCalledWith(1, 12, ASK_OTHER);

		const editor: CollabUiRequest = { reqId: 13, kind: "editor", title: `${CUSTOM_ANSWER_PREFIX}Choose or add one` };
		await act(async () => { root.render(createElement(QuestionCard, { session, request: editor })); });
		expect(controls.answer).toHaveBeenNthCalledWith(2, 13, answer);
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});
