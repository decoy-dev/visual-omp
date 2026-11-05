import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeBridge, type NativeBridge } from "./native-bridge";
vi.mock("../ipc", () => ({ broadcast: vi.fn() }));
let bridge: NativeBridge;
let dir: string;
const listing = { provider: "anthropic", sessionId: "session", accounts: [{ credentialId: 7, label: "me@example.com", active: true }] };
afterEach(async () => { await bridge?.close(); if (dir) await rm(dir, { recursive: true, force: true }); });
async function setup() { dir = await mkdtemp(join(tmpdir(), "account-bridge-")); bridge = await createNativeBridge("account-test", dir); bridge.beginGeneration(1); }
async function requests(): Promise<{ id: string; kind: string }[]> { return (await fetch(bridge.url + "/requests")).json() as Promise<{ id: string; kind: string }[]>; }
async function respond(id: string, value: unknown) { return fetch(bridge.url + "/accounts/" + id, { method: "POST", body: JSON.stringify(value) }); }

describe("hosted account reads", () => {
	it("requests a fresh SDK list once and publishes allowlisted account state", async () => {
		await setup();
		const pending = bridge.sessionAccounts(1);
		const [request] = await requests();
		expect(request?.kind).toBe("sessionAccounts");
		expect(await requests()).toEqual([]);
		expect((await respond(request!.id, { ...listing, token: "secret", accounts: [{ ...listing.accounts[0], token: "secret" }] })).status).toBe(200);
		await expect(pending).resolves.toEqual(listing);
		expect(bridge.snapshot.sessionAccounts).toEqual(listing);
		expect(JSON.stringify(bridge.snapshot)).not.toContain("secret");
	});
	it("clears selection and in-flight reads on room changes and ignores their late replies", async () => {
		await setup();
		const pending = bridge.sessionAccounts(1);
		const rejected = expect(pending).rejects.toThrow("changed rooms");
		const [old] = await requests();
		bridge.beginGeneration(2);
		await rejected;
		await expect(bridge.sessionAccounts(1)).rejects.toThrow("room changed");
		await respond(old!.id, listing);
		expect(bridge.snapshot.sessionAccounts).toBeNull();
		const current = bridge.sessionAccounts(2);
		const [next] = await requests();
		await respond(next!.id, null);
		await expect(current).resolves.toBeNull();
	});
	it("refuses malformed ids and rejects pending reads when omp stops", async () => {
		await setup();
		const pending = bridge.sessionAccounts(1);
		const rejected = expect(pending).rejects.toThrow("stopped");
		const [request] = await requests();
		expect((await respond(request!.id, { ...listing, accounts: [{ ...listing.accounts[0], credentialId: "7" }] })).status).toBe(400);
		await bridge.close(); await rejected;
	});
});
