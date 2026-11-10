// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FileRef } from "@shared/contracts/fileRefs";
import { useCanonicalProjectPath } from "./canonical";

let root: Root; let element: HTMLDivElement; let sequence = 0;
const invoke = vi.fn();
function Probe({ project }: { project: string | null }) {
	const canonical = useCanonicalProjectPath(project);
	return createElement("span", null, canonical ?? "unknown");
}
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); sequence++;
	invoke.mockReset(); Object.assign(window, { vomp: { platform: "darwin", invoke } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
it("shares one existing bounded reference check across sibling project consumers", async () => {
	const pending = Promise.withResolvers<(FileRef | null)[]>(); invoke.mockReturnValue(pending.promise);
	const project = `/opened/project-${sequence}`;
	await act(async () => root.render(createElement(Fragment, null, createElement(Probe, { project }), createElement(Probe, { project }))));
	expect(invoke).toHaveBeenCalledExactlyOnceWith("fs:resolveRefs", { refs: [project], bases: [] });
	expect(element.textContent).toBe("unknownunknown");
	await act(async () => pending.resolve([{ path: "/real/project", kind: "folder" }]));
	expect(element.textContent).toBe("/real/project/real/project");
});
it("never applies a delayed project lookup to another project", async () => {
	const first = Promise.withResolvers<(FileRef | null)[]>(); const second = Promise.withResolvers<(FileRef | null)[]>();
	invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
	await act(async () => root.render(createElement(Probe, { project: `/old/project-${sequence}` })));
	await act(async () => root.render(createElement(Probe, { project: `/new/project-${sequence}` })));
	await act(async () => second.resolve([{ path: "/real/new-project", kind: "folder" }]));
	await act(async () => first.resolve([{ path: "/real/old-project", kind: "folder" }]));
	expect(element.textContent).toBe("/real/new-project");
});
it.each(["file", "failure"])("keeps canonical identity unknown for a %s result", async kind => {
	if (kind === "failure") invoke.mockRejectedValue(new Error("Unavailable"));
	else invoke.mockResolvedValue([{ path: "/real/not-a-folder", kind: "file" }]);
	await act(async () => root.render(createElement(Probe, { project: `/unavailable/${kind}-${sequence}` })));
	expect(element.textContent).toBe("unknown");
});
it("leaves Windows project spelling untouched in the lookup and skips absent projects", async () => {
	invoke.mockResolvedValue([{ path: "C:\\Real Project", kind: "folder" }]);
	await act(async () => root.render(createElement(Probe, { project: null })));
	expect(invoke).not.toHaveBeenCalled();
	const project = `C:\\Opened Project ${sequence}`;
	await act(async () => root.render(createElement(Probe, { project })));
	expect(invoke).toHaveBeenCalledExactlyOnceWith("fs:resolveRefs", { refs: [project], bases: [] });
});
