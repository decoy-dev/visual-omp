// @vitest-environment happy-dom
import { act, createElement, type PropsWithChildren, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConnectedProvider, StoredProviderAccount } from "@shared/contracts/providers";
import { ProvidersSection } from "./ProvidersSection";
import { i18n } from "../../../i18n";

const fake = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), toast: vi.fn(), login: vi.fn((_props: unknown) => null) }));
vi.mock("../../../state/app", () => ({ useApp: { getState: () => ({ tabs: [] }) }, controllerFor: () => null }));
vi.mock("./OmpLoginDialog", () => ({ OmpLoginDialog: fake.login }));
vi.mock("../listMotion", () => ({ listRowMotion: {} }));
vi.mock("./parts", () => ({ SettingsSection: ({ title, children }: PropsWithChildren<{ title: string }>) => createElement("section", null, createElement("h2", null, title), children) }));
vi.mock("motion/react", () => ({
	motion: { div: ({ children }: PropsWithChildren) => createElement("div", null, children) },
	AnimatePresence: ({ children }: PropsWithChildren) => children,
}));
vi.mock("../../../ui", () => {
	const e = createElement;
	const group = ({ children }: PropsWithChildren) => e("div", null, children);
	return {
		Button: ({ children, onClick, disabled, loading, "aria-label": label }: PropsWithChildren<{ onClick?: () => void; disabled?: boolean; loading?: boolean; "aria-label"?: string }>) => e("button", { onClick, disabled: disabled || loading, "aria-label": label }, children),
		Chip: group, Menu: group, MenuContent: group, MenuTrigger: group,
		MenuItem: ({ children, onSelect }: PropsWithChildren<{ onSelect(): void }>) => e("button", { onClick: onSelect }, children),
		IconButton: ({ label }: { label: string }) => e("button", null, label),
		Dialog: ({ open, children }: PropsWithChildren<{ open: boolean }>) => open ? e("div", { role: "dialog" }, children) : null,
		DialogContent: ({ title, description, children, footer }: PropsWithChildren<{ title: string; description: string; footer: ReactNode }>) => e("div", null, e("h2", null, title), e("p", null, description), children, footer),
		Notice: group, PageHeader: ({ title, actions }: { title: string; actions: ReactNode }) => e("header", null, title, actions),
		SearchInput: () => e("input"), Spinner: () => null, toast: fake.toast,
	};
});

const personal: StoredProviderAccount = { provider: "test", credentialId: 1, type: "oauth", label: "me@example.com (Personal)", detail: "account personal · oauth #1", active: false };
const team: StoredProviderAccount = { ...personal, credentialId: 2, label: "me@example.com (Team)", detail: "account team · oauth #2" };
const key: StoredProviderAccount = { provider: "test", credentialId: 3, type: "api_key", label: "API key #3", detail: "stored API key #3", active: false };
const provider: ConnectedProvider = {
	id: "test", name: "Test provider", login: { id: "test", name: "Test provider" },
	accounts: [], disabledAccounts: [], authenticated: true, modelCount: 1, kinds: ["chat"], storedAccounts: [personal, team, key],
};
let root: Root;
let element: HTMLDivElement;
const buttons = () => [...element.querySelectorAll("button")];
const accountButton = (account: StoredProviderAccount) => buttons().find(button => button.getAttribute("aria-label")?.includes(`${account.label} · ${account.detail}`))!;
const dialogButton = (label: string) => [...element.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === label) as HTMLButtonElement;
const render = async () => {
	await i18n.loadNamespaces("settings");
	await act(async () => root.render(createElement(ProvidersSection, { projectPath: "/project", scope: "global", setScope: () => {}, props: undefined })));
};

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.clearAllMocks();
	fake.on.mockReturnValue(() => {});
	fake.invoke.mockImplementation(async (channel: string) => channel === "providers:list" ? { connected: [provider], available: [] } : undefined);
	Object.assign(window, { vomp: { invoke: fake.invoke, on: fake.on } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });

it("lists every stored identity and confirms only the selected organization before sign-out", async () => {
	await render();
	for (const account of [personal, team, key]) expect(accountButton(account)).toBeDefined();
	expect(buttons().some(button => button.textContent === "Sign out of Test provider")).toBe(false);
	await act(async () => accountButton(team).click());
	const dialog = element.querySelector('[role="dialog"]')!;
	expect(dialog.textContent).toContain("Sign out of me@example.com (Team)?");
	expect(dialog.textContent).toContain(team.detail);
	expect(dialog.textContent).toContain("Other stored accounts stay signed in.");
	expect(fake.invoke.mock.calls.filter(([channel]) => channel === "providers:logout")).toEqual([]);
	await act(async () => dialogButton("Sign out").click());
	expect(fake.invoke).toHaveBeenCalledWith("providers:logout", team);
	expect(element.querySelector('[role="dialog"]')).toBeNull();
});

it("does not sign out after cancellation and preserves sign-in and transfer actions", async () => {
	await render();
	await act(async () => accountButton(key).click());
	await act(async () => dialogButton("Cancel").click());
	expect(fake.invoke.mock.calls.some(([channel]) => channel === "providers:logout")).toBe(false);
	expect(buttons().some(button => button.textContent === "Sign in again")).toBe(true);
	expect(buttons().some(button => button.textContent === "Export sign-ins…")).toBe(true);
	expect(buttons().some(button => button.textContent === "Import sign-ins…")).toBe(true);
});

it("offers no sign-out for authentication supplied without stored accounts", async () => {
	fake.invoke.mockResolvedValue({ connected: [{ ...provider, storedAccounts: [] }], available: [] });
	await render();
	expect(element.textContent).toContain("Credential found");
	expect(buttons().some(button => button.textContent === "Sign out")).toBe(false);
});

it("retains the exact target and reports a failed removal for retry", async () => {
	await render();
	fake.invoke.mockRejectedValueOnce(new Error("The selected account changed. Check providers again."));
	await act(async () => accountButton(personal).click());
	await act(async () => dialogButton("Sign out").click());
	expect(element.querySelector('[role="dialog"]')?.textContent).toContain(personal.detail);
	expect(fake.toast).toHaveBeenCalledWith(expect.objectContaining({ tone: "err", description: "The selected account changed. Check providers again." }));
	expect(dialogButton("Sign out").disabled).toBe(false);
});

it("keeps omp's account-risk name in the sign-in list and dialog target", async () => {
	const method = { id: "google-antigravity", name: "Google Antigravity (Gemini, Claude, GPT-OSS) (at your own risk)" };
	fake.invoke.mockResolvedValue({ connected: [], available: [method] });
	await render();
	expect(element.textContent).toContain(method.name);
	await act(async () => buttons().find(button => button.textContent === "Sign in")!.click());
	expect(fake.login.mock.calls.at(-1)?.[0]).toMatchObject({ target: { methodId: method.id, name: method.name }, cwd: "/project" });
});

it("does not report a declined or failed login as a successful sign-in", async () => {
	fake.invoke.mockResolvedValue({ connected: [], available: [{ id: "google-antigravity", name: "Google Antigravity (at your own risk)" }] });
	await render();
	await act(async () => buttons().find(button => button.textContent === "Sign in")!.click());
	const props = fake.login.mock.calls.at(-1)![0] as unknown as { onFinished(code: number): void };
	await act(async () => props.onFinished(1));
	expect(fake.toast).not.toHaveBeenCalled();
	await act(async () => props.onFinished(0));
	expect(fake.toast).toHaveBeenCalledWith(expect.objectContaining({ tone: "ok" }));
});
