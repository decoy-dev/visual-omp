import { describe, expect, it, vi } from "vitest";
import { SessionAccountsSchema } from "@shared/contracts/native";
import { sessionAccountSnapshot } from "./native-accounts";

function context() {
	const accounts = vi.fn(() => [
		{ credentialId: 7, email: "same@example.com", orgName: "Personal", active: false, access: "secret-access", refresh: "secret-refresh" },
		{ credentialId: 9, email: "same@example.com", orgName: "Work", active: true },
	]);
	return { ctx: { model: { provider: "anthropic" }, modelRegistry: { authStorage: { oauth: { accounts } } }, sessionManager: { getSessionId: () => "session" } }, accounts };
}

describe("hosted account identity metadata", () => {
	it("uses omp's current provider and session, retains billing scope and never serializes credentials", () => {
		const { ctx, accounts } = context();
		expect(sessionAccountSnapshot(ctx)).toEqual({ provider: "anthropic", sessionId: "session", accounts: [
			{ credentialId: 7, label: "same@example.com (Personal)", active: false },
			{ credentialId: 9, label: "same@example.com (Work)", active: true },
		] });
		expect(accounts).toHaveBeenCalledExactlyOnceWith("anthropic", "session");
		expect(JSON.stringify(sessionAccountSnapshot(ctx))).not.toMatch(/secret|access|refresh/);
	});
	it("follows account rotation and model-provider changes without preserving another provider's selection", () => {
		const { ctx, accounts } = context();
		ctx.model.provider = "openai-codex";
		accounts.mockReturnValue([{ credentialId: 12, email: "codex@example.com", orgName: "", active: true }]);
		expect(sessionAccountSnapshot(ctx)).toMatchObject({ provider: "openai-codex", accounts: [{ credentialId: 12, active: true }] });
	});
	it("preserves unknown active selection and omp's identity fallback names", () => {
		const ctx = { model: { provider: "custom" }, modelRegistry: { authStorage: { oauth: { accounts: () => [
			{ credentialId: 1, accountId: "account-one", orgId: "org-one", active: false },
			{ credentialId: 2, projectId: "project-two", active: false },
			{ credentialId: 3, enterpriseUrl: " https://enterprise.example ", active: false },
			{ credentialId: 4, active: false },
		] } } }, sessionManager: { getSessionId: () => "session" } };
		expect(sessionAccountSnapshot(ctx)?.accounts.map(account => account.label)).toEqual(["account-one (org-one)", "project-two", "https://enterprise.example", "OAuth credential #4"]);
		expect(sessionAccountSnapshot(ctx)?.accounts.some(account => account.active)).toBe(false);
	});
	it("does not interrupt mode publication when account metadata is unavailable or too large", () => {
		const { ctx, accounts } = context();
		expect(sessionAccountSnapshot({ sessionManager: ctx.sessionManager })).toBeNull();
		accounts.mockImplementation(() => { throw new Error("store unavailable"); });
		expect(sessionAccountSnapshot(ctx)).toBeNull();
		accounts.mockReturnValue([{ credentialId: 7, email: "a".repeat(16000), orgName: "", active: false }]);
		expect(sessionAccountSnapshot(ctx)).toBeNull();
	});
	it("strips unknown fields again at the IPC schema and refuses invalid credential ids", () => {
		const value = { provider: "anthropic", sessionId: "session", token: "secret", accounts: [{ credentialId: 7, label: "Account", active: true, token: "secret" }] };
		expect(JSON.stringify(SessionAccountsSchema.parse(value))).not.toContain("secret");
		for (const credentialId of [-1, 1.1, "7", Number.MAX_SAFE_INTEGER + 1]) expect(SessionAccountsSchema.safeParse({ ...value, accounts: [{ ...value.accounts[0], credentialId }] }).success).toBe(false);
	});
});
