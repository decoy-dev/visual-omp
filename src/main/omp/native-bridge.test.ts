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
	it("delivers SDK shutdown once per generation without editor or mode commands", async () => {
		dir = await mkdtemp(join(tmpdir(), "shutdown-bridge-")); bridge = await createNativeBridge("shutdown-test", dir);
		bridge.requestShutdown(); bridge.requestShutdown();
		expect(await (await fetch(bridge.url + "/requests")).json()).toEqual([{ kind: "shutdown" }]);
		bridge.requestShutdown();
		expect(await (await fetch(bridge.url + "/requests")).json()).toEqual([]);
		bridge.beginGeneration(1);
		bridge.requestShutdown();
		bridge.beginGeneration(2);
		expect(await (await fetch(bridge.url + "/requests")).json()).toEqual([]);
		bridge.requestShutdown();
		expect(await (await fetch(bridge.url + "/requests")).json()).toEqual([{ kind: "shutdown" }]);
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

describe("native prompt observation bridge", () => {
	it("waits for the delivered extension arm, then forwards one input notification without text", async () => {
		dir = await mkdtemp(join(tmpdir(), "prompt-bridge-")); bridge = await createNativeBridge("prompt-test", dir);
		const observed = vi.fn();
		bridge.onPromptInput = observed;
		let armed = false;
		const pending = bridge.watchPrompt({ id: "prompt/one", sessionId: "session", text: "exact\nprompt" }).then(result => { armed = true; return result; });
		const response = await fetch(bridge.url + "/requests");
		const epoch = response.headers.get("X-Vomp-Jobs-Epoch");
		expect(await response.json()).toEqual([{ id: "prompt/one", kind: "watchPrompt", prompt: { id: "prompt/one", sessionId: "session", text: "exact\nprompt" }, epoch }]);
		expect(armed).toBe(false);
		expect(await (await fetch(bridge.url + "/requests")).json()).toEqual([]);
		const route = bridge.url + "/prompt/" + encodeURIComponent("prompt/one");
		const post = (state: string, sessionId = "session") => fetch(route, { method: "POST", body: JSON.stringify({ state, sessionId, epoch, emptyResume: false }) });
		expect((await post("input")).status).toBe(409);
		expect((await post("armed", "other")).status).toBe(409);
		expect(armed).toBe(false);
		expect((await post("armed")).status).toBe(200);
		await expect(pending).resolves.toEqual({ emptyResume: false });
		expect(observed).not.toHaveBeenCalled();
		expect((await post("input")).status).toBe(200);
		expect(observed).toHaveBeenCalledExactlyOnceWith("prompt/one");
		expect((await post("input")).status).toBe(409);
		bridge.forgetPrompt("prompt/one");
		expect(await (await fetch(bridge.url + "/requests")).json()).toEqual([]);
	});

	it("forgets both pending and armed watches through the existing request queue", async () => {
		dir = await mkdtemp(join(tmpdir(), "prompt-forget-")); bridge = await createNativeBridge("prompt-test", dir);
		const undelivered = bridge.watchPrompt({ id: "undelivered", sessionId: "session", text: "private" });
		const rejected = expect(undelivered).rejects.toThrow("did not arm");
		bridge.forgetPrompt("undelivered");
		await rejected;
		expect(await (await fetch(bridge.url + "/requests")).json()).toEqual([]);
		const pending = bridge.watchPrompt({ id: "delivered", sessionId: "session", text: "." });
		const response = await fetch(bridge.url + "/requests");
		const epoch = response.headers.get("X-Vomp-Jobs-Epoch");
		await response.json();
		await fetch(bridge.url + "/prompt/delivered", { method: "POST", body: JSON.stringify({ state: "armed", epoch, sessionId: "session", emptyResume: true }) });
		await expect(pending).resolves.toEqual({ emptyResume: true });
		bridge.forgetPrompt("delivered");
		expect(await (await fetch(bridge.url + "/requests")).json()).toEqual([{ id: "delivered", kind: "forgetPrompt", epoch }]);
		expect(await (await fetch(bridge.url + "/requests")).json()).toEqual([]);
		expect((await fetch(bridge.url + "/prompt/delivered", { method: "POST", body: JSON.stringify({ state: "input", epoch, sessionId: "session" }) })).status).toBe(409);
	});

	it("rejects old-generation arms and input even if the watch id and session are reused", async () => {
		dir = await mkdtemp(join(tmpdir(), "prompt-generation-")); bridge = await createNativeBridge("prompt-test", dir);
		const observed = vi.fn(); bridge.onPromptInput = observed;
		const first = bridge.watchPrompt({ id: "same", sessionId: "session", text: "first" });
		const rejected = expect(first).rejects.toThrow("changed rooms");
		const response = await fetch(bridge.url + "/requests");
		const previousEpoch = response.headers.get("X-Vomp-Jobs-Epoch");
		await response.json();
		bridge.beginGeneration(2); await rejected;
		const current = bridge.watchPrompt({ id: "same", sessionId: "session", text: "current" });
		const response2 = await fetch(bridge.url + "/requests");
		const epoch = response2.headers.get("X-Vomp-Jobs-Epoch");
		await response2.json();
		for (const state of ["armed", "input"]) expect((await fetch(bridge.url + "/prompt/same", { method: "POST", body: JSON.stringify({ state, epoch: previousEpoch, sessionId: "session" }) })).status).toBe(409);
		await fetch(bridge.url + "/prompt/same", { method: "POST", body: JSON.stringify({ state: "armed", epoch, sessionId: "session", emptyResume: false }) });
		await expect(current).resolves.toEqual({ emptyResume: false });
		expect(observed).not.toHaveBeenCalled();
		bridge.beginGeneration(3);
		expect((await fetch(bridge.url + "/prompt/same", { method: "POST", body: JSON.stringify({ state: "input", epoch, sessionId: "session" }) })).status).toBe(409);
		expect(observed).not.toHaveBeenCalled();
	});

	it("rejects unavailable arms and releases pending observation when the bridge closes", async () => {
		dir = await mkdtemp(join(tmpdir(), "prompt-close-")); bridge = await createNativeBridge("prompt-test", dir);
		bridge.onPromptInput = vi.fn();
		const armed = bridge.watchPrompt({ id: "armed", sessionId: "session", text: "private" });
		const response = await fetch(bridge.url + "/requests");
		const epoch = response.headers.get("X-Vomp-Jobs-Epoch");
		await response.json();
		await fetch(bridge.url + "/prompt/armed", { method: "POST", body: JSON.stringify({ state: "armed", epoch, sessionId: "session", emptyResume: false }) });
		await armed;
		const pending = bridge.watchPrompt({ id: "pending", sessionId: "session", text: "private" });
		const rejected = expect(pending).rejects.toThrow("stopped");
		await bridge.close(); await rejected;
		expect(bridge.onPromptInput).toBeUndefined();
		await expect(bridge.watchPrompt({ id: "closed", sessionId: "session", text: "private" })).rejects.toThrow("unavailable");
	});

	it("rejects an explicit unavailable extension arm instead of treating it as input", async () => {
		dir = await mkdtemp(join(tmpdir(), "prompt-unavailable-")); bridge = await createNativeBridge("prompt-test", dir);
		const observed = vi.fn(); bridge.onPromptInput = observed;
		const pending = bridge.watchPrompt({ id: "unavailable", sessionId: "session", text: "private" });
		const rejected = expect(pending).rejects.toThrow("did not arm");
		const response = await fetch(bridge.url + "/requests");
		const epoch = response.headers.get("X-Vomp-Jobs-Epoch");
		await response.json();
		await fetch(bridge.url + "/prompt/unavailable", { method: "POST", body: JSON.stringify({ state: "error", epoch, sessionId: "session" }) });
		await rejected;
		expect(observed).not.toHaveBeenCalled();
	});

	it("keeps a classic prompt unsent when its atomic editor guard reports private draft text", async () => {
		dir = await mkdtemp(join(tmpdir(), "prompt-classic-editor-")); bridge = await createNativeBridge("prompt-test", dir);
		const observed = vi.fn(); bridge.onPromptInput = observed;
		const pending = bridge.watchPrompt({ id: "classic", sessionId: "session", text: "New message", classicEditor: { expected: "" } });
		const rejected = expect(pending).rejects.toThrow("omp has unsent text in its editor.");
		const response = await fetch(bridge.url + "/requests");
		const epoch = response.headers.get("X-Vomp-Jobs-Epoch");
		expect(await response.json()).toEqual([{ id: "classic", kind: "watchPrompt", prompt: { id: "classic", sessionId: "session", text: "New message", classicEditor: { expected: "" } }, epoch }]);
		await fetch(bridge.url + "/prompt/classic", { method: "POST", body: JSON.stringify({ state: "error", epoch, sessionId: "session", error: "omp has unsent text in its editor." }) });
		await rejected;
		expect((await fetch(bridge.url + "/prompt/classic", { method: "POST", body: JSON.stringify({ state: "input", epoch, sessionId: "session" }) })).status).toBe(409);
		expect(observed).not.toHaveBeenCalled();
	});

	it("delivers only a positive integer image ownership count with the exact prompt watch", async () => {
		dir = await mkdtemp(join(tmpdir(), "prompt-images-")); bridge = await createNativeBridge("prompt-test", dir);
		for (const images of [0, -1, 1.5, Number.POSITIVE_INFINITY]) await expect(bridge.watchPrompt({ id: "invalid", sessionId: "session", text: "authored", images })).rejects.toThrow("attachment observation");
		expect(await (await fetch(bridge.url + "/requests")).json()).toEqual([]);
		const pending = bridge.watchPrompt({ id: "images", sessionId: "session", text: "authored\ntext", images: 2 });
		const rejected = expect(pending).rejects.toThrow("did not arm");
		const response = await fetch(bridge.url + "/requests");
		const epoch = response.headers.get("X-Vomp-Jobs-Epoch");
		expect(await response.json()).toEqual([{ id: "images", kind: "watchPrompt", prompt: { id: "images", sessionId: "session", text: "authored\ntext", images: 2 }, epoch }]);
		bridge.forgetPrompt("images");
		await rejected;
	});

	it("times out an unconfirmed arm as unavailable observation and queues its removal", async () => {
		dir = await mkdtemp(join(tmpdir(), "prompt-timeout-")); bridge = await createNativeBridge("prompt-test", dir);
		const timers = vi.spyOn(globalThis, "setTimeout");
		try {
			const pending = bridge.watchPrompt({ id: "timeout", sessionId: "session", text: "private" });
			const rejected = expect(pending).rejects.toThrow("did not arm");
			const response = await fetch(bridge.url + "/requests");
			const epoch = response.headers.get("X-Vomp-Jobs-Epoch");
			await response.json();
			const expire = timers.mock.calls.find(([, delay]) => delay === 5000)?.[0];
			if (typeof expire !== "function") throw new Error("Missing prompt arming deadline");
			expire(); await rejected;
			expect(await (await fetch(bridge.url + "/requests")).json()).toEqual([{ id: "timeout", kind: "forgetPrompt", epoch }]);
		} finally { timers.mockRestore(); }
	});
});
