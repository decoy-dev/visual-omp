import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliResult } from "@shared/ipc";
import { listResetAccounts, spendReset } from "./resets";

const fake = vi.hoisted(() => ({ run: vi.fn<(...args: unknown[]) => Promise<CliResult>>() }));
vi.mock("../../omp/cli", () => ({ runOmp: fake.run }));
const codex = { provider: "openai-codex", credentialId: 4 };
const result = (code = 0, stdout = "", stderr = ""): CliResult => ({ code, stdout, stderr });

beforeEach(() => fake.run.mockReset());

describe("spendReset", () => {
	it("uses the CLI target and exit code, including successful empty output", async () => {
		fake.run.mockResolvedValueOnce(result(0, "Reset applied."));
		await expect(spendReset(codex)).resolves.toEqual({ output: "Reset applied.", confirmed: true, exitCode: 0 });
		expect(fake.run).toHaveBeenCalledWith(["usage", "reset", "openai-codex/4"], expect.objectContaining({ timeoutMs: 90_000 }));
		fake.run.mockResolvedValueOnce(result());
		await expect(spendReset(codex)).resolves.toEqual({ output: "", confirmed: true, exitCode: 0 });
	});

	it("reports failure from the exit code regardless of printed output, without retrying", async () => {
		fake.run.mockResolvedValueOnce(result(1, "Reset applied.", "Provider refused redemption."));
		await expect(spendReset(codex)).resolves.toEqual({ output: "Reset applied.\nProvider refused redemption.", confirmed: false, exitCode: 1 });
		expect(fake.run).toHaveBeenCalledTimes(1);
	});

	it("blocks duplicate spends while allowing another account, then releases the target", async () => {
		const { promise, resolve } = Promise.withResolvers<CliResult>();
		fake.run.mockReturnValue(promise);
		const first = spendReset(codex);
		await expect(spendReset(codex)).rejects.toThrow("already spending");
		const other = spendReset({ provider: "anthropic", credentialId: 6 });
		resolve(result());
		await expect(first).resolves.toMatchObject({ confirmed: true });
		await expect(other).resolves.toMatchObject({ confirmed: true });
		await expect(spendReset(codex)).resolves.toMatchObject({ confirmed: true });
		expect(fake.run).toHaveBeenCalledTimes(3);
	});

	it("releases the target after execution fails", async () => {
		fake.run.mockRejectedValueOnce(new Error("Could not start omp.")).mockResolvedValueOnce(result());
		await expect(spendReset(codex)).rejects.toThrow("Could not start");
		await expect(spendReset(codex)).resolves.toMatchObject({ confirmed: true });
	});

	it("rejects malformed targets without running omp", async () => {
		for (const target of [{ provider: "openai-codex reset", credentialId: 4 }, { provider: "anthropic", credentialId: 1.5 }, { provider: "anthropic", credentialId: -1 }]) {
			await expect(spendReset(target)).rejects.toThrow("can't be identified");
		}
		expect(fake.run).not.toHaveBeenCalled();
	});
});

describe("listResetAccounts", () => {
	it("lists JSON and reads all accounts", async () => {
		fake.run.mockResolvedValue(result(0, readFileSync(join(__dirname, "fixtures", "usage-reset.json"), "utf8")));
		await expect(listResetAccounts()).resolves.toMatchObject({ readable: true, accounts: expect.arrayContaining([expect.objectContaining({ credentialId: 4 })]) });
		expect(fake.run).toHaveBeenCalledWith(["usage", "reset", "--json"], expect.objectContaining({ timeoutMs: 45_000 }));
	});

	it("reports nonzero listing exits and fails closed on invalid JSON", async () => {
		fake.run.mockResolvedValueOnce(result(1, "", "Could not load saved resets: database locked"));
		await expect(listResetAccounts()).rejects.toThrow("database locked");
		fake.run.mockResolvedValueOnce(result(0, "not JSON"));
		await expect(listResetAccounts()).resolves.toEqual({ readable: false, accounts: [] });
	});
});
