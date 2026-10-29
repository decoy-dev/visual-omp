import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeBridge, type NativeBridge } from "./native-bridge";
vi.mock("../ipc", () => ({ broadcast: vi.fn() }));
let bridge: NativeBridge | undefined; let dir: string | undefined;
afterEach(async () => { await bridge?.close(); if (dir) await rm(dir, { recursive: true, force: true }); });
const modes = { plan: { status: "inactive" }, vibe: { status: "inactive" }, goal: { status: "inactive" }, loop: { status: "inactive" } } as const;

describe("native bridge capability boundary", () => {
	it("keeps the extension owner-only in its private directory", async () => {
		dir = await mkdtemp(join(tmpdir(), "misc-permissions-")); bridge = await createNativeBridge("security", dir);
		if (process.platform !== "win32") {
			expect((await stat(dir)).mode & 0o777).toBe(0o700);
			expect((await stat(bridge.extensionPath)).mode & 0o777).toBe(0o600);
		}
	});
	it("documents leaked-token snapshot and result authority without exposing a mode-enqueue HTTP route", async () => {
		dir = await mkdtemp(join(tmpdir(), "misc-capability-")); bridge = await createNativeBridge("security", dir);
		const location = { cwd: "/forged", sessionFile: "/forged/session.jsonl", sessionId: "forged" };
		expect((await fetch(bridge.url + "/snapshot", { method: "POST", body: JSON.stringify({ modes, theme: null, location }) })).status).toBe(200);
		expect(bridge.snapshot.location).toEqual(location);
		for (const route of ["/mode", "/setMode", "/requests"]) expect((await fetch(bridge.url + route, { method: "POST", body: JSON.stringify({ mode: "plan", action: "enter" }) })).status).toBe(404);
		expect(await (await fetch(bridge.url + "/requests")).json()).toEqual([]);
		const pending = bridge.setMode({ mode: "plan", action: "enter" });
		const stolen = await (await fetch(bridge.url + "/requests")).json() as { id: string }[];
		expect(await (await fetch(bridge.url + "/requests")).json()).toEqual([]);
		await fetch(bridge.url + "/result/" + stolen[0]!.id, { method: "POST", body: JSON.stringify({ ok: true, changed: true, state: modes }) });
		await expect(pending).resolves.toMatchObject({ ok: true, changed: true });
	});
});
