import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcRequestOptions } from "../../omp/rpc";
import { listResetAccounts, spendReset } from "./resets";

/** Each call's prompt line and options; `answer` decides how the fake omp ends the request. */
const fake = vi.hoisted(() => ({
	calls: [] as { line: string; options: RpcRequestOptions }[],
	answer: async (_options: RpcRequestOptions): Promise<unknown> => ({ agentInvoked: false }),
}));

vi.mock("../../omp/rpc", () => ({
	rpcRequest: (_folder: string, _type: string, options: RpcRequestOptions, params: { message: string }) => {
		fake.calls.push({ line: params.message, options });
		return fake.answer(options);
	},
}));

const print = (options: RpcRequestOptions, text: string) => options.onMessage?.({ type: "command_output", text });
const codex = { provider: "openai-codex", credentialId: 4 };

beforeEach(() => {
	fake.calls.length = 0;
});

describe("spendReset", () => {
	it("sends omp's target and confirms what omp printed before its response", async () => {
		fake.answer = async options => {
			print(options, "Reset applied for me@example.com (Codex).");
			return { agentInvoked: false };
		};
		await expect(spendReset(codex)).resolves.toEqual({ output: "Reset applied for me@example.com (Codex).", confirmed: true });
		expect(fake.calls.map(call => call.line)).toEqual(["/usage reset openai-codex/4"]);
	});

	it("keeps the output but leaves the outcome unconfirmed when omp times out, stops or prints nothing", async () => {
		for (const reason of ["omp did not answer in time.", "omp stopped before it finished."]) {
			fake.answer = async options => {
				print(options, "Spending…");
				throw new Error(reason);
			};
			await expect(spendReset(codex)).resolves.toEqual({ output: "Spending…", confirmed: false });
		}
		fake.answer = async () => ({ agentInvoked: false });
		await expect(spendReset(codex)).resolves.toEqual({ output: "", confirmed: false });
		// Nothing is retried by itself: one omp per call.
		expect(fake.calls).toHaveLength(3);
	});

	it("rejects a second spend for the same account while the first runs, and allows another account", async () => {
		const { promise: held, resolve: release } = Promise.withResolvers<unknown>();
		fake.answer = async options => {
			print(options, "Reset applied.");
			return held;
		};
		const first = spendReset(codex);
		await expect(spendReset(codex)).rejects.toThrow("already spending");
		const other = spendReset({ provider: "anthropic", credentialId: 6 });
		release({ agentInvoked: false });
		await expect(first).resolves.toMatchObject({ confirmed: true });
		await expect(other).resolves.toMatchObject({ confirmed: true });
		// Once the first answered, the account can be asked again.
		await expect(spendReset(codex)).resolves.toMatchObject({ confirmed: true });
		expect(fake.calls.map(call => call.line)).toEqual(["/usage reset openai-codex/4", "/usage reset anthropic/6", "/usage reset openai-codex/4"]);
	});

	it("frees the account again after an unconfirmed spend", async () => {
		fake.answer = async () => {
			throw new Error("omp stopped before it finished.");
		};
		await expect(spendReset(codex)).resolves.toMatchObject({ confirmed: false });
		await expect(spendReset(codex)).resolves.toMatchObject({ confirmed: false });
	});

	it("refuses a target that could reach omp as something other than this command", async () => {
		for (const target of [
			{ provider: "openai-codex reset", credentialId: 4 },
			{ provider: "anthropic", credentialId: 1.5 },
			{ provider: "anthropic", credentialId: -1 },
		]) {
			await expect(spendReset(target)).rejects.toThrow("can't be identified");
		}
		expect(fake.calls).toHaveLength(0);
	});
});

describe("listResetAccounts", () => {
	it("fails with omp's message when omp could not load the resets, and when omp did not answer", async () => {
		fake.answer = async options => {
			print(options, "Could not load saved resets: database locked");
			return { agentInvoked: false };
		};
		await expect(listResetAccounts()).rejects.toThrow("Could not load saved resets: database locked");
		fake.answer = async () => {
			throw new Error("omp did not list saved resets in time.");
		};
		await expect(listResetAccounts()).rejects.toThrow("in time");
	});
});
