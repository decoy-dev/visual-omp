import { describe, expect, it, vi } from "vitest";
import type { UsageResetAccount, UsageResetListing, UsageResetOutcome } from "@shared/contracts/usage";
import { matchResetAccount, ResetFlow, type ResetFlowDeps } from "./resets";

const entry = (provider: string, credentialId: number, label: string): UsageResetAccount => {
	const [email, orgName] = label.split(" · ");
	return { provider, credentialId, label, email, orgName, savedCount: 1, usableCount: 1, expiresAt: null, unavailable: null };
};

describe("matchResetAccount", () => {
	const listing = [
		entry("openai-codex", 4, "me@example.com · self_serve_business_prolite"),
		entry("anthropic", 6, "me@example.com · Team A"),
		entry("anthropic", 7, "me@example.com · Team B"),
		entry("anthropic", 9, "other@example.com"),
	];

	it("picks the one entry with the report's email and organization", () => {
		expect(matchResetAccount(listing, "anthropic", { email: "me@example.com", orgName: "Team B", orgId: "org-b" })?.credentialId).toBe(7);
		expect(matchResetAccount(listing, "openai-codex", { email: "Me@Example.com", orgName: "self_serve_business_prolite" })?.credentialId).toBe(4);
		expect(matchResetAccount(listing, "anthropic", { email: "other@example.com" })?.credentialId).toBe(9);
	});

	it("refuses when the organization contradicts or only one side names one", () => {
		expect(matchResetAccount(listing, "anthropic", { email: "me@example.com", orgName: "Team C" })).toBeNull();
		expect(matchResetAccount(listing, "anthropic", { email: "other@example.com", orgName: "Renamed" })).toBeNull();
		expect(matchResetAccount(listing, "anthropic", { email: "me@example.com" })).toBeNull();
	});

	it("never falls back to the provider's only account when the identity differs", () => {
		// A stale report for account A while omp now lists only account B.
		expect(matchResetAccount([entry("openai-codex", 4, "b@example.com")], "openai-codex", { email: "a@example.com" })).toBeNull();
		expect(matchResetAccount(listing, "openai-codex", { accountId: "acc-1" })).toBeNull();
		expect(matchResetAccount(listing, "anthropic", {})).toBeNull();
	});

	it("refuses two entries with the same identity", () => {
		expect(matchResetAccount([entry("anthropic", 1, "me@example.com · Team A"), entry("anthropic", 2, "me@example.com · Team A")], "anthropic", { email: "me@example.com", orgName: "Team A" })).toBeNull();
	});

	it("matches structured ids independently of display punctuation and renamed labels", () => {
		const structured = { ...entry("anthropic", 3, "Display only"), accountId: "acc-3", orgId: "org-3", orgName: "Team · Europe" };
		expect(matchResetAccount([structured], "anthropic", { accountId: "acc-3", orgId: "org-3", orgName: "Renamed team" })?.credentialId).toBe(3);
		expect(matchResetAccount([structured], "anthropic", { accountId: "other", email: "Display only", orgId: "org-3" })).toBeNull();
	});
});

describe("ResetFlow", () => {
	const codex = entry("openai-codex", 4, "me@example.com · Org 1");
	const readable = (accounts: UsageResetAccount[]): UsageResetListing => ({ readable: true, accounts });
	const identity = { email: "me@example.com", orgName: "Org 1" };

	function setup(patch: Partial<ResetFlowDeps> = {}) {
		const deps = {
			list: vi.fn(async () => readable([codex])),
			spend: vi.fn(async (): Promise<UsageResetOutcome> => ({ output: "Reset applied.", confirmed: true })),
			refresh: vi.fn(async (): Promise<string | null> => null),
			...patch,
		};
		return { deps, flow: new ResetFlow(deps) };
	}

	it("finds the account, spends it once and reports a refreshed outcome", async () => {
		const { deps, flow } = setup();
		flow.check("openai-codex", identity);
		await vi.waitFor(() => expect(flow.snapshot().kind).toBe("ready"));
		await flow.spend();
		expect(deps.spend).toHaveBeenCalledExactlyOnceWith({ provider: "openai-codex", credentialId: 4 });
		expect(flow.snapshot()).toEqual({ kind: "spent", entry: codex, outcome: { output: "Reset applied.", confirmed: true }, error: null, refresh: { kind: "done" } });
	});

	it("keeps the confirmed target and spending state when the page rebuilds the account mid-spend", async () => {
		const { promise: answer, resolve } = Promise.withResolvers<UsageResetOutcome>();
		const { deps, flow } = setup({ spend: vi.fn(() => answer) });
		flow.check("openai-codex", identity);
		await vi.waitFor(() => expect(flow.snapshot().kind).toBe("ready"));
		const spending = flow.spend();
		// A poll replaced the account props: the dialog checks again, with another identity.
		flow.check("anthropic", { email: "else@example.com" });
		flow.close();
		expect(flow.snapshot()).toEqual({ kind: "spending", entry: codex });
		expect(deps.list).toHaveBeenCalledTimes(1);
		resolve({ output: "", confirmed: false });
		await spending;
		expect(flow.snapshot()).toMatchObject({ kind: "spent", entry: codex, outcome: { confirmed: false } });
		await flow.spend();
		expect(deps.spend).toHaveBeenCalledTimes(1);
	});

	it("drops a listing that answers after a spend started or the dialog closed", async () => {
		const { promise: late, resolve } = Promise.withResolvers<UsageResetListing>();
		const { flow } = setup({ list: vi.fn(() => late) });
		flow.check("openai-codex", identity);
		flow.close();
		resolve(readable([codex]));
		await late;
		expect(flow.snapshot()).toEqual({ kind: "idle" });
	});

	it("disables spending for an unreadable listing or an unmatched account", async () => {
		const unreadable = setup({ list: vi.fn(async () => ({ readable: false, accounts: [] })) });
		unreadable.flow.check("openai-codex", identity);
		await vi.waitFor(() => expect(unreadable.flow.snapshot().kind).toBe("unreadable"));
		await unreadable.flow.spend();
		const unmatched = setup({ list: vi.fn(async () => readable([entry("openai-codex", 5, "b@example.com")])) });
		unmatched.flow.check("openai-codex", identity);
		await vi.waitFor(() => expect(unmatched.flow.snapshot().kind).toBe("unmatched"));
		await unmatched.flow.spend();
		expect(unreadable.deps.spend).not.toHaveBeenCalled();
		expect(unmatched.deps.spend).not.toHaveBeenCalled();
	});

	it("reports a failed refresh and refreshes again on request, without spending again", async () => {
		const refresh = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce("omp timed out").mockResolvedValueOnce(null);
		const { deps, flow } = setup({ refresh });
		flow.check("openai-codex", identity);
		await vi.waitFor(() => expect(flow.snapshot().kind).toBe("ready"));
		await flow.spend();
		expect(flow.snapshot()).toMatchObject({ kind: "spent", refresh: { kind: "failed", error: "omp timed out" } });
		await flow.refreshLimits();
		expect(flow.snapshot()).toMatchObject({ kind: "spent", refresh: { kind: "done" } });
		expect(deps.spend).toHaveBeenCalledTimes(1);
	});

	it("shows main's refusal and still refreshes", async () => {
		const { deps, flow } = setup({ spend: vi.fn(async () => Promise.reject(new Error("Error invoking remote method 'usage:spendReset': Error: omp is already spending a reset for this account."))) });
		flow.check("openai-codex", identity);
		await vi.waitFor(() => expect(flow.snapshot().kind).toBe("ready"));
		await flow.spend();
		expect(flow.snapshot()).toMatchObject({ kind: "spent", outcome: null, error: "omp is already spending a reset for this account." });
		expect(deps.refresh).toHaveBeenCalledTimes(1);
	});
});
