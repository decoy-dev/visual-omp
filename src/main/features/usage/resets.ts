/**
 * Saved rate-limit resets through omp's own `/usage reset` builtin. omp has no CLI or RPC request
 * for them, but its RPC mode runs builtin slash commands sent as a `prompt` and sends what they print
 * as `command_output` events. A short-lived `omp --mode rpc --no-session` process therefore lists the
 * accounts (`/usage reset`) and spends one (`/usage reset <provider>/<credential id>`), with omp
 * reading and redeeming the credits itself; the app never calls a provider or reads a credential.
 */
import { homedir } from "node:os";
import type { UsageResetListing, UsageResetOutcome, UsageResetTarget } from "@shared/contracts/usage";
import { rpcRequest } from "../../omp/rpc";
import { parseResetListing } from "./parse";

/** omp in RPC mode without a session file, project rules, tools, skills, extensions or language servers. */
const RESET_RPC_FLAGS = ["--no-session", "--no-lsp", "--no-title", "--no-tools", "--no-skills", "--no-rules", "--no-extensions"];
/** omp gives each provider listing 10 s; a redeem makes several provider calls. */
const LIST_TIMEOUT_MS = 45_000;
const SPEND_TIMEOUT_MS = 90_000;

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/;
/** omp's reply when it could not read the credentials at all. */
const LOAD_FAILED = /^Could not load saved resets:/;

/** Spends running now, by `provider/credentialId`. */
const spending = new Set<string>();

/**
 * Runs one builtin slash line in a short-lived omp. Resolves with what omp printed and, when omp did
 * not answer (timeout, exit, failure), the reason; the output printed before that is kept.
 */
async function runBuiltin(line: string, timeoutMs: number, what: string): Promise<{ output: string; failure: unknown }> {
	const printed: string[] = [];
	let failure: unknown = null;
	try {
		await rpcRequest(
			homedir(),
			"prompt",
			{
				flags: RESET_RPC_FLAGS,
				timeoutMs,
				messages: { timeout: `omp did not ${what} in time.`, exited: `omp stopped before it finished.`, failed: `omp could not ${what}.` },
				onMessage: message => {
					if (typeof message !== "object" || message === null) return;
					const { type, text } = message as { type?: unknown; text?: unknown };
					if (type === "command_output" && typeof text === "string") printed.push(text);
				},
			},
			{ message: line },
		);
	} catch (error) {
		failure = error;
	}
	return { output: printed.join("\n").trim(), failure };
}

export async function listResetAccounts(): Promise<UsageResetListing> {
	const { output, failure } = await runBuiltin("/usage reset", LIST_TIMEOUT_MS, "list saved resets");
	if (failure !== null) throw failure;
	if (LOAD_FAILED.test(output)) throw new Error(output);
	return parseResetListing(output);
}

/**
 * Spends one saved reset. Once the command was handed to omp, every ending other than omp's printed
 * answer is unconfirmed: the reset may already be spent, so nothing here retries it.
 */
export async function spendReset(target: UsageResetTarget): Promise<UsageResetOutcome> {
	// The target goes into a prompt line; anything else could reach omp as another command or a message to a model.
	if (typeof target?.provider !== "string" || !PROVIDER_ID.test(target.provider) || !Number.isSafeInteger(target.credentialId) || target.credentialId < 0) {
		throw new Error("This account can't be identified for omp.");
	}
	const key = `${target.provider}/${target.credentialId}`;
	// Another window or a reopened dialog could ask again while the first spend runs.
	if (spending.has(key)) throw new Error("omp is already spending a reset for this account. Wait for its answer before trying again.");
	spending.add(key);
	try {
		const { output, failure } = await runBuiltin(`/usage reset ${key}`, SPEND_TIMEOUT_MS, "answer");
		return { output, confirmed: failure === null && output !== "" };
	} finally {
		spending.delete(key);
	}
}
