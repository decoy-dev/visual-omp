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
