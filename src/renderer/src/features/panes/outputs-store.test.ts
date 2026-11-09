// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { PaneMadeFile } from "@shared/contracts/panes";
import type { SessionController, SessionView } from "../../state/session";
import { useChatOutputs, type Derived } from "./outputs-store";

vi.mock("../projects/folders/homeDir", () => ({ useHomeDir: () => "/home/me" }));
const requests: { queries: unknown; resolve: (value: PaneMadeFile[][]) => void }[] = [];
const snapshots = new Map<string, Derived | null>();
let root: Root; let element: HTMLDivElement; let sequence = 0;
function chat(id: string, cwd: string, generation = 1, start = 1000) {
	const entries: SessionEntry[] = [
		{ id: "call", parentId: null, timestamp: "2026-11-09T20:00:00Z", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "same-id", name: "bash", arguments: { command: `touch ${cwd}/output.mp4` } }], model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, stopReason: "toolUse", timestamp: start } },
		{ id: "result", parentId: null, timestamp: "2026-11-09T20:00:01Z", type: "message", message: { role: "toolResult", toolCallId: "same-id", toolName: "bash", content: [{ type: "text", text: "Done." }], isError: false, timestamp: start + 500 } },
	];
	return { session: { tabId: id, projectPath: cwd, sessionFile: `${cwd}/chat.jsonl` } as SessionController,
		view: { guest: null, carryover: null, host: { hostId: `host-${id}`, generation, sessionId: `room-${id}` }, history: { header: { id: `room-${id}`, cwd }, entries } } as unknown as SessionView };
}
function Probe({ session, view }: { session: SessionController; view: SessionView }) {
	snapshots.set(session.tabId, useChatOutputs(session, view));
	return null;
}
const file = (path: string): PaneMadeFile => ({ path, mtime: 1200, size: 10 });
async function flush() { await act(async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); }); }
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); requests.length = 0; snapshots.clear(); sequence++;
	Object.assign(window, { vomp: { platform: "darwin", on: () => () => {}, invoke: (channel: string, queries: unknown) => {
		if (channel !== "panes:scanMade") return Promise.resolve(undefined);
		const { promise, resolve } = Promise.withResolvers<PaneMadeFile[][]>(); requests.push({ queries, resolve }); return promise;
	} } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
	await act(async () => root.unmount());
	for (let n = 0; n < 4; n++) { for (const request of requests) request.resolve([]); await flush(); }
	element.remove();
});
it("keeps identical tool-call IDs in different chats attached to their own scan results", async () => {
	const a = chat(`a-${sequence}`, "/chat-a"); const b = chat(`b-${sequence}`, "/chat-b");
	await act(async () => root.render(createElement(Fragment, null, createElement(Probe, a), createElement(Probe, b))));
	await flush(); expect(requests).toHaveLength(1);
	requests[0]!.resolve([[file("/chat-a/output.mp4")]]); await flush();
	expect(requests).toHaveLength(2);
	expect(snapshots.get(a.session.tabId)?.made["same-id"]?.[0]?.path).toBe("/chat-a/output.mp4");
	expect(snapshots.get(b.session.tabId)?.made["same-id"]).toBeUndefined();
	requests[1]!.resolve([[file("/chat-b/output.mp4")]]); await flush();
	expect(snapshots.get(a.session.tabId)?.made["same-id"]?.[0]?.path).toBe("/chat-a/output.mp4");
	expect(snapshots.get(b.session.tabId)?.made["same-id"]?.[0]?.path).toBe("/chat-b/output.mp4");
});
it.each(["generation", "candidate"])("ignores a late scan after its %s identity changes", async changed => {
	const id = `rotate-${sequence}-${changed}`; const before = chat(id, "/old");
	await act(async () => root.render(createElement(Probe, before))); await flush();
	const after = changed === "generation" ? chat(id, "/old", 2) : chat(id, "/new", 1, 2000);
	await act(async () => root.render(createElement(Probe, after)));
	requests[0]!.resolve([[file("/old/previous.mp4")]]); await flush();
	expect(snapshots.get(id)?.made["same-id"]).toBeUndefined();
	expect(requests).toHaveLength(2);
	requests[1]!.resolve([[file("/new/current.mp4")]]); await flush();
	expect(snapshots.get(id)?.made["same-id"]?.[0]?.path).toBe("/new/current.mp4");
});
