// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import "../../i18n";
import { NoticeRow } from "./NoticeRow";

it("renders projected notices literally with preserved whitespace and a wrapping body", async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	const element = document.createElement("div");
	const root = createRoot(element);
	const content = `  <model> \`literal\`\nsecond line\n${"unbroken".repeat(100)}`;
	try {
		await act(async () => root.render(createElement(NoticeRow, { entry: { customType: "tsp-notice", content }, mode: "normal" })));
		const body = element.querySelector('[role="note"] p');
		expect(body?.textContent).toBe(content);
		expect(body?.className).toContain("whitespace-pre-wrap");
		expect(body?.className).toContain("[overflow-wrap:anywhere]");
		expect(element.querySelector("model, code, pre, .tr-md")).toBeNull();
	} finally { await act(async () => root.unmount()); }
});
