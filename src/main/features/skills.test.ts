import type { HostStartOptions } from "@shared/ipc";
import { beforeEach, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ enabled: false, sync: vi.fn(), handlers: new Map<string, unknown>() }));
vi.mock("../ipc", () => ({ broadcast: vi.fn(), handle: (channel: string, handler: unknown) => env.handlers.set(channel, handler) }));
vi.mock("../prefs", () => ({ getPrefs: () => ({ visualProofs: env.enabled }), setPrefs: vi.fn() }));
vi.mock("../omp/config-file", () => ({ editConfig: vi.fn() }));
vi.mock("./plugins/runner", () => ({ appRunner: {} }));
vi.mock("./plugins/stream", () => ({ cancelOperation: vi.fn() }));
vi.mock("./skills/service", () => ({ SkillService: class {} }));
vi.mock("../services/visual-proofs", () => ({ VisualProofsService: class { sync() { return env.sync(); } } }));
import { gateHostStart } from "../services/approval-default";
import { register, visualProofsReady } from "./skills";

beforeEach(() => { env.enabled = false; env.sync.mockReset(); env.handlers.clear(); });
const options: HostStartOptions = { cwd: "/project" };

it("holds host startup until the opted-in reconciliation has finished", async () => {
	env.enabled = true;
	const reconciliation = Promise.withResolvers<unknown>();
	env.sync.mockReturnValue(reconciliation.promise);
	register();
	const start = vi.fn(async (_: HostStartOptions) => "host");
	const started = gateHostStart(async () => "settled", start, visualProofsReady)(options);
	await Promise.resolve();
	await Promise.resolve();
	expect(start).not.toHaveBeenCalled();
	expect(env.sync).toHaveBeenCalledOnce();
	reconciliation.resolve({ state: "on" });
	await expect(started).resolves.toBe("host");
	expect(start).toHaveBeenCalledWith(options);
});

it("does no reconciliation work when the setting is off", async () => {
	register();
	const start = vi.fn(async (_: HostStartOptions) => "host");
	await expect(gateHostStart(async () => "settled", start, visualProofsReady)(options)).resolves.toBe("host");
	expect(env.sync).not.toHaveBeenCalled();
});

it("keeps startup reconciliation failures nonfatal", async () => {
	env.enabled = true;
	env.sync.mockRejectedValue(new Error("Skill permissions changed"));
	register();
	const start = vi.fn(async (_: HostStartOptions) => "host");
	await expect(gateHostStart(async () => "settled", start, visualProofsReady)(options)).resolves.toBe("host");
	expect(start).toHaveBeenCalledOnce();
});
