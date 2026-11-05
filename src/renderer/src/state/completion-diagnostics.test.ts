import { afterEach, expect, it, vi } from "vitest";
import type { GuestSnapshot } from "../collab/lib/client";
import { reportCompletion } from "./completion-diagnostics";

afterEach(() => vi.unstubAllGlobals());

it("sends only compact identifiers and numbers while main derives diagnostic labels", async () => {
	const invoke = vi.fn(async () => undefined);
	vi.stubGlobal("window", { vomp: { invoke } });
	const snapshot = {
		phase: "live", completion: [1, 176, 0], lastStreamingAt: 123,
		agents: [{ kind: "main", status: "running" }, { kind: "sub", status: "running" }, { kind: "sub", status: "idle" }],
		entries: [{ content: "PRIVATE CHAT TEXT" }],
	} as unknown as GuestSnapshot;
	await reportCompletion("chat", snapshot, 3);
	expect(invoke).toHaveBeenCalledWith("app:completionDiagnostic", ["chat", expect.any(Number), expect.any(Number), 0, 2, 22, 123, 1, 3]);
	expect(JSON.stringify(invoke.mock.calls)).not.toContain("PRIVATE");
});

it("encodes host exit separately from a previous completion candidate", async () => {
	const invoke = vi.fn(async () => undefined);
	vi.stubGlobal("window", { vomp: { invoke } });
	await reportCompletion("chat", null, 16);
	expect(invoke).toHaveBeenCalledWith("app:completionDiagnostic", ["chat", expect.any(Number), expect.any(Number), 4, 4, 0, null, 0, 16]);
});
