import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostStartOptions } from "@shared/ipc";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setConfigPath } from "../omp/config-file";
import {
	gateHostStart,
	type NewUserApproval,
	type NewUserApprovalResult,
	newUserApprovalAction,
	newUserApprovalRunner,
	UNVERIFIED_APPROVAL_MESSAGE,
	writeApprovalDefaultIfUnset,
} from "./approval-default";

// omp itself is not run: `omp config path` answers with a temporary agent dir and accepts every write.
const agent = vi.hoisted(() => ({ dir: "" }));
vi.mock("../omp/cli", () => ({
	runOmp: vi.fn(async () => ({ code: 0, stdout: `${agent.dir}\n`, stderr: "" })),
}));

describe("newUserApprovalAction", () => {
	it("writes Ask me first only for a fresh profile whose approval mode is omp's default", () => {
		expect(newUserApprovalAction("pending", "default")).toBe("write");
	});

	it("leaves an explicit choice alone and still finishes the check", () => {
		for (const source of ["global", "project", "env", "overlay", "runtime"] as const) {
			expect(newUserApprovalAction("pending", source)).toBe("skip");
		}
	});

	it("never runs for existing profiles or after it has run", () => {
		expect(newUserApprovalAction(undefined, "default")).toBe("none");
		expect(newUserApprovalAction("done", "default")).toBe("none");
	});
});

describe("the new-user check against the global config file", () => {
	// config-file.ts caches omp's agent dir for the process, so every test shares one dir.
	beforeAll(async () => {
		agent.dir = await mkdtemp(join(tmpdir(), "vomp-approval-"));
	});
	beforeEach(() => rm(join(agent.dir, "config.yml"), { force: true }));
	afterAll(() => rm(agent.dir, { recursive: true, force: true }));

	const configText = () => readFile(join(agent.dir, "config.yml"), "utf8");

	function runner(readSource: () => Promise<"default">) {
		let state: NewUserApproval = "pending";
		const check = newUserApprovalRunner({
			state: () => state,
			markDone: () => {
				state = "done";
			},
			readSource,
			writeDefault: writeApprovalDefaultIfUnset,
		});
		return { check, state: () => state };
	}

	it("writes always-ask when omp reports its default and the file has no mode", async () => {
		await writeFile(join(agent.dir, "config.yml"), "# mine\ntheme: dark\n");
		const { check, state } = runner(async () => "default");
		await expect(check()).resolves.toBe("settled");
		expect(await configText()).toBe("# mine\ntheme: dark\ntools:\n  approvalMode: always-ask\n");
		expect(state()).toBe("done");
	});

	it("treats a YAML null as unset and writes always-ask before any chat starts", async () => {
		await writeFile(join(agent.dir, "config.yml"), "tools:\n  approvalMode: null\n");
		const { check, state } = runner(async () => "default");
		const start = vi.fn(async (_: HostStartOptions) => configText());
		await expect(gateHostStart(check, start)({ cwd: "/p" })).resolves.toBe("tools:\n  approvalMode: always-ask\n");
		expect(state()).toBe("done");
	});

	it("keeps a choice saved between the source read and the default write", async () => {
		let userChoice: Promise<void> | null = null;
		const { check, state } = runner(async () => {
			// omp has just reported "default"; the user saves Auto before the default reaches the file.
			userChoice = setConfigPath("global", undefined, ["tools", "approvalMode"], "yolo");
			return "default";
		});
		await expect(check()).resolves.toBe("settled");
		await userChoice;
		expect(await configText()).toBe("tools:\n  approvalMode: yolo\n");
		expect(state()).toBe("done");
	});

	it("stays pending and reports unverified while omp can't be read, then retries", async () => {
		const readSource = vi.fn<() => Promise<"default">>().mockRejectedValueOnce(new Error("omp not found")).mockResolvedValue("default");
		const { check, state } = runner(readSource);
		await expect(check()).resolves.toBe("unverified");
		expect(state()).toBe("pending");
		await expect(check()).resolves.toBe("settled");
		expect(readSource).toHaveBeenCalledTimes(2);
		expect(await configText()).toBe("tools:\n  approvalMode: always-ask\n");
	});
});

describe("gateHostStart", () => {
	const options: HostStartOptions = { cwd: "/p", extraArgs: ["--from-claude"] };

	it("starts omp only after the check finishes", async () => {
		const check = Promise.withResolvers<NewUserApprovalResult>();
		const start = vi.fn(async (_: HostStartOptions) => "host");
		const started = gateHostStart(() => check.promise, start)(options);
		await Promise.resolve();
		await Promise.resolve();
		expect(start).not.toHaveBeenCalled();
		check.resolve("settled");
		await expect(started).resolves.toBe("host");
		expect(start).toHaveBeenCalledWith(options);
	});

	it("starts nothing while the check stays unverified, and lets the next start retry", async () => {
		const check = vi.fn<() => Promise<NewUserApprovalResult>>().mockResolvedValueOnce("unverified").mockResolvedValueOnce("unverified").mockResolvedValue("settled");
		const start = vi.fn(async (_: HostStartOptions) => "host");
		const gated = gateHostStart(check, start);
		await expect(gated(options)).rejects.toThrow(UNVERIFIED_APPROVAL_MESSAGE);
		expect(check).toHaveBeenCalledTimes(2);
		expect(start).not.toHaveBeenCalled();
		await expect(gated(options)).resolves.toBe("host");
		expect(start).toHaveBeenCalledWith(options);
	});

	it("starts after a retry that succeeds", async () => {
		const check = vi.fn<() => Promise<NewUserApprovalResult>>().mockResolvedValueOnce("unverified").mockResolvedValue("settled");
		const start = vi.fn(async (_: HostStartOptions) => "host");
		await expect(gateHostStart(check, start)(options)).resolves.toBe("host");
		expect(start).toHaveBeenCalledWith(options);
	});
});
