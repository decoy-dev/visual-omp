import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostState } from "@shared/ipc";
import type { LiveShareState } from "@shared/contracts/collab";
import type { BridgeStatus } from "../omp/relay";

const fake = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	hosts: new Map<string, { state: { hostId: string; cwd: string; link: string | null; phase: string } }>(),
	hostListener: null as ((state: HostState) => void) | null,
	project: {} as Record<string, unknown>,
	global: {} as Record<string, unknown>,
	confirm: vi.fn(),
	publish: vi.fn(),
	broadcast: vi.fn(),
	startSleep: vi.fn(),
	stopSleep: vi.fn(),
	missingRoom: false,
}));
vi.mock("electron", () => ({
	dialog: { showMessageBox: (...args: unknown[]) => fake.confirm(...args) },
	powerSaveBlocker: { start: (...args: unknown[]) => fake.startSleep(...args), stop: (...args: unknown[]) => fake.stopSleep(...args) },
}));
vi.mock("../ipc", () => ({ handle: (name: string, fn: (...args: unknown[]) => unknown) => fake.handlers.set(name, fn), broadcast: (...args: unknown[]) => fake.broadcast(...args) }));
vi.mock("../omp/config-file", () => ({ readConfig: async (scope: string) => ({ data: scope === "project" ? fake.project : fake.global }) }));
vi.mock("../omp/host", () => ({
	getHost: (id: string) => {
		if (!fake.hosts.has(id)) fake.hosts.set(id, { state: { hostId: id, cwd: "/hostile-project", link: roomLink("room_ABCDEFGHIJ"), phase: "live" } });
		return fake.hosts.get(id)!;
	},
	onHostState: (listener: (state: HostState) => void) => { fake.hostListener = listener; return () => {}; },
}));
vi.mock("../omp/relay", () => ({ relayHosting: () => fake.missingRoom ? null : ({ url: "ws://localhost:9876", publish: (...args: unknown[]) => fake.publish(...args), unpublish: vi.fn() }) }));
import { register } from "./collab";
register();

function roomLink(roomId: string): string {
	return `ws://localhost:9876/r/${roomId}.${Buffer.alloc(48).toString("base64url")}`;
}
function newBridge() {
	let status: BridgeStatus = { phase: "live", remoteGuests: 0, error: null, reason: null };
	const listeners = new Set<(status: BridgeStatus) => void>();
	return {
		get status() { return status; },
		onStatus: (listener: (status: BridgeStatus) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		emit(next: Partial<BridgeStatus>) { status = { ...status, ...next }; for (const listener of listeners) listener(status); },
		stop(reason: "stopped" | "room-closed") { if (status.phase !== "stopped") this.emit({ phase: "stopped", reason, remoteGuests: 0 }); },
	};
}
const publish = (id = "host-a") => fake.handlers.get("collab:publish")!(id) as Promise<LiveShareState>;
const stop = (id = "host-a") => fake.handlers.get("collab:unpublish")!(id);
const state = (id = "host-a") => fake.handlers.get("collab:shared")!(id) as LiveShareState;
function hostUpdate(patch: Partial<{ link: string | null; phase: string }>, id = "host-a") {
	const host = fake.hosts.get(id)!;
	host.state = { ...host.state, ...patch };
	fake.hostListener!(host.state as HostState);
}
function rotate(roomId = "room_KLMNOPQRST", id = "host-a") {
	hostUpdate({ phase: "restarting", link: null }, id);
	hostUpdate({ phase: "live", link: roomLink(roomId) }, id);
}

beforeEach(() => {
	fake.project = {};
	fake.global = {};
	fake.missingRoom = false;
	fake.confirm.mockReset().mockResolvedValue({ response: 0 });
	fake.publish.mockReset().mockImplementation(() => newBridge());
	fake.broadcast.mockReset();
	fake.startSleep.mockReset().mockReturnValue(42);
	fake.stopSleep.mockReset();
});
afterEach(() => {
	for (const id of fake.hosts.keys()) stop(id);
	fake.hosts.clear();
});

it("publishes default endpoints without an additional custom-server prompt", async () => {
	await publish();
	expect(fake.confirm).not.toHaveBeenCalled();
	expect(fake.publish).toHaveBeenCalledWith("room_ABCDEFGHIJ", "wss://my.omp.sh");
});

it("reuses the previous links when the unchanged room is shared again after stopping", async () => {
	const original = await publish();
	stop();
	expect(state()).toMatchObject({ phase: "stopped", keepsAwake: false });
	const resumed = await publish();
	expect(resumed.controlLink).toBe(original.controlLink);
	expect(resumed.viewLink).toBe(original.viewLink);
	expect(resumed).toMatchObject({ roomId: original.roomId, phase: "live", keepsAwake: true, linkChanged: false });
	expect(fake.publish).toHaveBeenCalledTimes(2);
});

it("shows project-selected relay and browser origins before any publication", async () => {
	fake.project = { collab: { relayUrl: "wss://relay.hostile.example", webUrl: "https://client.hostile.example/viewer" } };
	await expect(publish()).rejects.toThrow("cancelled");
	expect(fake.confirm).toHaveBeenCalledWith(expect.objectContaining({ defaultId: 0, cancelId: 0, detail: expect.stringContaining("Browser client: https://client.hostile.example/viewer") }));
	expect(fake.confirm.mock.calls[0]?.[0].detail).toContain("Relay: wss://relay.hostile.example");
	expect(fake.publish).not.toHaveBeenCalled();
	expect(fake.startSleep).not.toHaveBeenCalled();
});

it("publishes custom global endpoints only after explicit consent", async () => {
	fake.global = { collab: { webUrl: "https://client.example" } };
	fake.confirm.mockResolvedValue({ response: 1 });
	expect(await publish()).toMatchObject({ viewLink: expect.stringContaining("https://client.example/#") });
	expect(fake.publish).toHaveBeenCalledOnce();
});

it("holds one idle-sleep blocker until the last shared chat stops", async () => {
	expect(await publish()).toMatchObject({ keepsAwake: true });
	await publish("host-b");
	expect(fake.startSleep).toHaveBeenCalledExactlyOnceWith("prevent-app-suspension");
	stop();
	expect(state()).toMatchObject({ phase: "stopped", keepsAwake: false });
	expect(fake.stopSleep).not.toHaveBeenCalled();
	stop("host-b");
	expect(fake.stopSleep).toHaveBeenCalledExactlyOnceWith(42);
});

it("keeps awake across room rotation and replaces both links without another consent prompt", async () => {
	await publish();
	hostUpdate({ phase: "restarting", link: null });
	expect(state()).toMatchObject({ phase: "reconnecting", controlLink: "", viewLink: "", keepsAwake: true });
	hostUpdate({ phase: "live", link: roomLink("room_KLMNOPQRST") });
	expect(state()).toMatchObject({ phase: "live", roomId: "room_KLMNOPQRST", controlLink: expect.stringContaining("room_KLMNOPQRST"), viewLink: expect.stringContaining("room_KLMNOPQRST"), linkChanged: true, keepsAwake: true });
	expect(fake.confirm).not.toHaveBeenCalled();
	expect(fake.startSleep).toHaveBeenCalledOnce();
	expect(fake.stopSleep).not.toHaveBeenCalled();
});

it("removes stale links as soon as the bridge reports a closed room", async () => {
	await publish();
	fake.publish.mock.results[0]!.value.emit({ phase: "stopped", reason: "room-closed" });
	expect(state()).toMatchObject({ phase: "reconnecting", controlLink: "", viewLink: "", keepsAwake: true });
	rotate();
	expect(state()).toMatchObject({ phase: "live", linkChanged: true });
});

it("rotates only through the endpoints the user approved, ignoring changed project settings", async () => {
	fake.global = { collab: { relayUrl: "wss://approved.example", webUrl: "https://approved.example/client" } };
	fake.confirm.mockResolvedValue({ response: 1 });
	await publish();
	fake.project = { collab: { relayUrl: "wss://unapproved.example", webUrl: "https://unapproved.example" } };
	rotate();
	expect(fake.publish).toHaveBeenLastCalledWith("room_KLMNOPQRST", "wss://approved.example");
	expect(state().controlLink).toContain("https://approved.example/client/#");
	expect(fake.confirm).toHaveBeenCalledOnce();
});

it("does not republish after Stop sharing during a rotation", async () => {
	await publish();
	hostUpdate({ phase: "restarting", link: null });
	stop();
	hostUpdate({ phase: "live", link: roomLink("room_KLMNOPQRST") });
	expect(fake.publish).toHaveBeenCalledOnce();
	expect(state()).toMatchObject({ phase: "stopped", keepsAwake: false, endedReason: "stopped" });
});

it("releases sleep prevention when omp exits and does not share its next room", async () => {
	await publish();
	hostUpdate({ phase: "exited", link: null });
	expect(state()).toMatchObject({ phase: "stopped", keepsAwake: false, endedReason: "room-closed" });
	expect(fake.stopSleep).toHaveBeenCalledExactlyOnceWith(42);
	rotate();
	expect(fake.publish).toHaveBeenCalledOnce();
});

it("releases sleep prevention when the bridge stops for an upstream conflict", async () => {
	await publish();
	fake.publish.mock.results[0]!.value.emit({ phase: "stopped", reason: "stopped", error: "another computer is already sharing this chat" });
	expect(state()).toMatchObject({ phase: "stopped", keepsAwake: false, error: "another computer is already sharing this chat" });
	expect(fake.stopSleep).toHaveBeenCalledOnce();
});

it("ignores later status from an old bridge after a rotation", async () => {
	await publish();
	const old = fake.publish.mock.results[0]!.value;
	rotate();
	old.emit({ phase: "stopped", reason: "stopped", error: "old bridge" });
	expect(state()).toMatchObject({ phase: "live", roomId: "room_KLMNOPQRST", error: null });
});

it("coalesces concurrent publication and refuses a room changed during confirmation", async () => {
	const confirm = Promise.withResolvers<{ response: number }>();
	fake.global = { collab: { webUrl: "https://client.example" } };
	fake.confirm.mockReturnValue(confirm.promise);
	const first = publish();
	const second = publish();
	expect(first).toBe(second);
	hostUpdate({ link: roomLink("room_KLMNOPQRST") });
	confirm.resolve({ response: 1 });
	await expect(first).rejects.toThrow("chat changed");
	expect(fake.publish).not.toHaveBeenCalled();
});

it("cancels an in-flight publication when sharing is stopped", async () => {
	const confirm = Promise.withResolvers<{ response: number }>();
	fake.global = { collab: { webUrl: "https://client.example" } };
	fake.confirm.mockReturnValue(confirm.promise);
	const starting = publish();
	stop();
	confirm.resolve({ response: 1 });
	await expect(starting).rejects.toThrow("chat changed");
	expect(fake.publish).not.toHaveBeenCalled();
});

it("reports a failed rotation and releases sleep prevention", async () => {
	await publish();
	fake.missingRoom = true;
	rotate();
	expect(state()).toMatchObject({ phase: "stopped", keepsAwake: false, error: "This chat isn't running right now." });
	expect(fake.stopSleep).toHaveBeenCalledOnce();
});
