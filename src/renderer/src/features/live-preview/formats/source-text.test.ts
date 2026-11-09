// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveSubject } from "../types";
import copy from "../../../i18n/en/panes.json";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key === "live.sourceTooLarge" ? copy.live.sourceTooLarge : key }) }));
import { useSourceText, WaitingForSave } from "./shared";
let host: HTMLDivElement, root: Root;
const invoke = vi.fn();
function Source() {
	const { error, tooLarge } = useSourceText({ kind: "file", path: "/project/large.md", revision: 1 } as LiveSubject);
	return error ? createElement(WaitingForSave, { tooLarge }) : null;
}
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	Object.defineProperty(window, "vomp", { configurable: true, value: { invoke } });
	invoke.mockReset().mockResolvedValue({ kind: "tooLarge", size: 30_000_000, limit: 2 * 1024 * 1024 });
	host = document.createElement("div"); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); });
it("explains the text-parsing limit instead of waiting for a completed oversized save", async () => {
	await act(async () => root.render(createElement(Source)));
	expect(host.textContent).toContain("limited to 2 MB");
	expect(host.textContent).toContain("Open it in Files");
});
