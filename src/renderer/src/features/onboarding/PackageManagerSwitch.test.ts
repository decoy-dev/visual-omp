// @vitest-environment happy-dom
import { act, createElement as e, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { AppInstallOperation, AppInstallSwitchInfo } from "@shared/contracts/updates";
import type * as Ui from "../../ui";
import { i18n } from "../../i18n";

const fake = vi.hoisted(() => ({ invoke: vi.fn(), approved: true }));
vi.mock("./InlineTerminal", () => ({ InlineTerminal: () => e("div", null, "Install output") }));
vi.mock("./quit", () => ({ quitAfterConfirm: async (action: () => Promise<void>) => { if (fake.approved) await action(); } }));
vi.mock("./updates", async () => {
	const { create } = await import("zustand");
	return { useUpdates: create<{ operation: AppInstallOperation | null }>(() => ({ operation: null })) };
});
vi.mock("../../ui/Tooltip", () => ({ Tooltip: ({ children }: PropsWithChildren) => children, TooltipProvider: ({ children }: PropsWithChildren) => children }));
vi.mock("../../ui", async () => {
	const actual = await vi.importActual<typeof Ui>("../../ui");
	return { ...actual, Expand: ({ children, open }: PropsWithChildren<{ open: boolean }>) => open ? e("div", null, children) : null, toast: vi.fn() };
});
let root: Root;
let element: HTMLDivElement;
beforeAll(async () => { await i18n.loadNamespaces("onboarding"); });
beforeEach(() => {
	vi.resetModules(); fake.invoke.mockReset(); fake.approved = true;
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	Object.assign(window, { vomp: { invoke: fake.invoke, on: () => () => {}, platform: "darwin" } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
async function render(info: AppInstallSwitchInfo) {
	fake.invoke.mockImplementation(async (channel: string) => {
		if (channel === "updates:app:switchInfo") return info;
		if (channel === "updates:app:switchStart") return { command: null, target: "/Applications/visual-omp.app", version: "0.7.6", existing: true, canTrash: info.manager === "brew" };
		return undefined;
	});
	// Resetting modules isolates the module-owned switch state between independent installation scenarios.
	const { PackageManagerSwitch } = await import("./PackageManagerSwitch");
	await act(async () => root.render(e(PackageManagerSwitch)));
}
async function click(text: string) {
	const scope = document.body.querySelector('[role="dialog"]') ?? document.body;
	const button = [...scope.querySelectorAll("button")].find(button => button.textContent === text);
	expect(button, text).toBeDefined();
	await act(async () => button!.click());
}

it("shows Homebrew setup and README commands when brew is absent", async () => {
	await render({ manager: "brew", available: false, existing: false, target: null });
	await click("Show how to switch");
	expect(element.textContent).toContain("Install Homebrew by following the instructions on brew.sh.");
	expect(element.textContent).toContain("brew tap decoy-dev/tap https://github.com/decoy-dev/visual-omp");
	expect(element.textContent).toContain("brew install --cask decoy-dev/tap/visual-omp");
	await click("Open brew.sh");
	expect(fake.invoke).toHaveBeenCalledWith("app:openExternal", "https://brew.sh");
	expect(fake.invoke).not.toHaveBeenCalledWith("updates:app:switchStart");
});

it("always shows the manual Scoop guide without probing or automating Windows installation", async () => {
	const { ScoopSuggestion } = await import("./PackageManagerSwitch");
	await act(async () => root.render(e(ScoopSuggestion)));
	await click("Show how to switch");
	expect(element.textContent).toContain("scoop install git");
	await click("Open scoop.sh");
	expect(fake.invoke).toHaveBeenCalledWith("app:openExternal", "https://scoop.sh");
	expect(fake.invoke).not.toHaveBeenCalledWith("updates:app:switchInfo");
	expect(fake.invoke).not.toHaveBeenCalledWith("updates:app:switchStart");
});

it("confirms a switch with Cancel focused and leaves the copy unchanged on cancellation", async () => {
	await render({ manager: "brew", available: true, existing: false, target: null });
	await click("Switch to Homebrew");
	expect(document.body.textContent).toContain("omp's installation stays unchanged.");
	expect(document.activeElement?.textContent).toBe("Cancel");
	await click("Cancel");
	expect(fake.invoke).not.toHaveBeenCalledWith("updates:app:switchStart");
	await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Switch to Homebrew"));
});

it("reuses an existing copy and keeps Trash opt-in behind the working-chat quit guard", async () => {
	await render({ manager: "brew", available: true, existing: true, target: "/Applications/visual-omp.app" });
	await click("Switch to Homebrew");
	expect(document.body.textContent).toContain("reuse that copy without installing another");
	await click("Switch to Homebrew");
	fake.approved = false;
	await click("Move old copy to Trash and restart");
	expect(fake.invoke).not.toHaveBeenCalledWith("updates:app:switchComplete", true);
	fake.approved = true;
	await click("Open Homebrew copy");
	expect(fake.invoke).toHaveBeenCalledWith("updates:app:switchComplete", false);
	expect(fake.invoke).not.toHaveBeenCalledWith("updates:app:switchComplete", true);
});

it("disables the Homebrew transfer while another installation runs", async () => {
	await render({ manager: "brew", available: true, existing: false, target: null });
	const { useUpdates } = await import("./updates");
	await act(async () => useUpdates.setState({ operation: "reinstall" }));
	const button = [...element.querySelectorAll("button")].find(button => button.textContent === "Switch to Homebrew")!;
	expect(button.disabled).toBe(true);
	await act(async () => button.click());
	expect(fake.invoke).not.toHaveBeenCalledWith("updates:app:switchStart");
});
