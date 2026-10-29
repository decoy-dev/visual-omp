/**
 * `providers:*` channels: which model providers omp can use. Contract and data sources:
 * `src/shared/contracts/providers.ts`.
 *
 * visual-omp never signs in by itself: the renderer runs `omp login [provider]` in a terminal, and
 * omp handles the browser, pasted codes, API keys and multiple accounts. This module only reads
 * status, deletes stored credentials through `omp auth-broker logout`, transfers sign-ins through
 * `omp auth export` and `omp auth import`, and forgets caches when credentials change.
 *
 * Chats that are already open keep the credentials and model list their omp loaded at start; they
 * see a change after `/restart`.
 */
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import { z } from "zod";
import type { ModelKind } from "@shared/contracts/config";
import type {
	ConnectedProvider,
	DisabledProviderAccount,
	LoginMethod,
	ProviderAccount,
	ProvidersState,
} from "@shared/contracts/providers";
import { broadcast, handle } from "../ipc";
import { runOmp } from "../omp/cli";
import { NEUTRAL_CWD } from "../omp/config-file";
import { ompPath } from "../omp/locate";
import { rpcRequest } from "../omp/rpc";
import { ompErrorMessage, parseModels, UsageJsonSchema } from "../services/omp-config";
import { configWritten } from "./config";

// ─── Sign-in list (`get_login_providers`) ──────────────────────────────────

/** Discovery runs outside projects and never loads their extensions, skills, rules or context. */
const RPC_FLAGS = ["--no-session", "--no-lsp", "--no-title", "--no-tools", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files"];
const LIST_TIMEOUT_MS = 30_000;

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
async function readLoginProviders(): Promise<OmpLoginProvider[]> {
	const data = await rpcRequest(NEUTRAL_CWD, "get_login_providers", {
		flags: RPC_FLAGS,
		timeoutMs: LIST_TIMEOUT_MS,
		messages: {
			timeout: "omp did not list its sign-in providers in time.",
			exited: "omp stopped before listing its sign-in providers.",
			failed: "omp did not list its sign-in providers.",
		},
	});
	return LoginProvidersSchema.parse(data).providers.flatMap(provider =>
		provider.available === false
			? []
			: [{ method: { id: provider.id, name: provider.name }, authenticated: provider.authenticated === true }],
	);
}

/** The discovery process has no selected-project state. */
let loginProvidersCache: Promise<OmpLoginProvider[]> | null = null;

function loginProviders(): Promise<OmpLoginProvider[]> {
	if (!loginProvidersCache) {
		const started = readLoginProviders();
		loginProvidersCache = started;
		started.catch(() => {
			if (loginProvidersCache === started) loginProvidersCache = null;
		});
	}
	return loginProvidersCache;
}

// ─── Provider state ────────────────────────────────────────────────────────

/** omp records its own sign-out as a disabled credential; that is not something to fix. */
const SIGNED_OUT_CAUSE = /^(logged out by user|deleted by user|replaced by)/i;

let stateCache: Promise<ProvidersState> | null = null;

async function readState(): Promise<ProvidersState> {
	const [modelsResult, usageResult, logins] = await Promise.all([
		runOmp(["models", "--json", "--kind", "all", "--no-extensions"], { cwd: NEUTRAL_CWD, timeoutMs: 60_000 }),
		runOmp(["usage", "--json", "--no-extensions"], { cwd: NEUTRAL_CWD, timeoutMs: 60_000 }),
		loginProviders(),
	]);
	if (modelsResult.code !== 0) throw new Error(ompErrorMessage(modelsResult.stderr, `omp models exited with ${modelsResult.code}`));
	const models = parseModels(JSON.parse(modelsResult.stdout));
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

	// Alias logins inherit their base provider's authenticated flag, but RPC omits storeCredentialsAs.
	// Only independent model/account/credential evidence creates a row. All login methods remain
	// available for signing in; an authenticated alias alone must not create a duplicate provider.
	const ids = new Set<string>([...byProvider.keys(), ...accounts.keys(), ...disabled.keys()]);

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

/** Explicit terminal sign-in and sign-out retain their selected project folder. */
function effectiveCwd(cwd: string | undefined): string {
	return cwd ?? NEUTRAL_CWD;
}

function providersState(refresh: boolean): Promise<ProvidersState> {
	if (refresh) invalidate();
	if (!stateCache) {
		const started = readState();
		stateCache = started;
		started.catch(() => {
			if (stateCache === started) stateCache = null;
		});
	}
	return stateCache;
}

/** Credentials changed: forget every cached view of them (models, sign-in list, provider state). */
function invalidate(): void {
	configWritten();
	loginProvidersCache = null;
	stateCache = null;
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

/** Secret output stays in main and is never included in IPC replies, errors or logs. */
async function exportSignIns(): Promise<boolean> {
	const options: Electron.SaveDialogOptions = {
		title: "Export sign-ins",
		defaultPath: join(app.getPath("downloads"), "omp-sign-ins.json"),
		filters: [{ name: "omp sign-ins", extensions: ["json"] }],
		properties: ["createDirectory", "showOverwriteConfirmation"],
	};
	const win = BrowserWindow.getFocusedWindow();
	const choice = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
	if (choice.canceled || !choice.filePath) return false;
	const result = await runOmp(["auth", "export"], { cwd: NEUTRAL_CWD });
	if (result.code !== 0) throw new Error(`omp could not export sign-ins (exit code ${result.code}).`);
	// A private sibling directory keeps incomplete exports inaccessible. Rename replaces a selected
	// file or symlink with a new owner-only file instead of retaining its old permissions.
	const temporary = await mkdtemp(join(dirname(choice.filePath), ".visual-omp-auth-"));
	try {
		const file = join(temporary, "sign-ins.json");
		await writeFile(file, result.stdout, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(file, choice.filePath);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
	return true;
}

async function importSignIns(): Promise<boolean> {
	const options: Electron.OpenDialogOptions = {
		title: "Import sign-ins",
		filters: [{ name: "omp sign-ins", extensions: ["json"] }],
		properties: ["openFile"],
	};
	const win = BrowserWindow.getFocusedWindow();
	const choice = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
	const file = choice.filePaths[0];
	if (choice.canceled || !file) return false;
	// Let omp validate and merge the file. Its output can quote malformed credential fields, so
	// neither stream is returned to the renderer or used in an error message.
	const result = await runOmp(["auth", "import", file], { cwd: NEUTRAL_CWD });
	if (result.code !== 0) throw new Error(`omp could not import sign-ins (exit code ${result.code}).`);
	credentialsChanged(null);
	return true;
}

// ─── IPC ───────────────────────────────────────────────────────────────────

export function register(): void {
	handle("providers:list", refresh => providersState(refresh === true));
	handle("providers:logout", (providerId, cwd) => logout(providerId, effectiveCwd(cwd)));
	handle("providers:loginCommand", (methodId, cwd) => loginCommand(methodId, effectiveCwd(cwd)));
	handle("providers:invalidate", () => credentialsChanged(null));
	handle("providers:export", () => exportSignIns());
	handle("providers:import", () => importSignIns());
}
