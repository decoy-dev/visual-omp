// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import "../../i18n";
import { NoticeRow } from "./NoticeRow";
import { FixtureDocuments } from "../../features/tsp/testing/documents";
import { TspNoticeProjection } from "../../state/tsp/notices";
import type { TspHostSnapshot } from "@shared/tsp-host";

const recordings = import.meta.glob<string>("../../../../main/omp/tsp/fixtures/18.15.0/*.messages.jsonl", { query: "?raw", import: "default", eager: true });

it("renders projected notices literally with preserved whitespace and a wrapping body", async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	const element = document.createElement("div");
	const root = createRoot(element);
	const content = `  <model> \`literal\`\nsecond line\n${"unbroken".repeat(100)}`;
	try {
		await act(async () => root.render(createElement(NoticeRow, { entry: { customType: "tsp-notice", content }, mode: "normal" })));
		const body = element.querySelector('[role="note"] p');
		expect(body?.textContent).toBe(content);
		expect(body?.className).toContain("whitespace-pre-wrap");
		expect(body?.className).toContain("[overflow-wrap:anywhere]");
		expect(element.querySelector("model, code, pre, .tr-md")).toBeNull();
	} finally { await act(async () => root.unmount()); }
});

it.each([{ name: "notice-error", level: "error", text: "No model selected." }, { name: "startup-no-model", level: "warning", text: "No default model selected." }])("projects recorded $name into one literal notice row and suppresses a duplicate collab notice", async ({ name, level, text }) => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	const projection = new TspNoticeProjection(); projection.collab([], []);
	const session = new FixtureDocuments();
	for (const line of recordings[`../../../../main/omp/tsp/fixtures/18.15.0/${name}.messages.jsonl`]!.trim().split("\n")) {
		const message: { verb: string; body: unknown } = JSON.parse(line);
		session.receive({ verb: message.verb, params: {}, body: JSON.stringify(message.body) });
		const snapshot: TspHostSnapshot = { ...session.snapshot(), hostId: "host", generation: 1, revision: 1, lifecycle: "live", documentGeneration: 1, availability: { available: true, reason: null }, failure: null, surfaces: session.snapshot().surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) };
		projection.apply(snapshot); projection.apply(snapshot);
	}
	const notices = projection.getSnapshot().filter(notice => notice.level === level);
	expect(notices).toHaveLength(1); expect(notices[0]!.content).toContain(text);
	const element = document.createElement("div"); const root = createRoot(element);
	try {
		for (const mode of ["normal", "thinking", "verbose"] as const) {
			await act(async () => root.render(createElement(NoticeRow, { entry: { customType: "tsp-notice", content: notices[0]!.content }, mode })));
			expect(element.querySelectorAll('[role="note"]')).toHaveLength(1);
			expect(element.querySelector('[role="note"] p')?.textContent).toBe(notices[0]!.content);
		}
		projection.collab([], [{ id: 1, level: "warning", message: notices[0]!.content, at: 1 }]);
		expect(projection.getSnapshot().filter(notice => notice.level === level)).toEqual([]);
	} finally { await act(async () => root.unmount()); }
});
