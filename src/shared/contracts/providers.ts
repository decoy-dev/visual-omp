/**
 * `providers:*` channels: which model providers omp can use.
 *
 * Sources (omp 18.15+), all read outside projects with extension discovery disabled:
 * - Built-in sign-in entries: `get_login_providers` over `omp --mode rpc`, read only.
 * - Accounts and credentials omp disabled: `omp usage --json`.
 * - Stored accounts: safe `get_logout_accounts` metadata over RPC (omp 18.16+).
 * - Usable models: `omp models --json --kind all`.
 *
 * Signing in is omp's own: the renderer runs `providers:loginCommand`
 * (`omp login [provider]`) in a terminal, and omp handles the browser, codes, API keys and extra
 * accounts. Sign-out rechecks one stored account with `get_logout_accounts`, then sends omp's
 * `logout` RPC with its provider and credential id. Credential contents never cross IPC.
 */
import type { ModelKind } from "./config";

export interface ProviderAccount {
	email: string | null;
	accountId: string | null;
	/** Organization/workspace the credential is scoped to. */
	orgName: string | null;
}

/** Safe account metadata from omp's own logout listing, without credential contents. */
export interface StoredProviderAccount {
	credentialId: number;
	provider: string;
	/** omp includes the organization when accounts share an email. */
	label: string;
	detail: string;
	type: "api_key" | "oauth";
	active: boolean;
}

export interface DisabledProviderAccount {
	email: string | null;
	accountId: string | null;
	/** Why omp disabled it (e.g. expired grant); the user must sign in again. */
	cause: string;
	/** Epoch ms; null when unknown. */
	disabledAt: number | null;
}

/** One built-in entry of omp's `/login` list. */
export interface LoginMethod {
	/** Id passed to `omp login`. */
	id: string;
	name: string;
}

/**
 * A model provider omp can use or has credentials for. Everything here is what the installed omp
 * reports; details it does not report (which variable or config file supplies a key) are left out.
 */
export interface ConnectedProvider {
	/** Model provider id (`provider` of `provider/model`), as omp reports it. */
	id: string;
	/** omp's `/login` name when it has one, else the id. */
	name: string;
	modelCount: number;
	kinds: ModelKind[];
	/** Signed-in accounts from `omp usage`. */
	accounts: ProviderAccount[];
	/** Credentials omp stopped using; each needs a new sign-in. */
	disabledAccounts: DisabledProviderAccount[];
	/** omp's `/login` entry with the same id; null when omp lists none. */
	login: LoginMethod | null;
	/** omp reports authentication through its login list or stored-account listing. */
	authenticated: boolean;
	/** Stored accounts omp can remove individually. Empty when its listing is unavailable. */
	storedAccounts: StoredProviderAccount[];
}

export interface ProvidersState {
	connected: ConnectedProvider[];
	/** omp's `/login` entries for providers not connected yet. */
	available: LoginMethod[];
}

export interface ProvidersChangedEvent {
	/** Model provider whose credentials changed; null when unknown (a terminal sign-in). */
	providerId: string | null;
}

declare module "../ipc" {
	interface IpcInvokeMap {
		/**
		 * Connected and available providers, read outside projects with extension discovery disabled;
		 * cached globally in main. `refresh` re-reads omp.
		 */
		"providers:list": { args: [refresh?: boolean]; result: ProvidersState };
		/** Recheck and remove one exact stored account through omp RPC, outside projects. */
		"providers:logout": { args: [account: StoredProviderAccount]; result: void };
		/**
		 * omp's own sign-in, `omp login <method>` (or its picker without one), plus the folder main
		 * resolved for `cwd`. This explicit terminal action can load project extensions.
		 */
		"providers:loginCommand": { args: [methodId?: string, cwd?: string]; result: { command: string; cwd: string } };
		/** A terminal sign-in ended: drop cached providers and models and tell every window. */
		"providers:invalidate": { args: []; result: void };
		/** Export sign-ins outside projects to a chosen JSON file with mode 0600 where supported. False when cancelled. */
		"providers:export": { args: []; result: boolean };
		/** Import outside projects through omp's merge command. No credential content crosses IPC. */
		"providers:import": { args: []; result: boolean };
	}

	interface IpcEventMap {
		/** Credentials changed: re-read providers and models. */
		"providers:changed": ProvidersChangedEvent;
	}
}
