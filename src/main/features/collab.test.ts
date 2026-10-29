import { beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
	project: {} as Record<string, unknown>,
	global: {} as Record<string, unknown>,
	confirm: vi.fn(),
	publish: vi.fn(),
	stop: vi.fn(),
}));
vi.mock("electron", () => ({ dialog: { showMessageBox: (...args: unknown[]) => fake.confirm(...args) } }));
vi.mock("../ipc", () => ({ handle: (name: string, fn: (...args: unknown[]) => Promise<unknown>) => fake.handlers.set(name, fn), broadcast: vi.fn() }));
vi.mock("../omp/config-file", () => ({ readConfig: async (scope: string) => ({ data: scope === "project" ? fake.project : fake.global }) }));
vi.mock("../omp/host", () => ({ getHost: () => ({ state: { cwd: "/hostile-project", link: `ws://localhost:9876/r/room_ABCDEFGHIJ.${Buffer.alloc(48).toString("base64url")}` } }) }));
vi.mock("../omp/relay", () => ({ relayHosting: () => ({ url: "ws://localhost:9876", publish: (...args: unknown[]) => fake.publish(...args), unpublish: vi.fn() }) }));
import { register } from "./collab";
register();
let serial = 0;
beforeEach(() => {
	fake.project = {};
	fake.global = {};
	fake.confirm.mockReset().mockResolvedValue({ response: 0 });
	fake.publish.mockReset().mockReturnValue({ status: { phase: "live", remoteGuests: 0, error: null, reason: null }, stop: fake.stop, onStatus: () => () => {} });
});

it("publishes default endpoints without an additional custom-server prompt", async () => {
	await fake.handlers.get("collab:publish")!(`host-${serial++}`);
	expect(fake.confirm).not.toHaveBeenCalled();
	expect(fake.publish).toHaveBeenCalledWith("room_ABCDEFGHIJ", "wss://my.omp.sh");
});

it("shows project-selected relay and browser origins before any publication", async () => {
	fake.project = { collab: { relayUrl: "wss://relay.hostile.example", webUrl: "https://client.hostile.example/viewer" } };
	await expect(fake.handlers.get("collab:publish")!(`host-${serial++}`)).rejects.toThrow("cancelled");
	expect(fake.confirm).toHaveBeenCalledWith(expect.objectContaining({
		defaultId: 0,
		cancelId: 0,
		detail: expect.stringContaining("Browser client: https://client.hostile.example/viewer"),
	}));
	expect(fake.confirm.mock.calls[0]?.[0].detail).toContain("Relay: wss://relay.hostile.example");
	expect(fake.publish).not.toHaveBeenCalled();
});

it("publishes custom global endpoints only after explicit consent", async () => {
	fake.global = { collab: { webUrl: "https://client.example" } };
	fake.confirm.mockResolvedValue({ response: 1 });
	const state = await fake.handlers.get("collab:publish")!(`host-${serial++}`);
	expect(fake.publish).toHaveBeenCalledOnce();
	expect(state).toMatchObject({ viewLink: expect.stringContaining("https://client.example/#") });
});
