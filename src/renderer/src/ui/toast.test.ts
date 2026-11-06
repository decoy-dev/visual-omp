// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearToasts, toast, updateToast, useToasts, type ToastRecord } from "./toast";
let root: Root;
let element: HTMLDivElement;
let latest: readonly ToastRecord[] = [];
function Reader() { latest = useToasts(); return null; }
beforeEach(async () => {
 Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); clearToasts();
 element = document.createElement("div"); document.body.append(element); root = createRoot(element);
 await act(async () => root.render(createElement(Reader)));
});
afterEach(async () => { await act(async () => { root.unmount(); clearToasts(); }); element.remove(); });
it("refreshes description and actions without replacing identity, tone or lifetime", async () => {
 const open = vi.fn(); let id = "";
 await act(async () => { id = toast({ message: "omp updated", description: "One stale chat", tone: "info", sticky: true }); });
 await act(async () => updateToast(id, { description: "All chats are current", action: { label: "What's new", onClick: open } }));
 expect(latest).toHaveLength(1);
 expect(latest[0]).toMatchObject({ id, message: "omp updated", tone: "info", durationMs: null, description: "All chats are current" });
 latest[0]!.action!.onClick(); expect(open).toHaveBeenCalledOnce();
});
it("can remove obsolete actions explicitly", async () => {
 let id = "";
 await act(async () => { id = toast({ message: "omp updated", action: { label: "Restart", onClick() {} }, secondaryAction: { label: "Notes", onClick() {} } }); });
 await act(async () => updateToast(id, { action: undefined, secondaryAction: undefined }));
 expect(latest[0]!.action).toBeUndefined(); expect(latest[0]!.secondaryAction).toBeUndefined();
});
it("does not recreate a dismissed notification", async () => {
 const previous = latest;
 await act(async () => updateToast("missing", { description: "Do not reopen" }));
 expect(latest).toBe(previous); expect(latest).toHaveLength(0);
});
