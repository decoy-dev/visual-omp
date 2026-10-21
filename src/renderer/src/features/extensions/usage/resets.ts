import type { UsageResetAccount, UsageResetListing, UsageResetOutcome, UsageResetTarget } from "@shared/contracts/usage";
import { errorText } from "../format";
import type { AccountIdentity } from "./planUsage";

/**
 * The entry of omp's `/usage reset` listing for the account a usage report describes, or null unless
 * exactly one entry has the same identity. omp labels an entry from the stored credential as the
 * email (else the account id), then ` · ` and the organization name (else its id) when it has one.
 * The email or id must be the report's, and the organization must agree: both name the same one, or
 * neither names one. Nothing is inferred from how many accounts omp lists, because spending a reset
 * cannot be undone and a stale report could describe an account omp no longer holds.
 */
export function matchResetAccount(accounts: readonly UsageResetAccount[], provider: string, identity: AccountIdentity): UsageResetAccount | null {
	const base = identity.email ?? identity.accountId;
	if (!base) return null;
	const reportOrg = identity.orgName ?? identity.orgId;
	const matches = accounts.filter(entry => {
		if (entry.provider !== provider) return false;
		const split = entry.label.indexOf(" · ");
		const labelBase = split < 0 ? entry.label : entry.label.slice(0, split);
		const labelOrg = split < 0 ? undefined : entry.label.slice(split + 3);
		if (labelBase.toLowerCase() !== base.toLowerCase()) return false;
		if (labelOrg === undefined || reportOrg === undefined) return labelOrg === reportOrg;
		return labelOrg === identity.orgName || labelOrg === identity.orgId;
	});
	return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** Whether the limits refresh after a spend is running, finished, or failed and why. */
export type ResetRefresh = { kind: "running" } | { kind: "done" } | { kind: "failed"; error: string };

/** Where the Spend a reset dialog is. */
export type ResetPhase =
	| { kind: "idle" }
	| { kind: "checking" }
	| { kind: "failed"; error: string }
	/** omp printed a listing visual-omp could not read in full. */
	| { kind: "unreadable" }
	| { kind: "unmatched" }
	| { kind: "ready"; entry: UsageResetAccount }
	| { kind: "spending"; entry: UsageResetAccount }
	/** `outcome` is null when main refused the spend (`error`), so nothing was sent to omp. */
	| { kind: "spent"; entry: UsageResetAccount; outcome: UsageResetOutcome | null; error: string | null; refresh: ResetRefresh };

export interface ResetFlowDeps {
	list(): Promise<UsageResetListing>;
	spend(target: UsageResetTarget): Promise<UsageResetOutcome>;
	/** Refreshes the limits; resolves with why that failed, or null. */
	refresh(): Promise<string | null>;
}

/**
 * The Spend a reset dialog's steps, kept apart from React so a spend's target and state stay fixed
 * however often the page rebuilds the account while omp works: once a spend starts, re-checks are
 * ignored and a listing still running can no longer replace the confirmed entry.
 */
export class ResetFlow {
	#phase: ResetPhase = { kind: "idle" };
	/** Bumped by every check, spend and close, so a late listing answer is dropped. */
	#generation = 0;
	readonly #listeners = new Set<() => void>();

	readonly #deps: ResetFlowDeps;

	constructor(deps: ResetFlowDeps) {
		this.#deps = deps;
	}

	readonly snapshot = (): ResetPhase => this.#phase;

	readonly subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	#set(phase: ResetPhase): void {
		this.#phase = phase;
		for (const listener of this.#listeners) listener();
	}

	/** Reads omp's listing and finds this account in it; ignored while a spend runs or shows its answer. */
	check(provider: string, identity: AccountIdentity): void {
		if (this.#phase.kind === "spending" || this.#phase.kind === "spent") return;
		const generation = ++this.#generation;
		this.#set({ kind: "checking" });
		this.#deps.list().then(
			listing => {
				if (generation !== this.#generation) return;
				if (!listing.readable) return this.#set({ kind: "unreadable" });
				const entry = matchResetAccount(listing.accounts, provider, identity);
				this.#set(entry ? { kind: "ready", entry } : { kind: "unmatched" });
			},
			error => {
				if (generation === this.#generation) this.#set({ kind: "failed", error: errorText(error) });
			},
		);
	}

	/** Spends one reset of the entry the dialog confirmed, then refreshes the limits. Never retries. */
	async spend(): Promise<void> {
		const phase = this.#phase;
		if (phase.kind !== "ready") return;
		const { entry } = phase;
		this.#generation++;
		this.#set({ kind: "spending", entry });
		let outcome: UsageResetOutcome | null = null;
		let error: string | null = null;
		try {
			outcome = await this.#deps.spend({ provider: entry.provider, credentialId: entry.credentialId });
		} catch (err) {
			error = errorText(err);
		}
		this.#set({ kind: "spent", entry, outcome, error, refresh: { kind: "running" } });
		await this.refreshLimits();
	}

	/** Refreshes the limits after a spend ("Refresh limits" retries a failed refresh). */
	async refreshLimits(): Promise<void> {
		const phase = this.#phase;
		if (phase.kind !== "spent") return;
		this.#set({ ...phase, refresh: { kind: "running" } });
		const error = await this.#deps.refresh();
		const current = this.#phase;
		if (current.kind !== "spent" || current.entry !== phase.entry) return;
		this.#set({ ...current, refresh: error === null ? { kind: "done" } : { kind: "failed", error } });
	}

	/** The dialog closed. A spend still running keeps going and its answer shows when the dialog reopens. */
	close(): void {
		if (this.#phase.kind === "spending") return;
		this.#generation++;
		this.#set({ kind: "idle" });
	}
}
