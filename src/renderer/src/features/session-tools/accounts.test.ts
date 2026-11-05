// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { NativeSnapshot, SessionAccounts } from "@shared/contracts/native";
import type { SessionController, SessionView } from "../../state/session";
import "../../i18n";
import { currentSessionAccounts, pinSessionAccount } from "./accounts";

const fake = vi.hoisted(() => ({ ready: vi.fn(), invoke: vi.fn(), now: 0 }));
vi.mock("./drive", () => ({ readyEditor: (...args: unknown[]) => fake.ready(...args), sleep: async (ms: number) => { fake.now += ms; } }));
const listing: SessionAccounts = { provider: "anthropic", sessionId: "session", accounts: [
	{ credentialId: 7, label: "first@example.com", active: true },
	{ credentialId: 12, label: "second@example.com", active: false },
] };
let view: SessionView;
let session: SessionController;
let command: Mock;
function native(accounts: SessionAccounts | null = listing): NativeSnapshot { return { modes: null, theme: null, sessionAccounts: accounts, asyncJobsGeneration: 3 }; }
function selected(): SessionAccounts { return { ...listing, accounts: listing.accounts.map(account => ({ ...account, active: account.credentialId === 12 })) }; }
beforeEach(() => {
	fake.now = 0; vi.spyOn(Date, "now").mockImplementation(() => fake.now);
	fake.ready.mockReset().mockResolvedValue([]); fake.invoke.mockReset().mockResolvedValue(native());
	Object.assign(window, { vomp: { invoke: fake.invoke } });
	view = { mode: "live", readOnly: false, working: false, host: { hostId: "host", generation: 3, sessionId: "session", transport: "tsp" }, guest: { state: { model: { provider: "anthropic", id: "model" } } } } as SessionView;
	command = vi.fn().mockResolvedValue(undefined);
	session = { getSnapshot: () => view, command } as unknown as SessionController;
});
afterEach(() => vi.restoreAllMocks());

describe("session account state", () => {
	it("retains unknown selection without guessing from the first row", () => {
		const unknown = { ...listing, accounts: listing.accounts.map(account => ({ ...account, active: false })) };
		expect(currentSessionAccounts(native(unknown), view)?.accounts.some(account => account.active)).toBe(false);
	});
	it("drops stale room, session, provider and saved-view metadata", () => {
		for (const value of [
			{ ...native(), asyncJobsGeneration: 2 },
			native({ ...listing, sessionId: "other" }), native({ ...listing, provider: "openai-codex" }), native(null),
		]) expect(currentSessionAccounts(value, view)).toBeNull();
		expect(currentSessionAccounts(native(), { ...view, mode: "history" })).toBeNull();
	});
	it.each(["classic", "tsp"] as const)("pins a stable credential identity in %s and waits for omp's active state", async transport => {
		view = { ...view, host: { ...view.host!, transport } };
		fake.invoke.mockResolvedValueOnce(native()).mockResolvedValueOnce(native(selected()));
		await expect(pinSessionAccount(session, listing, 12)).resolves.toEqual(selected());
		expect(command).toHaveBeenCalledExactlyOnceWith("/session pin OAuth credential #12", expect.any(Function));
		expect(fake.invoke).toHaveBeenCalledTimes(2);
		expect(fake.invoke).toHaveBeenCalledWith("native:snapshot", "host");
	});
	it("explains streaming refusal and never queues or submits a pin while replying", async () => {
		view = { ...view, working: true };
		await expect(pinSessionAccount(session, listing, 12)).rejects.toThrow("finish replying");
		expect(command).not.toHaveBeenCalled(); expect(fake.ready).not.toHaveBeenCalled();
	});
	it("rechecks busy state and model identity after waiting for the editor", async () => {
		fake.ready.mockImplementation(async () => { view = { ...view, working: true }; return []; });
		await expect(pinSessionAccount(session, listing, 12)).rejects.toThrow("finish replying");
		expect(command).not.toHaveBeenCalled();
		view = { ...view, working: false };
		fake.ready.mockImplementation(async () => { view = { ...view, guest: { ...view.guest!, state: { ...view.guest!.state!, model: { provider: "other", id: "model", name: "Model", contextWindow: null } } } }; return []; });
		await expect(pinSessionAccount(session, listing, 12)).rejects.toThrow("chat or model changed");
		expect(command).not.toHaveBeenCalled();
	});
	it("does not report success merely because omp accepted the command input", async () => {
		await expect(pinSessionAccount(session, listing, 12)).rejects.toThrow("did not confirm");
		expect(command).toHaveBeenCalledOnce();
	});
	it("rejects a late account result after the room changes", async () => {
		fake.invoke.mockImplementation(async () => { view = { ...view, host: { ...view.host!, generation: 4 } }; return native(selected()); });
		await expect(pinSessionAccount(session, listing, 12)).rejects.toThrow("chat or model changed");
	});
	it("refuses an account absent from the presented listing", async () => {
		await expect(pinSessionAccount(session, listing, 99)).rejects.toThrow("no longer available"); expect(command).not.toHaveBeenCalled();
	});
});
