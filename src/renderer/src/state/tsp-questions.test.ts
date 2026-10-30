import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { TspHostSnapshot } from "@shared/tsp-host";
import type { SessionController } from "./session";
import { TspQuestionSync } from "./tsp-questions";

const snapshot = (patch: Partial<TspHostSnapshot> = {}): TspHostSnapshot => ({ hostId: "host", generation: 1, epoch: 1, revision: 1, negotiated: true, lifecycle: "live", documentGeneration: 1, failure: null, availability: { available: false, reason: "Question" }, surfaces: [], ...patch });
let receive: (value: TspHostSnapshot) => void;
let invoke: Mock;
beforeEach(() => {
	invoke = vi.fn(async (channel: string) => channel === "host:tsp-snapshot" ? snapshot() : undefined);
	vi.stubGlobal("window", { vomp: { invoke, on: (_channel: string, listener: typeof receive) => { receive = listener; return () => undefined; } } });
});

function controller() {
	const listeners = new Set<() => void>();
	const request = { reqId: 1, kind: "editor", title: "Answer", prefill: "Draft" };
	const view = { host: { hostId: "host", generation: 1, transport: "tsp" }, mode: "live", guest: { phase: "live", uiConnection: 1, uiRequest: request, pendingUiRequests: [request] } };
	const emit = () => { for (const listener of listeners) listener(); };
	let client = { sendUiResponse: vi.fn() };
	const replaceClient = () => { client = { sendUiResponse: vi.fn() }; };
	const session = { hostId: "host", getSnapshot: () => view, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }, guestClient: () => client } as unknown as SessionController;
	return { view, emit, replaceClient, currentClient: () => client, sync: new TspQuestionSync(session) };
}

describe("renderer collab question mirror", () => {
	it("publishes all pending requests under the main-owned host, epoch and generation", async () => {
		const { emit, sync } = controller(); emit(); await Promise.resolve();
		expect(invoke).toHaveBeenCalledWith("host:tsp-questions", "host", expect.objectContaining({ hostId: "host", generation: 1, epoch: 1, connected: true, requests: [{ reqId: 1, kind: "editor", title: "Answer", prefill: "Draft" }] }));
		const calls = invoke.mock.calls.length; receive(snapshot({ revision: 2 })); emit();
		expect(invoke.mock.calls).toHaveLength(calls);
		sync.dispose();
	});
	it("publishes settlement and reconnect invalidation without copying stale requests", async () => {
		const { emit, view, sync } = controller(); emit(); await Promise.resolve();
		view.guest.pendingUiRequests = []; emit();
		expect(invoke).toHaveBeenLastCalledWith("host:tsp-questions", "host", expect.objectContaining({ requests: [], connected: true, revision: 2 }));
		view.guest.phase = "reconnecting"; emit();
		expect(invoke).toHaveBeenLastCalledWith("host:tsp-questions", "host", expect.objectContaining({ requests: [], connected: false, revision: 3 }));
		sync.dispose();
	});
	it("invalidates only matching authority on an epoch change and retains collab's answer path", async () => {
		const { emit, view, currentClient, sync } = controller(); emit(); await Promise.resolve();
		const request = view.guest.uiRequest;
		receive(snapshot({ epoch: 2, revision: 2 }));
		expect(view.guest.uiRequest).toBe(request);
		expect(view.guest.pendingUiRequests).toEqual([request]);
		expect(invoke).toHaveBeenLastCalledWith("host:tsp-questions", "host", expect.objectContaining({ epoch: 2, connected: false, requests: [] }));
		currentClient().sendUiResponse(request.reqId, "answer");
		expect(currentClient().sendUiResponse).toHaveBeenCalledWith(1, "answer");
		const calls = invoke.mock.calls.length; receive(snapshot({ epoch: 1, revision: 1 }));
		expect(invoke.mock.calls).toHaveLength(calls);
		sync.dispose();
	});
	it("does not give the previous room's request matching authority in a new generation", async () => {
		const { emit, view, sync } = controller(); emit(); await Promise.resolve();
		const calls = invoke.mock.calls.length; view.host.generation = 2; emit();
		expect(invoke.mock.calls).toHaveLength(calls);
		receive(snapshot({ generation: 2, revision: 2 }));
		expect(view.guest.uiRequest.reqId).toBe(1);
		expect(invoke).toHaveBeenLastCalledWith("host:tsp-questions", "host", expect.objectContaining({ generation: 2, connected: false, requests: [] }));
		sync.dispose();
	});
	it("retains a replacement client's welcome and question arriving before the new-generation snapshot", async () => {
		const { emit, view, replaceClient, currentClient, sync } = controller(); emit(); await Promise.resolve();
		view.host.generation = 2;
		replaceClient();
		const request = { reqId: 9, kind: "editor", title: "New room", prefill: "New draft" };
		view.guest = { phase: "live", uiConnection: 1, uiRequest: request, pendingUiRequests: [request] };
		emit();
		receive(snapshot({ generation: 2, revision: 2 }));
		expect(view.guest.uiRequest).toBe(request);
		expect(invoke).toHaveBeenLastCalledWith("host:tsp-questions", "host", expect.objectContaining({ generation: 2, connection: 2, connected: true, requests: [request] }));
		currentClient().sendUiResponse(request.reqId, "new answer");
		expect(currentClient().sendUiResponse).toHaveBeenCalledWith(9, "new answer");
		sync.dispose();
	});
	it("retains a replacement client's question arriving before the new-epoch snapshot", async () => {
		const { emit, view, replaceClient, currentClient, sync } = controller(); emit(); await Promise.resolve();
		replaceClient();
		const request = { reqId: 10, kind: "editor", title: "New omp", prefill: "New draft" };
		view.guest = { phase: "live", uiConnection: 1, uiRequest: request, pendingUiRequests: [request] };
		emit();
		receive(snapshot({ epoch: 2, revision: 2 }));
		expect(view.guest.uiRequest).toBe(request);
		expect(view.guest.pendingUiRequests).toEqual([request]);
		// Its epoch is uncertain, so diagnostic matching stays unavailable until fresh authority arrives.
		expect(invoke).toHaveBeenLastCalledWith("host:tsp-questions", "host", expect.objectContaining({ epoch: 2, connected: false, requests: [] }));
		currentClient().sendUiResponse(request.reqId, "new answer");
		expect(currentClient().sendUiResponse).toHaveBeenCalledWith(10, "new answer");
		sync.dispose();
	});
	it("accepts newly observed requests after a new epoch without reviving prior request authority", async () => {
		const { emit, view, sync } = controller(); emit(); await Promise.resolve();
		receive(snapshot({ epoch: 2, revision: 2 }));
		const request = { reqId: 11, kind: "editor", title: "Fresh question", prefill: "" };
		view.guest.uiRequest = request; view.guest.pendingUiRequests = [request]; emit();
		expect(invoke).toHaveBeenLastCalledWith("host:tsp-questions", "host", expect.objectContaining({ epoch: 2, connected: true, requests: [request] }));
		sync.dispose();
	});
});
