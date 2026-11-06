// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionAccounts } from "@shared/contracts/native";
import type { SessionController, SessionView } from "../../state/session";
import "../../i18n";
import { TooltipProvider } from "../../ui/Tooltip";
import { AccountButton } from "./AccountButton";

const fake = vi.hoisted(() => {
	Object.assign(window, { vomp: { platform: "darwin", on: () => () => {}, invoke: async () => null } });
	return { listing: null as SessionAccounts | null, working: false, readOnly: false, pin: vi.fn() };
});
vi.mock("./accounts", () => ({ useSessionAccounts: () => fake.listing, pinSessionAccount: (...args: unknown[]) => fake.pin(...args) }));
// Hoisted UI mock factories must import their actual primitives after mocks initialize.
vi.mock("@/ui", async () => ({
	...await import("../../ui/Menu"), ...await import("../../ui/Tooltip"),
	...await import("../../ui/Spinner"), ...await import("../../ui/cn"),
}));
let root: Root;
let element: HTMLDivElement;
// The controller exposes the input fields used by the account projection.
const session = { tabId: "chat", subscribe: () => () => {}, getSnapshot: () => ({ mode: "live", working: fake.working, readOnly: fake.readOnly, host: { hostId: "host", generation: 1, sessionId: "session" } } as unknown as SessionView) } as unknown as SessionController;
const listing: SessionAccounts = { provider: "anthropic", sessionId: "session", accounts: [
	{ credentialId: 7, label: "same@example.com (Personal)", active: true },
	{ credentialId: 12, label: "same@example.com (Work)", active: false },
] };
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	fake.listing = listing; fake.working = false; fake.readOnly = false;
	fake.pin.mockReset().mockResolvedValue(listing);
	Object.assign(window, { vomp: { invoke: vi.fn().mockResolvedValue(listing) } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
async function render() { await act(async () => root.render(createElement(TooltipProvider, null, createElement(AccountButton, { session })))); }
function trigger() { return element.querySelector<HTMLButtonElement>("button")!; }
async function open() { await act(async () => trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))); }
function options() { return [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]; }

describe("chat account picker", () => {
	it("shows nothing for missing state, no accounts or one account", async () => {
		for (const value of [null, { ...listing, accounts: [] }, { ...listing, accounts: listing.accounts.slice(0, 1) }]) {
			fake.listing = value; await render(); expect(element.querySelector("button")).toBeNull();
		}
	});
	it("opens from the keyboard, names org-qualified accounts and marks only omp's current identity", async () => {
		await render(); expect(trigger().getAttribute("aria-label")).toContain("same@example.com (Personal)");
		await open();
		expect(options().map(row => row.textContent)).toEqual(listing.accounts.map(account => account.label));
		expect(options().map(row => row.getAttribute("aria-checked"))).toEqual(["true", "false"]);
		expect(document.body.textContent).toContain("omp can still switch accounts at usage limits");
	});
	it("shortens the email while retaining the complete account identity for assistive technology", async () => {
		const label = "averylongaccountname@example.com (Work)";
		fake.listing = { ...listing, accounts: [{ ...listing.accounts[0]!, label }, listing.accounts[1]!] };
		await render();
		expect(trigger().textContent).toContain("averylon…tname");
		expect(trigger().textContent).not.toContain("@example.com");
		expect(trigger().getAttribute("aria-label")).toContain(label);
		await open();
		expect(options()[0]?.textContent).toBe(label);
	});
	it("retains a short non-email account label", async () => {
		fake.listing = { ...listing, accounts: [{ ...listing.accounts[0]!, label: "Personal" }, listing.accounts[1]!] };
		await render();
		expect(trigger().textContent).toBe("Personal");
	});
	it.each([
		["same@example.com (Personal)", "same@example.com (Work)"],
		["same@personal.example.com", "same@work.example.com"],
		["averylongPERSONALaccountname@example.com", "averylongWORKaccountname@example.com"],
	])("keeps colliding compact accounts visibly distinct: %s", async (first, second) => {
		const visible: string[] = [];
		for (const active of [7, 12]) {
			fake.listing = { ...listing, accounts: [
				{ credentialId: 7, label: first, active: active === 7 },
				{ credentialId: 12, label: second, active: active === 12 },
			] };
			await render();
			visible.push(trigger().textContent!);
		}
		expect(visible).toEqual([first, second]);
		expect(new Set(visible).size).toBe(2);
	});
	it("distinguishes identical labels with omp's stored credential identity", async () => {
		const visible: string[] = [];
		for (const active of [7, 12]) {
			fake.listing = { ...listing, accounts: listing.accounts.map(account => ({ ...account, label: "same@example.com", active: account.credentialId === active })) };
			await render();
			visible.push(trigger().textContent!);
		}
		expect(visible).toEqual(["same@example.com · #7", "same@example.com · #12"]);
		await open();
		expect(options().map(option => option.textContent)).toEqual(["same@example.com · #7", "same@example.com · #12"]);
	});
	it("keeps an unknown account unchecked", async () => {
		fake.listing = { ...listing, accounts: listing.accounts.map(account => ({ ...account, active: false })) };
		await render(); expect(trigger().textContent).toContain("Choose account"); await open();
		expect(options().every(row => row.getAttribute("aria-checked") === "false")).toBe(true);
	});
	it("explains why the choice is disabled while omp replies", async () => {
		fake.working = true; await render(); await open();
		expect(options().every(row => row.getAttribute("aria-disabled") === "true")).toBe(true);
		expect(document.body.textContent).toContain("Wait for omp to finish replying");
		await act(async () => options()[1]!.click()); expect(fake.pin).not.toHaveBeenCalled();
	});
	it("keeps the confirmed check while a change is pending and closes only after confirmation", async () => {
		const pending = Promise.withResolvers<SessionAccounts>(); fake.pin.mockReturnValue(pending.promise);
		await render(); await open();
		await act(async () => options()[1]!.click());
		expect(fake.pin).toHaveBeenCalledExactlyOnceWith(session, listing, 12);
		expect(options()[0]?.getAttribute("aria-checked")).toBe("true");
		expect(document.querySelector('[role="status"]')?.textContent).toContain("Waiting for omp");
		await act(async () => pending.resolve(listing));
		expect(document.querySelector('[role="menu"]')).toBeNull();
	});
	it("keeps a refused change in the menu with omp's refusal and the current selection", async () => {
		fake.pin.mockRejectedValue(new Error("Wait for omp to finish replying before choosing an account."));
		await render(); await open(); await act(async () => options()[1]!.click());
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("finish replying");
		expect(options()[0]?.getAttribute("aria-checked")).toBe("true");
	});
	it("disables the trigger for read-only chats", async () => {
		fake.readOnly = true; await render(); expect(trigger().disabled).toBe(true);
	});
});
