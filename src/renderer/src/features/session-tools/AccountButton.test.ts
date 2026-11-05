// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionAccounts } from "@shared/contracts/native";
import type { SessionController } from "../../state/session";
import "../../i18n";
import { TooltipProvider } from "../../ui/Tooltip";
import { AccountButton } from "./AccountButton";

const fake = vi.hoisted(() => ({ listing: null as SessionAccounts | null, working: false, readOnly: false, pin: vi.fn() }));
vi.mock("./accounts", () => ({ useSessionAccounts: () => fake.listing, pinSessionAccount: (...args: unknown[]) => fake.pin(...args) }));
vi.mock("./status", () => ({ useSessionView: () => ({ working: fake.working, readOnly: fake.readOnly, host: { hostId: "host", generation: 1 } }) }));
// Hoisted UI mock factories must import their actual primitives after mocks initialize.
vi.mock("@/ui", async () => ({
	...await import("../../ui/Menu"), ...await import("../../ui/Tooltip"),
	...await import("../../ui/Spinner"), ...await import("../../ui/cn"),
}));
let root: Root;
let element: HTMLDivElement;
const session = { tabId: "chat" } as SessionController;
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
