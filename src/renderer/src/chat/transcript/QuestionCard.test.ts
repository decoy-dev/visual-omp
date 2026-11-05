import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { SessionController } from "../../state/session";
import type * as Ui from "../../ui";
import { QuestionCard } from "./QuestionCard";


interface TestButton {
	label: ReactNode;
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
		Button: ({ onClick, autoFocus, children, ...props }: { onClick: () => void; autoFocus?: boolean; children: ReactNode }) => {
			const button = { label: children, click: onClick };
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
			const button = controls.buttons.find(control => control.label === name);
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
		controls.buttons.find(control => control.label === "Always Approve File")!.click();
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
		reqId: 8, kind: "select", title: "Use #aabbcc or issue #123?",
		options: [{ label: "#112233", description: "Transparent #11223344 or `#abc`" }, "#445566"],
	};
	const html = renderToStaticMarkup(createElement(QuestionCard, { session, request }));
	expect(html.match(/class="vomp-color-swatch"/g)).toHaveLength(5);
	expect(html).toContain('title="#AABBCC"');
	expect(html).toContain('title="#11223344"');
	expect(html).toContain("issue #123?");
	controls.buttons.find(control => control.label === "Send answer")!.click();
	expect(controls.answer).toHaveBeenCalledExactlyOnceWith(8, "#112233");
});

it("shows swatches in an editor question without changing its input", () => {
	const request: CollabUiRequest = { reqId: 9, kind: "editor", title: "Describe #aabbcc", prefill: "#112233" };
	const html = renderToStaticMarkup(createElement(QuestionCard, { session, request }));
	expect(html.match(/class="vomp-color-swatch"/g)).toHaveLength(1);
	expect(html).toContain(">#112233</textarea>");
});
