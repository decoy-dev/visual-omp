// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionController, SessionView } from "../state/session";
import "../i18n";

const actions = vi.hoisted(() => ({ newChat: vi.fn(), ensureLive: vi.fn(), restore: vi.fn() }));
vi.mock("../registry/slots", () => ({ chatSlots: { use: () => [] } }));
vi.mock("../shell/hooks", () => ({ elapsed: vi.fn(), useNow: vi.fn(), useSessionView: vi.fn() }));
vi.mock("../state/app", () => ({ useApp: { getState: () => ({ newChat: actions.newChat }) } }));
vi.mock("./composer/Composer", () => ({ Composer: () => null }));
vi.mock("./SessionHeader", () => ({ SessionHeader: () => null }));
vi.mock("./transcript/Transcript", () => ({ Transcript: () => null }));

import { StateBanner } from "./ChatView";

let element: HTMLDivElement;
let root: Root;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	actions.newChat.mockClear(); actions.ensureLive.mockClear(); actions.restore.mockClear();
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
});
afterEach(async () => {
	await act(async () => root.unmount());
	element.remove();
});

async function render(reason: string | null, missing = false, error: string | null = null, restore = false, transport?: "tsp") {
	const session = { projectPath: "/chosen/folder", ensureLive: actions.ensureLive, restore: actions.restore } as unknown as SessionController;
	const view = { mode: "exited", readOnly: false, error, host: { transport, exitCode: 1, exitReason: reason, resumeFileMissing: missing, restoreAvailable: restore } } as SessionView;
	await act(async () => root.render(createElement(StateBanner, { session, view })));
}

async function clickButton(name: string) {
	const button = [...element.querySelectorAll("button")].find(button => (button.getAttribute("aria-label") ?? button.textContent) === name);
	expect(button, `Button named ${name}`).toBeDefined();
	expect(button!.disabled).toBe(false);
	await act(async () => button!.click());
}

describe("startup exit banner", () => {
	it.each([undefined, "tsp"] as const)("shows the missing session path and starts a fresh chat in the same folder (%s)", async transport => {
		await render("Session file not found: /chosen/folder/missing.jsonl", true, null, false, transport);
		expect(element.textContent).toContain("Session file not found: /chosen/folder/missing.jsonl");
		expect(element.textContent).not.toContain("Start omp again");
		await clickButton("Start a fresh chat");
		expect(actions.newChat).toHaveBeenCalledExactlyOnceWith("/chosen/folder");
		expect(actions.ensureLive).not.toHaveBeenCalled();
		expect(actions.restore).not.toHaveBeenCalled();
	});

	it.each([undefined, "tsp"] as const)("shows the named model error and restarts the same chat (%s)", async transport => {
		await render("Model unavailable: provider/model-name\nretry.modelFallback is disabled.", false, null, false, transport);
		expect(element.textContent).toContain("provider/model-name");
		expect(element.textContent).toContain("retry.modelFallback is disabled.");
		expect(element.textContent).not.toContain("Start a fresh chat");
		await clickButton("Start omp again");
		expect(actions.ensureLive).toHaveBeenCalledOnce();
		expect(actions.newChat).not.toHaveBeenCalled();
		expect(actions.restore).not.toHaveBeenCalled();
	});

	it("keeps a launch error when no terminal reason was reported", async () => {
		await render(null, false, "Permission denied");
		expect(element.textContent).toContain("Permission denied");
	});
});

it("offers explicit crash recovery without silently choosing it for an ordinary restart", async () => {
	await render(null, false, null, true);
	await clickButton("Continue where omp stopped");
	expect(actions.restore).toHaveBeenCalledOnce();
	expect(actions.ensureLive).not.toHaveBeenCalled();
	expect(actions.newChat).not.toHaveBeenCalled();
});
