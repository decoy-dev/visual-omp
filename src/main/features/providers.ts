/**
 * `providers:*` channels: which model providers omp can use. Contract and data sources:
 * `src/shared/contracts/providers.ts`.
 *
 * visual-omp never signs in by itself: the renderer runs `omp login [provider]` in a terminal, and
 * omp handles the browser, pasted codes, API keys and multiple accounts. This module only reads
 * status, deletes stored credentials through `omp auth-broker logout`, and forgets its caches when
 * a sign-in finishes.
 *
 * Chats that are already open keep the credentials and model list their omp loaded at start; they
 * see a change after `/restart`.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { ModelKind } from "@shared/contracts/config";
import type {
	ConnectedProvider,
	DisabledProviderAccount,
	LoginMethod,
	ProviderAccount,
	ProvidersState,
} from "@shared/contracts/providers";
import { userEnv } from "../env";
import { broadcast, handle } from "../ipc";
import { runOmp } from "../omp/cli";
import { NEUTRAL_CWD } from "../omp/config-file";
import { ompPath } from "../omp/locate";
import { ompErrorMessage, UsageJsonSchema } from "../services/omp-config";
import { configWritten, listModels } from "./config";

// ─── Sign-in list (`get_login_providers`) ──────────────────────────────────

/** Flags that keep the listing process light; extensions stay on because they can add providers. */
const RPC_ARGS = ["--mode", "rpc", "--no-session", "--no-lsp", "--no-title", "--no-tools", "--no-skills", "--no-rules"];
const LIST_TIMEOUT_MS = 30_000;

const RpcResponseSchema = z
	.object({ type: z.literal("response"), id: z.string(), success: z.boolean(), error: z.string().optional(), data: z.unknown().optional() })
	.loose();
const LoginProvidersSchema = z.object({
	providers: z.array(z.object({ id: z.string(), name: z.string(), available: z.boolean().optional(), authenticated: z.boolean().optional() }).loose()),
});

interface OmpLoginProvider {
	method: LoginMethod;
	/** omp has a credential for it (stored, environment or config). */
	authenticated: boolean;
}

/**
 * The entries omp's `/login` offers, read with one `get_login_providers` request to a short-lived
 * `omp --mode rpc` process. Read-only: nothing is sent that signs in or changes credentials.
 */
async function readLoginProviders(folder: string): Promise<OmpLoginProvider[]> {
	const [bin, env] = await Promise.all([ompPath(), userEnv()]);
	const child: ChildProcessWithoutNullStreams = spawn(bin, RPC_ARGS, { cwd: folder, env: { ...env, NO_COLOR: "1" }, stdio: "pipe" });
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	const timer = setTimeout(() => reject(new Error("omp did not list its sign-in providers in time.")), LIST_TIMEOUT_MS);
	child.stderr.resume();
	child.stdin.on("error", () => {});
	child.on("error", reject);
	child.on("exit", () => reject(new Error("omp stopped before listing its sign-in providers.")));
	createInterface({ input: child.stdout }).on("line", line => {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		const response = RpcResponseSchema.safeParse(message);
		if (!response.success || response.data.id !== "vomp-login-providers") return;
		if (response.data.success) resolve(response.data.data);
		else reject(new Error(response.data.error ?? "omp did not list its sign-in providers."));
	});
	child.stdin.write(`${JSON.stringify({ id: "vomp-login-providers", type: "get_login_providers" })}\n`);
	try {
		return LoginProvidersSchema.parse(await promise).providers.flatMap(provider =>
			provider.available === false
				? []
				: [
						{ method: { id: provider.id, name: provider.name }, authenticated: provider.authenticated === true },
					],
		);
	} finally {
		clearTimeout(timer);
		child.kill();
	}
}

/** Per project folder: project extensions can add sign-in entries. */
const loginProvidersCache = new Map<string, Promise<OmpLoginProvider[]>>();

function loginProviders(folder: string): Promise<OmpLoginProvider[]> {
	let pending = loginProvidersCache.get(folder);
	if (!pending) {
		const started = readLoginProviders(folder);
		pending = started;
		loginProvidersCache.set(folder, started);
		started.catch(() => {
			if (loginProvidersCache.get(folder) === started) loginProvidersCache.delete(folder);
		});
	}
	return pending;
}

// ─── Provider state ────────────────────────────────────────────────────────

/** omp records its own sign-out as a disabled credential; that is not something to fix. */
const SIGNED_OUT_CAUSE = /^(logged out by user|deleted by user|replaced by)/i;

const stateCache = new Map<string, Promise<ProvidersState>>();

async function readState(folder: string): Promise<ProvidersState> {
	const [models, usageResult, logins] = await Promise.all([
		listModels(folder),
		runOmp(["usage", "--json"], { cwd: folder, timeoutMs: 60_000 }),
		loginProviders(folder),
	]);
	if (usageResult.code !== 0) throw new Error(ompErrorMessage(usageResult.stderr, `omp usage exited with ${usageResult.code}`));
	const usage = UsageJsonSchema.parse(JSON.parse(usageResult.stdout));

	const byProvider = new Map<string, { count: number; kinds: ModelKind[] }>();
	for (const model of models) {
		const entry = byProvider.get(model.provider) ?? { count: 0, kinds: [] };
		entry.count++;
		if (!entry.kinds.includes(model.kind)) entry.kinds.push(model.kind);
		byProvider.set(model.provider, entry);
	}
	const accounts = new Map<string, ProviderAccount[]>();
	const addAccount = (provider: string, account: ProviderAccount) => accounts.set(provider, [...(accounts.get(provider) ?? []), account]);
	for (const report of usage.reports) {
		addAccount(report.provider, { email: report.metadata?.email ?? null, accountId: report.metadata?.accountId ?? null, orgName: report.metadata?.orgName ?? null });
	}
	for (const account of usage.accountsWithoutUsage) {
		addAccount(account.provider, { email: account.email ?? null, accountId: account.accountId ?? null, orgName: account.orgName ?? null });
	}
	const disabled = new Map<string, DisabledProviderAccount[]>();
	for (const entry of usage.disabledCredentials) {
		if (SIGNED_OUT_CAUSE.test(entry.cause)) continue;
		disabled.set(entry.provider, [
			...(disabled.get(entry.provider) ?? []),
			{ email: entry.email ?? null, accountId: entry.accountId ?? null, cause: entry.cause, disabledAt: entry.disabledAtMs ?? null },
		]);
	}

	// A provider is connected when omp lists its models, reports accounts for it, or says its
	// `/login` entry has a credential. Only ids omp reports are used; nothing is mapped or guessed.
	const ids = new Set<string>([...byProvider.keys(), ...accounts.keys(), ...disabled.keys()]);
	for (const login of logins) if (login.authenticated) ids.add(login.method.id);

	const connected: ConnectedProvider[] = [...ids].map(id => {
		const login = logins.find(entry => entry.method.id === id);
		const providerAccounts = accounts.get(id) ?? [];
		const providerDisabled = disabled.get(id) ?? [];
		return {
			id,
			name: login?.method.name ?? id,
			modelCount: byProvider.get(id)?.count ?? 0,
			kinds: byProvider.get(id)?.kinds ?? [],
			accounts: providerAccounts,
			disabledAccounts: providerDisabled,
			login: login?.method ?? null,
			authenticated: login?.authenticated === true,
			canSignOut: providerAccounts.length > 0 || providerDisabled.length > 0,
		} satisfies ConnectedProvider;
	});
	// Rows that need attention first, then signed-in ones, then the rest by name.
	const rank = (provider: ConnectedProvider) =>
		provider.disabledAccounts.length > 0 ? 0 : provider.accounts.length > 0 ? 1 : provider.authenticated ? 2 : 3;
	connected.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

	const available: LoginMethod[] = logins.filter(login => !ids.has(login.method.id)).map(login => login.method);
	available.sort((a, b) => a.name.localeCompare(b.name));
	return { connected, available };
}

/**
 * The one folder every omp call for a Settings view runs in: the selected project, or the same
 * neutral folder the other `config:*` reads use. Discovery, reads, caches, sign-in and sign-out all
 * use it, so they see the same extensions and `.env` files.
 */
function effectiveCwd(cwd: string | undefined): string {
	return cwd ?? NEUTRAL_CWD;
}

function providersState(folder: string, refresh: boolean): Promise<ProvidersState> {
	if (refresh) invalidate();
	let pending = stateCache.get(folder);
	if (!pending) {
		pending = readState(folder);
		stateCache.set(folder, pending);
		pending.catch(() => {
			if (stateCache.get(folder) === pending) stateCache.delete(folder);
		});
	}
	return pending;
}

/** Credentials changed: forget every cached view of them (models, sign-in list, provider state). */
function invalidate(): void {
	configWritten();
	loginProvidersCache.clear();
	stateCache.clear();
}

function credentialsChanged(providerId: string | null): void {
	invalidate();
	broadcast("providers:changed", { providerId });
}

// ─── Sign-out and sign-in command ──────────────────────────────────────────

const PROVIDER_ID = /^[A-Za-z0-9][\w.-]*$/;

async function logout(providerId: string, folder: string): Promise<void> {
	if (!PROVIDER_ID.test(providerId)) throw new Error(`Invalid provider id: ${providerId}`);
	const result = await runOmp(["auth-broker", "logout", providerId], { cwd: folder, timeoutMs: 30_000 });
	if (result.code !== 0) throw new Error(ompErrorMessage(result.stderr, `omp auth-broker logout exited with ${result.code}`));
	credentialsChanged(providerId);
}

/**
 * `omp login [method]` for the platform shell the terminal runs (`-lc` on macOS/Linux, PowerShell on
 * Windows), with the folder to run it in, so the renderer never picks a different one.
 */
async function loginCommand(methodId: string | undefined, folder: string): Promise<{ command: string; cwd: string }> {
	if (methodId !== undefined && !PROVIDER_ID.test(methodId)) throw new Error(`Invalid provider id: ${methodId}`);
	const bin = await ompPath();
	const args = methodId ? ` login ${methodId}` : " login";
	const command = process.platform === "win32" ? `& '${bin.replaceAll("'", "''")}'${args}` : `'${bin.replaceAll("'", "'\\''")}'${args}`;
	return { command, cwd: folder };
}

// ─── IPC ───────────────────────────────────────────────────────────────────

export function register(): void {
	handle("providers:list", (cwd, refresh) => providersState(effectiveCwd(cwd), refresh === true));
	handle("providers:logout", (providerId, cwd) => logout(providerId, effectiveCwd(cwd)));
	handle("providers:loginCommand", (methodId, cwd) => loginCommand(methodId, effectiveCwd(cwd)));
	handle("providers:invalidate", () => credentialsChanged(null));
}
