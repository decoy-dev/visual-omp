import { describe, expect, it, vi } from "vitest";
import { ScreenActivityRegistry } from "./screen-activity";

const scope = { hostId: "host", generation: 1, epoch: 2 };

describe("screen interaction leases", () => {
	it("retains nested drives until the last idempotent release", () => {
		const registry = new ScreenActivityRegistry();
		const changed = vi.fn(); registry.subscribe(changed);
		const first = registry.hold(scope, "drive"), second = registry.hold(scope, "drive");
		expect(registry.has(scope, "drive")).toBe(true);
		first(); first(); expect(registry.has(scope, "drive")).toBe(true);
		second(); second(); expect(registry.has(scope, "drive")).toBe(false);
		expect(changed).toHaveBeenCalledTimes(4);
	});
	it("separates host, room generation, protocol epoch and classic scope", () => {
		const registry = new ScreenActivityRegistry();
		const release = registry.hold(scope, "drive");
		for (const other of [{ ...scope, hostId: "other" }, { ...scope, generation: 2 }, { ...scope, epoch: 3 }, { ...scope, epoch: null }]) expect(registry.has(other, "drive")).toBe(false);
		release(); expect(registry.has(scope, "drive")).toBe(false);
	});
	it("keeps explicit requests independent of app drives", () => {
		const registry = new ScreenActivityRegistry();
		const request = registry.hold(scope, "request"), drive = registry.hold(scope, "drive");
		expect(registry.has(scope, "request")).toBe(true);
		drive(); expect(registry.has(scope, "request")).toBe(true);
		expect(registry.has(scope, "drive")).toBe(false);
		request(); expect(registry.has(scope, "request")).toBe(false);
	});
	it("pins the acquired scope rather than retaining a mutable caller object", () => {
		const registry = new ScreenActivityRegistry(); const mutable = { ...scope };
		const release = registry.hold(mutable, "drive"); mutable.epoch++;
		expect(registry.has(scope, "drive")).toBe(true); expect(registry.has(mutable, "drive")).toBe(false);
		release();
	});
	it("queues an exact candidate until the required rendered frame is acknowledged", async () => {
		const registry = new ScreenActivityRegistry();
		const request = registry.requestOnce(scope, 4, "candidate");
		expect(registry.has(scope, "request")).toBe(true);
		expect(registry.allowsRequest(scope, 3, "candidate")).toBe(false);
		expect(registry.allowsRequest(scope, 4, "other")).toBe(false);
		expect(registry.allowsRequest(scope, 4, "candidate")).toBe(true);
		registry.consumeRequests(scope, 3); expect(registry.has(scope, "request")).toBe(true);
		registry.consumeRequests(scope, 4); await expect(request.done).resolves.toBeUndefined();
		expect(registry.has(scope, "request")).toBe(false);
		request.cancel();
	});
	it("observes a new queued request even when another request lease already exists", async () => {
		const registry = new ScreenActivityRegistry();
		const release = registry.hold(scope, "request");
		const firstVersion = registry.version(scope, "request");
		const queued = registry.requestOnce(scope, 1, "candidate");
		expect(registry.version(scope, "request")).toBeGreaterThan(firstVersion);
		registry.consumeRequests(scope, 1); await queued.done;
		expect(registry.has(scope, "request")).toBe(true);
		release(); expect(registry.has(scope, "request")).toBe(false);
	});
	it("never consumes another scope's pending handoff and cleans cancellation once", async () => {
		const registry = new ScreenActivityRegistry(); const done = vi.fn();
		const request = registry.requestOnce(scope, 1, "candidate"); void request.done.then(done);
		registry.consumeRequests({ ...scope, epoch: 3 }, 100);
		expect(registry.has(scope, "request")).toBe(true);
		request.cancel(); request.cancel(); await request.done;
		expect(done).toHaveBeenCalledOnce(); expect(registry.has(scope, "request")).toBe(false);
	});
});
