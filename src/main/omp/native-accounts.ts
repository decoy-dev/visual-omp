import type { SessionAccounts } from "@shared/contracts/native";

interface AccountSummary {
	credentialId: number;
	email?: string;
	accountId?: string;
	projectId?: string;
	orgName?: string;
	orgId?: string;
	enterpriseUrl?: string;
	active: boolean;
}
interface AccountContext {
	model?: { provider: string };
	modelRegistry?: { authStorage?: {
		oauth?: { accounts(provider: string, sessionId: string): AccountSummary[] };
	} };
	sessionManager: { getSessionId(): string };
}

/** Public SDK identity summaries only. Never serialize credentials or resolve an access token. */
export function sessionAccountSnapshot(ctx: AccountContext): SessionAccounts | null {
	try {
		const provider = ctx.model?.provider;
		const storage = ctx.modelRegistry?.authStorage;
		if (!provider || !storage?.oauth) return null;
		const sessionId = ctx.sessionManager.getSessionId();
		const summaries = storage.oauth.accounts(provider, sessionId);
		const accounts = summaries.map(account => {
			// Match omp's formatActiveAccountLabel and toSessionPinAccounts, including billing scopes.
			const base = account.email || account.accountId || account.projectId;
			const org = account.orgName || account.orgId;
			const label = base ? org && org !== base ? `${base} (${org})` : base : account.enterpriseUrl?.trim() || `OAuth credential #${account.credentialId}`;
			return { credentialId: account.credentialId, label, active: account.active };
		});
		const result = { provider, sessionId, accounts };
		// Keep account metadata within its share of the existing 64 KiB bridge envelope.
		return JSON.stringify(result).length <= 16000 ? result : null;
	} catch {
		// Older SDKs and unavailable account stores must not interrupt modes or location updates.
		return null;
	}
}
