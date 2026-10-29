import { beforeEach, describe, expect, it, vi } from "vitest";
import { useShares } from "./share-store";

const fake = vi.hoisted(() => {
	const invoke = vi.fn();
	vi.stubGlobal("window", { vomp: { invoke, on: () => () => undefined } });
	return { invoke };
});

beforeEach(() => {
	fake.invoke.mockReset();
	useShares.setState({ byHost: {}, fileAction: null });
});

describe("local share operation state", () => {
	it("preserves confirmed pack output and warnings in the originating session scope", async () => {
		const result = { path: "/exports/chat.tar", report: "warning: a referenced image is missing" };
		fake.invoke.mockResolvedValue(result);
		await useShares.getState().runFileAction("pack", "/sessions/a.jsonl");
		expect(fake.invoke).toHaveBeenCalledWith("share:pack", "/sessions/a.jsonl");
		expect(useShares.getState().fileAction).toEqual({ kind: "pack", sessionFile: "/sessions/a.jsonl", phase: "done", result });
	});

	it("keeps an unpack result available without a current chat", async () => {
		const result = { path: "/sessions/imported.jsonl", report: "Unpacked session (id)." };
		fake.invoke.mockResolvedValue(result);
		await useShares.getState().runFileAction("unpack");
		expect(fake.invoke).toHaveBeenCalledWith("share:unpack");
		expect(useShares.getState().fileAction).toEqual({ kind: "unpack", sessionFile: null, phase: "done", result });
	});

	it("records cancellation without a fabricated result or error", async () => {
		fake.invoke.mockResolvedValue(null);
		await useShares.getState().runFileAction("anonymize", "/sessions/a.jsonl");
		expect(useShares.getState().fileAction).toEqual({ kind: "anonymize", sessionFile: "/sessions/a.jsonl", phase: "cancelled" });
	});

	it("replaces an old success with the current failure and permits an explicit retry", async () => {
		fake.invoke.mockResolvedValueOnce({ path: "/exports/chat.tar", report: "" }).mockRejectedValueOnce(new Error("Session is in use")).mockResolvedValueOnce(null);
		await useShares.getState().runFileAction("pack", "/sessions/a.jsonl");
		await useShares.getState().runFileAction("pack", "/sessions/a.jsonl");
		expect(useShares.getState().fileAction).toEqual({ kind: "pack", sessionFile: "/sessions/a.jsonl", phase: "error", error: "Session is in use" });
		await useShares.getState().runFileAction("pack", "/sessions/a.jsonl");
		expect(useShares.getState().fileAction?.phase).toBe("cancelled");
	});

	it("prevents overlapping native choosers and keeps the initial scope while awaiting IPC", async () => {
		const { promise, resolve } = Promise.withResolvers<unknown>();
		fake.invoke.mockReturnValue(promise);
		const pending = useShares.getState().runFileAction("anonymize", "/sessions/a.jsonl");
		expect(useShares.getState().fileAction).toEqual({ kind: "anonymize", sessionFile: "/sessions/a.jsonl", phase: "busy" });
		await useShares.getState().runFileAction("unpack");
		expect(fake.invoke).toHaveBeenCalledTimes(1);
		resolve({ path: "/exports/anon", report: "Review before sharing", transcriptCount: 3 });
		await pending;
		expect(useShares.getState().fileAction).toMatchObject({ kind: "anonymize", sessionFile: "/sessions/a.jsonl", phase: "done", result: { transcriptCount: 3 } });
	});

	it("does not pack or anonymize a missing session", async () => {
		await useShares.getState().runFileAction("pack");
		await useShares.getState().runFileAction("anonymize");
		expect(fake.invoke).not.toHaveBeenCalled();
		expect(useShares.getState().fileAction).toBeNull();
	});
});
