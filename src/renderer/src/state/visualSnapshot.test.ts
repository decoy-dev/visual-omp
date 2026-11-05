// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVisualSnapshot } from "./visualSnapshot";
import { useSessionView } from "../shell/hooks";
import type { SessionController, SessionView } from "./session";

let root: Root;
let container: HTMLDivElement;
let visibility: DocumentVisibilityState;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	visibility = "visible";
	vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.restoreAllMocks();
});

interface TestStore {
	getSnapshot(): { revision: number; question: string | null; working: boolean };
	subscribe(listener: () => void): () => void;
	publish(revision: number, question?: string | null, working?: boolean): void;
	listeners: Set<() => void>;
}
function source(initial = 0): TestStore {
	let value = { revision: initial, question: null as string | null, working: true };
	const listeners = new Set<() => void>();
	return {
		getSnapshot: () => value,
		subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		publish(revision: number, question: string | null = null, working = true) {
			value = { revision, question, working };
			for (const listener of listeners) listener();
		},
		listeners,
	};
}
async function setVisibility(value: DocumentVisibilityState) {
	await act(async () => { visibility = value; document.dispatchEvent(new Event("visibilitychange")); });
}

describe("visual snapshot subscriptions", () => {
	it("keeps visible updates immediate, skips hidden renders and catches up once to the newest snapshot", async () => {
		const store = source();
		const rendered: number[] = [];
		function View() {
			const snapshot = useVisualSnapshot(store.subscribe, store.getSnapshot);
			rendered.push(snapshot.revision);
			return createElement("p", null, snapshot.revision);
		}
		await act(async () => root.render(createElement(View)));
		await act(async () => store.publish(1));
		expect(container.textContent).toBe("1");
		await setVisibility("hidden");
		const before = rendered.length;
		await act(async () => { for (let i = 2; i <= 100; i++) store.publish(i); });
		expect(rendered).toHaveLength(before);
		expect(container.textContent).toBe("1");
		await setVisibility("visible");
		expect(rendered.slice(before)).toEqual([100]);
		expect(container.textContent).toBe("100");
		await setVisibility("visible");
		expect(rendered).toHaveLength(before + 1);
	});

	it("retains the frozen snapshot when an unrelated parent renders while hidden", async () => {
		const store = source(1);
		function View({ label }: { label: string }) {
			const snapshot = useVisualSnapshot(store.subscribe, store.getSnapshot);
			return createElement("p", null, `${label}:${snapshot.revision}`);
		}
		await act(async () => root.render(createElement(View, { label: "first" })));
		await setVisibility("hidden");
		await act(async () => store.publish(2));
		await act(async () => root.render(createElement(View, { label: "parent" })));
		expect(container.textContent).toBe("parent:1");
		await setVisibility("visible");
		expect(container.textContent).toBe("parent:2");
	});

	it("keeps non-visual question, completion and badge consumers subscribed to current state", async () => {
		const store = source();
		const events: string[] = [];
		const off = store.subscribe(() => {
			const snapshot = store.getSnapshot();
			if (snapshot.question) events.push(`needsInput:${snapshot.question}`);
			if (!snapshot.working) events.push("finished");
		});
		function View() {
			const snapshot = useVisualSnapshot(store.subscribe, store.getSnapshot);
			return createElement("p", null, snapshot.revision);
		}
		await act(async () => root.render(createElement(View)));
		await setVisibility("hidden");
		await act(async () => { store.publish(1, "Approve?"); store.publish(2, null, false); });
		expect(events).toEqual(["needsInput:Approve?", "finished"]);
		expect(store.getSnapshot()).toEqual({ revision: 2, question: null, working: false });
		expect(container.textContent).toBe("0");
		await setVisibility("visible");
		expect(container.textContent).toBe("2");
		off();
	});

	it("reads the current state on hidden mount, follows a changed source and removes listeners on unmount", async () => {
		const first = source(1);
		const second = source(10);
		function View({ store }: { store: TestStore }) {
			return createElement("p", null, useVisualSnapshot(store.subscribe, store.getSnapshot).revision);
		}
		await setVisibility("hidden");
		await act(async () => root.render(createElement(View, { store: first })));
		expect(container.textContent).toBe("1");
		await act(async () => { first.publish(2); root.render(createElement(View, { store: second })); });
		expect(first.listeners.size).toBe(0);
		expect(container.textContent).toBe("10");
		await act(async () => second.publish(11));
		await setVisibility("visible");
		expect(container.textContent).toBe("11");
		await act(async () => root.render(null));
		expect(second.listeners.size).toBe(0);
	});

	it("gates the shared session hook used by chat transcripts and heavy panes", async () => {
		let view = { working: true } as SessionView;
		const listeners = new Set<() => void>();
		const controller = {
			getSnapshot: () => view,
			subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		} as SessionController;
		const renders = vi.fn();
		function Chat() {
			const snapshot = useSessionView(controller);
			renders(snapshot);
			return createElement("p", null, snapshot?.working ? "working" : "finished");
		}
		await act(async () => root.render(createElement(Chat)));
		await setVisibility("hidden");
		await act(async () => { view = { working: false } as SessionView; for (const listener of listeners) listener(); });
		expect(renders).toHaveBeenCalledTimes(1);
		expect(container.textContent).toBe("working");
		await setVisibility("visible");
		expect(renders).toHaveBeenCalledTimes(2);
		expect(container.textContent).toBe("finished");
	});
});
