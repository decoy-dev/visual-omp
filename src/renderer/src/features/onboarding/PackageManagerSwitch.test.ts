// @vitest-environment happy-dom
import { act, createElement as e, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { AppInstallOperation, AppInstallSwitchInfo } from "@shared/contracts/updates";
import type * as Ui from "../../ui";
import { i18n } from "../../i18n";

// Each test imports the component's module graph again (see render), which takes seconds while the full suite runs.
vi.setConfig({ testTimeout: 20_000 });

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
beforeEach(async () => {
	vi.resetModules(); fake.invoke.mockReset(); fake.approved = true;
	// Mock factories retain their stores across resetModules; reset the shared operation explicitly.
	const { useUpdates } = await import("./updates");
	useUpdates.setState({ operation: null });
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
/** The switch info and dialog arrive asynchronously, so wait for the control before using it. */
async function button(text: string): Promise<HTMLButtonElement> {
	return vi.waitFor(() => {
		const scope = document.body.querySelector('[role="dialog"]') ?? document.body;
		const found = [...scope.querySelectorAll("button")].find(button => button.textContent === text);
		expect(found, text).toBeDefined();
		return found!;
	}, { timeout: 10_000 });
}
async function click(text: string) {
	const target = await button(text);
	await act(async () => target.click());
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

it("shows the Scoop guide when Scoop is missing", async () => {
	await render({ manager: "scoop", available: false, existing: false, target: null });
	await click("Show how to switch");
	expect(element.textContent).toContain("scoop install git");
	await click("Open scoop.sh");
	expect(fake.invoke).toHaveBeenCalledWith("app:openExternal", "https://scoop.sh");
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
	const target = await button("Switch to Homebrew");
	await act(async () => useUpdates.setState({ operation: "reinstall" }));
	expect(target.disabled).toBe(true);
	await act(async () => target.click());
	expect(fake.invoke).not.toHaveBeenCalledWith("updates:app:switchStart");
});

it("confirms the Windows post-exit sequence and defers it until the quit guard approves", async () => {
	await render({ manager: "scoop", available: true, existing: true, target: "C:\\scoop\\apps\\visual-omp\\current\\visual-omp.exe" });
	await click("Switch to Scoop");
	await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Cancel"));
	expect(document.body.textContent).toContain("checks the executable, install record and version");
	expect(document.body.textContent).toContain("reuse that copy without installing another");
	await click("Switch to Scoop");
	expect(fake.invoke).not.toHaveBeenCalledWith("updates:app:switchComplete", false);
	fake.approved = false;
	await click("Continue in PowerShell");
	expect(fake.invoke).not.toHaveBeenCalledWith("updates:app:switchComplete", false);
	fake.approved = true;
	await click("Continue in PowerShell");
	expect(fake.invoke).toHaveBeenCalledWith("updates:app:switchComplete", false);
	expect(document.body.textContent).not.toContain("Move old copy to Trash");
});

it("disables the Scoop switch while an update owns installation", async () => {
	await render({ manager: "scoop", available: true, existing: false, target: null });
	const { useUpdates } = await import("./updates");
	const target = await button("Switch to Scoop");
	await act(async () => useUpdates.setState({ operation: "update" }));
	expect(target.disabled).toBe(true);
	await act(async () => target.click());
	expect(fake.invoke).not.toHaveBeenCalledWith("updates:app:switchStart");
});
