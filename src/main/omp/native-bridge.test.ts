import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeBridge, type NativeBridge } from "./native-bridge";
vi.mock("../ipc", () => ({ broadcast: vi.fn() }));
const modes = { plan: { status: "inactive" }, vibe: { status: "inactive" }, goal: { status: "inactive" }, loop: { status: "inactive" } } as const;
let bridge: NativeBridge | undefined;
let dir: string | undefined;
afterEach(async () => { await bridge?.close(); if (dir) await rm(dir, { recursive: true, force: true }); });

describe("hosted native mode bridge", () => {
	it("rejects other origins and wrong tokens and validates snapshots", async () => {
		dir = await mkdtemp(join(tmpdir(), "misc-bridge-")); bridge = await createNativeBridge("test", dir);
		expect((await fetch(bridge.url + "/snapshot", { method: "POST", headers: { origin: "http://evil.example" }, body: "{}" })).status).toBe(403);
		expect((await fetch(bridge.url.replace(/\/[^/]+$/, "/wrong") + "/requests")).status).toBe(403);
		expect((await fetch(bridge.url + "/snapshot", { method: "POST", body: "{}" })).status).toBe(400);
		expect(bridge.snapshot.modes).toBeNull();
	});
	it("retains bounded running-job metadata for renderer reads and events", async () => {
		dir = await mkdtemp(join(tmpdir(), "jobs-bridge-")); bridge = await createNativeBridge("jobs-test", dir);
		const asyncJobs = [{ id: "bg_1", intent: "Checking the build", caption: "Compiles the desktop bundle" }];
		const asyncJobsEpoch = (await fetch(bridge.url + "/requests")).headers.get("X-Vomp-Jobs-Epoch");
		expect((await fetch(bridge.url + "/snapshot", { method: "POST", body: JSON.stringify({ modes, theme: null, asyncJobs, asyncJobsEpoch }) })).status).toBe(200);
		expect(bridge.snapshot.asyncJobs).toEqual(asyncJobs);
		expect((await fetch(bridge.url + "/snapshot", { method: "POST", body: JSON.stringify({ modes, theme: null, asyncJobs: Array(101).fill(asyncJobs[0]) }) })).status).toBe(400);
		expect(bridge.snapshot.asyncJobs).toEqual(asyncJobs);
	});
	it("resets same-session generations and rejects old jobs, locations and teardown POSTs", async () => {
		dir = await mkdtemp(join(tmpdir(), "jobs-generation-")); bridge = await createNativeBridge("jobs-test", dir);
		const url = bridge.url;
		const firstEpoch = (await fetch(url + "/requests")).headers.get("X-Vomp-Jobs-Epoch");
		const oldSnapshot = { modes, theme: null, location: { cwd: "/old", sessionId: "same-session", sessionFile: null }, asyncJobsEpoch: firstEpoch, asyncJobs: [{ id: "bg_1", intent: null, caption: "Previous process" }] };
		await fetch(url + "/snapshot", { method: "POST", body: JSON.stringify(oldSnapshot) });
		bridge.beginGeneration(2);
		expect(bridge.snapshot).toMatchObject({ asyncJobs: [], asyncJobsGeneration: 2 });
		await fetch(url + "/snapshot", { method: "POST", body: JSON.stringify(oldSnapshot) });
		expect(bridge.snapshot.asyncJobs).toEqual([]);
		const nextEpoch = (await fetch(url + "/requests")).headers.get("X-Vomp-Jobs-Epoch");
		expect(nextEpoch).not.toBe(firstEpoch);
		const currentSnapshot = { ...oldSnapshot, asyncJobsEpoch: nextEpoch, location: { ...oldSnapshot.location, cwd: "/new" }, asyncJobs: [{ id: "bg_1", intent: null, caption: "Current process" }] };
		await fetch(url + "/snapshot", { method: "POST", body: JSON.stringify(currentSnapshot) });
		for (const stale of [oldSnapshot, { ...oldSnapshot, asyncJobsEpoch: null }, { ...oldSnapshot, shutdown: "teardown" }]) {
			await fetch(url + "/snapshot", { method: "POST", body: JSON.stringify(stale) });
			expect(bridge.snapshot).toMatchObject({ location: currentSnapshot.location, asyncJobs: currentSnapshot.asyncJobs, asyncJobsGeneration: 2 });
		}
		expect((await fetch(url + "/requests")).headers.get("X-Vomp-Jobs-Epoch")).toBe(nextEpoch);
		await fetch(url + "/snapshot", { method: "POST", body: JSON.stringify({ ...currentSnapshot, shutdown: "teardown" }) });
		expect(bridge.snapshot.asyncJobs).toEqual([]);
		await fetch(url + "/snapshot", { method: "POST", body: JSON.stringify(currentSnapshot) });
		expect(bridge.snapshot.asyncJobs).toEqual([]);
		expect((await fetch(url + "/requests")).headers.get("X-Vomp-Jobs-Epoch")).not.toBe(nextEpoch);
	});
	it("invalidates in-flight async checks at a room transition and refuses old-generation callers", async () => {
		dir = await mkdtemp(join(tmpdir(), "wait-bridge-")); bridge = await createNativeBridge("wait-test", dir);
		bridge.beginGeneration(1);
		const pending = bridge.asyncWork(1);
		const rejected = expect(pending).rejects.toThrow("changed rooms");
		const [old] = await (await fetch(bridge.url + "/requests")).json() as { id: string }[];
		bridge.beginGeneration(2);
		await rejected;
		await expect(bridge.asyncWork(1)).rejects.toThrow("room changed");
		const current = bridge.asyncWork(2);
		await fetch(bridge.url + "/async-work/" + old!.id, { method: "POST", body: JSON.stringify({ pending: false }) });
		const [request] = await (await fetch(bridge.url + "/requests")).json() as { id: string }[];
		await fetch(bridge.url + "/async-work/" + request!.id, { method: "POST", body: JSON.stringify({ pending: true }) });
		await expect(current).resolves.toBe(true);
	});
	it("delivers an explicit switch once and preserves omp's disabled result", async () => {
		dir = await mkdtemp(join(tmpdir(), "misc-bridge-")); bridge = await createNativeBridge("test", dir);
		await fetch(bridge.url + "/snapshot", { method: "POST", body: JSON.stringify({ modes, theme: null }) });
		const pending = bridge.setMode({ mode: "plan", action: "enter" });
		const requests = await (await fetch(bridge.url + "/requests")).json() as { id: string; request: unknown }[];
		expect(requests[0]?.request).toEqual({ mode: "plan", action: "enter" });
		expect(await (await fetch(bridge.url + "/requests")).json()).toEqual([]);
		await fetch(bridge.url + "/result/" + requests[0]!.id, { method: "POST", body: JSON.stringify({ ok: false, code: "disabled", message: "Mode control disabled by the user", state: modes }) });
		await expect(pending).resolves.toMatchObject({ ok: false, code: "disabled" });
	});
	it("delivers effective side-command queries separately from mode changes", async () => {
		dir = await mkdtemp(join(tmpdir(), "composer-bridge-")); bridge = await createNativeBridge("test", dir);
		const pending = bridge.sideCommands();
		const requests = await (await fetch(bridge.url + "/requests")).json() as { id: string; kind: string }[];
		expect(requests[0]?.kind).toBe("sideCommands");
		expect(await (await fetch(bridge.url + "/requests")).json()).toEqual([]);
		await fetch(bridge.url + "/commands/" + requests[0]!.id, { method: "POST", body: JSON.stringify({ commands: ["nested", "folder:nested"] }) });
		await expect(pending).resolves.toEqual(["nested", "folder:nested"]);
	});
	it("rejects a failed effective discovery instead of guessing from file metadata", async () => {
		dir = await mkdtemp(join(tmpdir(), "composer-bridge-")); bridge = await createNativeBridge("test", dir);
		const pending = bridge.sideCommands();
		const rejected = expect(pending).rejects.toThrow("Discovery failed");
		const requests = await (await fetch(bridge.url + "/requests")).json() as { id: string }[];
		await fetch(bridge.url + "/commands/" + requests[0]!.id, { method: "POST", body: JSON.stringify({ error: "Discovery failed" }) });
		await rejected;
	});
});
