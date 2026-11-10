// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import "../../i18n";
import { NoticeRow } from "./NoticeRow";
import { FixtureDocuments } from "../../features/tsp/testing/documents";
import { TspNoticeProjection } from "../../state/tsp/notices";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { KeyCombinations } from "../../ui/KeyCombinations";

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

it.each([
	{ platform: "darwin", keys: ["⌘", "⇧", "M"], chord: "super+shift+m", spoken: "Command + Shift + M" },
	{ platform: "win32", keys: ["Ctrl", "Shift", "M"], chord: "ctrl+shift+m", spoken: "Control + Shift + M" },
	{ platform: "linux", keys: ["Ctrl", "Shift", "M"], chord: "ctrl+shift+m", spoken: "Control + Shift + M" },
])("renders the recorded session-only model notice with shared $platform shortcut keycaps", ({ platform, keys, chord, spoken }) => {
	const projection = new TspNoticeProjection(); projection.collab([], []);
	const session = new FixtureDocuments();
	for (const line of recordings["../../../../main/omp/tsp/fixtures/18.15.0/model-switch-compact.messages.jsonl"]!.trim().split("\n")) {
		const message: { verb: string; body: unknown } = JSON.parse(line);
		session.receive({ verb: message.verb, params: {}, body: JSON.stringify(message.body) });
		const snapshot: TspHostSnapshot = { ...session.snapshot(), hostId: "host", generation: 1, revision: 1, lifecycle: "live", documentGeneration: 1, availability: { available: true, reason: null }, failure: null, surfaces: session.snapshot().surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) };
		projection.apply(snapshot);
		// The recording reuses the toast for "Closing session", so inspect its model version before the next frame.
		const notice = projection.getSnapshot().find(row => row.content.startsWith("Session-only model:"));
		if (!notice) continue;
		expect(notice.content).toContain("\u{F0635}");
		vi.stubGlobal("window", { vomp: { platform } });
		try {
			const element = document.createElement("div");
			for (const mode of ["normal", "thinking", "verbose"] as const) {
				element.innerHTML = renderToStaticMarkup(createElement(NoticeRow, { entry: notice, mode }));
				expect(element.querySelector(".tsp-key-combinations")?.outerHTML).toBe(renderToStaticMarkup(createElement(KeyCombinations, { value: [{ t: chord, s: "key" }] })));
				expect([...element.querySelectorAll("kbd")].map(key => key.textContent)).toEqual(keys);
				expect(element.querySelector(".sr-only")?.textContent).toBe(spoken);
				expect(element.textContent).not.toMatch(/\p{Co}/u);
				expect(element.textContent).toContain("Session-only model: fixture/fixture-small. Use ");
				expect(element.textContent).toContain(" or /model for roles.");
			}
		} finally { vi.unstubAllGlobals(); }
		return;
	}
	throw new Error("The recording did not project the session-only model notice.");
});

it("leaves other projected notices containing terminal glyphs literal", () => {
	const content = "A quoted shortcut \u{F0635} M or /model for roles.";
	const element = document.createElement("div");
	element.innerHTML = renderToStaticMarkup(createElement(NoticeRow, { entry: { customType: "tsp-notice", content }, mode: "normal" }));
	expect(element.querySelector("p")?.textContent).toBe(content);
	expect(element.querySelector("kbd")).toBeNull();
});
