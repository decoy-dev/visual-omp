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
