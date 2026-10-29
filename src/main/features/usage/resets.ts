/** Saved resets are listed and spent by omp's CLI; the app never reads credentials or calls providers. */
import { homedir } from "node:os";
import type { UsageResetListing, UsageResetOutcome, UsageResetTarget } from "@shared/contracts/usage";
import { runOmp } from "../../omp/cli";
import { parseResetListing } from "./parse";

const LIST_TIMEOUT_MS = 45_000;
const SPEND_TIMEOUT_MS = 90_000;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/;
const spending = new Set<string>();

export async function listResetAccounts(): Promise<UsageResetListing> {
	const result = await runOmp(["usage", "reset", "--json"], { cwd: homedir(), timeoutMs: LIST_TIMEOUT_MS });
	if (result.code !== 0) throw new Error(result.stderr.trim() || `omp could not list saved resets (exit code ${result.code}).`);
	let value: unknown;
	try {
		value = JSON.parse(result.stdout);
	} catch {
		return { readable: false, accounts: [] };
	}
	return parseResetListing(value);
}

/** Never retry a spend: interruption can happen after the provider has accepted it. */
export async function spendReset(target: UsageResetTarget): Promise<UsageResetOutcome> {
	if (typeof target?.provider !== "string" || !PROVIDER_ID.test(target.provider) || !Number.isSafeInteger(target.credentialId) || target.credentialId < 0) {
		throw new Error("This account can't be identified for omp.");
	}
	const key = `${target.provider}/${target.credentialId}`;
	if (spending.has(key)) throw new Error("omp is already spending a reset for this account. Wait for its answer before trying again.");
	spending.add(key);
	try {
		const result = await runOmp(["usage", "reset", key], { cwd: homedir(), timeoutMs: SPEND_TIMEOUT_MS });
		return { output: [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n"), confirmed: result.code === 0, exitCode: result.code };
	} finally {
		spending.delete(key);
	}
}
