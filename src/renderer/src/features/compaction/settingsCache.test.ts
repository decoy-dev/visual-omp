// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { type CompactionSettings, prefetchCompactionSettings, useCompactionSettings } from "./settingsCache";

it("keeps the last settings when a later read fails, says so, and reads again on retry", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const invoke = vi.fn()
		.mockResolvedValueOnce({ settings: [{ key: "compaction.enabled", value: true }] })
		.mockRejectedValueOnce(new Error("omp exited"))
		.mockResolvedValueOnce({ settings: [{ key: "compaction.enabled", value: false }] });
	Object.assign(window, { vomp: { invoke } });
	prefetchCompactionSettings("/cache-test");
	await act(async () => {});
	expect(invoke).toHaveBeenCalledExactlyOnceWith("config:list", "/cache-test");
	let seen: CompactionSettings | null = null;
	const Probe = () => { seen = useCompactionSettings("/cache-test"); return null; };
	const root = createRoot(document.createElement("div"));
	// Mounting shows the prefetched answer at once and reads again; that read fails.
	await act(async () => root.render(createElement(Probe)));
	expect(invoke).toHaveBeenCalledTimes(2);
	expect(seen!.settings?.get("compaction.enabled")?.value).toBe(true);
	expect(seen!.failed).toBe(true);
	await act(async () => seen!.retry());
	expect(seen!.failed).toBe(false);
	expect(seen!.settings?.get("compaction.enabled")?.value).toBe(false);
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});
