// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame, columnName, visibleOfficeWindow } from "./xlsx";
import type { LiveSubject, OfficeFrameCache, OfficeFrameSnapshot } from "../types";
import type { OfficeWindow } from "./xlsx-model";

const state = vi.hoisted(() => ({ frame: { grant: { token: "token", url: "vomp-preview://token/office.xlsx", assetRoot: true }, revision: 1 }, workers: [] as { terminate: ReturnType<typeof vi.fn> }[] }));
vi.mock("./usePreviewGrant", () => ({ usePreviewGrant: () => ({ frame: state.frame, error: false }) }));
vi.mock("../../../ui", () => ({ cn: (...classes: unknown[]) => classes.filter(Boolean).join(" ") }));
vi.mock("../../panes/common", () => ({ FileName: ({ name }: { name: string }) => name }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./xlsx.worker?worker", () => ({ default: class {
	onmessage: ((event: MessageEvent) => void) | null = null;
	terminate = vi.fn();
	constructor() { state.workers.push(this); }
	postMessage(message: { id: number; bytes?: Uint8Array; window?: OfficeWindow }) {
		const view = message.window;
		const result = message.bytes ? { sheets: [{ name: "Summary", rows: 50000, cols: 200 }, { name: "Other sheet", rows: 1, cols: 1 }] }
			: { ...view, cells: Array.from({ length: view!.rowEnd - view!.rowStart }, (_, row) => Array.from({ length: view!.colEnd - view!.colStart }, (_, col) => view!.sheet === 1 ? "Other value" : row === 0 && col === 0 ? "<img src=x onerror=alert(1)>" : String(view!.rowStart + row + 1))) };
		queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true, ...result } } as MessageEvent));
	}
} }));
let host: HTMLDivElement, root: Root;
const subject = { id: "sheet", kind: "file", format: "xlsx", path: "/project/office.xlsx", revision: 1, state: "saved" } as LiveSubject;
async function show(revision: number, officeCache?: OfficeFrameCache, onOfficeCheck?: (safe: boolean | null) => void) {
	state.frame = { ...state.frame, revision };
	await act(async () => root.render(createElement(Frame, { subject: { ...subject, revision }, projectPath: "/project", related: [], officeCache, onOfficeCheck })));
}
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	host = document.createElement("div"); document.body.append(host); root = createRoot(host); state.workers.length = 0;
	Object.defineProperty(window, "vomp", { configurable: true, value: { invoke: vi.fn(async () => ({ ok: true, bytes: new Uint8Array([1]), size: 1, mtimeMs: 1 })) } });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("virtualized Office spreadsheet", () => {
	it("renders text without HTML and keeps under 200 rows while scrolling", async () => {
		await show(1);
		expect(host.querySelector("img")).toBeNull(); expect(host.textContent).toContain("<img src=x onerror=alert(1)>");
		expect(host.querySelectorAll('[role="row"]').length).toBeLessThan(200);
		const grid = host.querySelector('[role="grid"]')! as HTMLDivElement;
		const rowHeight = parseFloat((host.querySelector('[role="row"][aria-rowindex="2"]') as HTMLElement).style.height);
		await act(async () => { grid.scrollTop = 49_950 * rowHeight; grid.dispatchEvent(new Event("scroll")); });
		expect(host.querySelectorAll('[role="row"]').length).toBeLessThan(200);
		expect(host.querySelector(`[aria-rowindex="${Math.floor(grid.scrollTop / rowHeight) - 4 + 2}"]`)).not.toBeNull();
	});
	it("switches sheets and terminates the old revision's worker", async () => {
		await show(1);
		await act(async () => (host.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click());
		expect(host.textContent).toContain("Other value"); expect(host.querySelector('[role="grid"]')?.getAttribute("aria-label")).toBe("Other sheet");
		await show(2);
		expect(state.workers[0]?.terminate).toHaveBeenCalledOnce();
		expect(state.workers).toHaveLength(2);
	});
	it("freezes the retained text window when an incomplete save terminates its worker", async () => {
		await show(1);
		const before = host.textContent;
		Object.defineProperty(window, "vomp", { configurable: true, value: { invoke: vi.fn(async () => ({ ok: false, reason: "incomplete" })) } });
		await show(2);
		expect(host.textContent).toContain(before);
		expect(host.querySelector('[role="grid"]')?.hasAttribute("inert")).toBe(true);
		expect((host.querySelector('[role="tab"]') as HTMLButtonElement).disabled).toBe(true);
		expect(state.workers[0]?.terminate).toHaveBeenCalledOnce();
	});
	it("restores cached workbook cells after the subject is reselected with an incomplete latest save", async () => {
		let snapshot: OfficeFrameSnapshot | null = null;
		const officeCache = { read: () => snapshot, write: (value: OfficeFrameSnapshot) => { snapshot = value; }, clear: () => { snapshot = null; } };
		await show(1, officeCache);
		expect(host.textContent).toContain("<img src=x onerror=alert(1)>");
		expect(officeCache.read()).not.toHaveProperty("bytes");
		expect(officeCache.read()?.format).toBe("xlsx");
		await act(async () => root.unmount()); root = createRoot(host);
		Object.defineProperty(window, "vomp", { configurable: true, value: { invoke: vi.fn(async () => ({ ok: false, reason: "incomplete" })) } });
		await show(2, officeCache);
		expect(host.querySelectorAll('[role="row"]').length).toBeGreaterThan(1);
		expect(host.textContent).toContain("<img src=x onerror=alert(1)>");
		expect(host.textContent).toContain("live.waitingForSave");
	});
	it("clamps visible windows to 48 rows and 30 columns at every viewport size", () => {
		for (const [height, width] of [[240, 320], [1200, 2500], [99999, 99999]]) {
			const view = visibleOfficeWindow(0, { name: "Sheet", rows: 100000, cols: 200, limited: true }, 12000, 1200, height!, width!, 32);
			expect(view.rowEnd - view.rowStart).toBeLessThanOrEqual(48); expect(view.colEnd - view.colStart).toBeLessThanOrEqual(30);
		}
		expect(columnName(0)).toBe("A"); expect(columnName(199)).toBe("GR");
	});
});

it.each(["revoked", "notFile", "missing"] as const)("clears mounted and reselected spreadsheet data after %s", async reason => {
	let snapshot: OfficeFrameSnapshot | null = null;
	const officeCache: OfficeFrameCache = { read: () => snapshot, write: value => { snapshot = value; }, clear: () => { snapshot = null; } };
	await show(1, officeCache);
	expect(host.querySelectorAll('[role="row"]').length).toBeGreaterThan(1);
	Object.defineProperty(window, "vomp", { configurable: true, value: { invoke: vi.fn(async () => ({ ok: false, reason })) } });
	await show(2, officeCache);
	expect(host.querySelector('[role="grid"]')).toBeNull(); expect(officeCache.read()).toBeNull();
	Object.defineProperty(window, "vomp", { configurable: true, value: { invoke: vi.fn(async () => ({ ok: true, bytes: new Uint8Array([1]), size: 1, mtimeMs: 1 })) } });
	await show(3, officeCache);
	expect(officeCache.read()?.revision).toBe(3);
	await act(async () => root.unmount()); root = createRoot(host);
	Object.defineProperty(window, "vomp", { configurable: true, value: { invoke: vi.fn(async () => ({ ok: false, reason })) } });
	await show(4, officeCache);
	expect(host.querySelector('[role="grid"]')).toBeNull(); expect(officeCache.read()).toBeNull();
});

it("restores the newer successful text window after truncation and reselection", async () => {
	let snapshot: OfficeFrameSnapshot | null = null;
	const officeCache: OfficeFrameCache = { read: () => snapshot, write: value => { snapshot = value; }, clear: () => { snapshot = null; } };
	await show(1, officeCache); await show(3, officeCache);
	expect(officeCache.read()?.revision).toBe(3);
	await act(async () => root.unmount()); root = createRoot(host);
	Object.defineProperty(window, "vomp", { configurable: true, value: { invoke: vi.fn(async () => ({ ok: false, reason: "incomplete" })) } });
	await show(4, officeCache);
	expect(host.querySelector('[id^="office-3-"]')).not.toBeNull();
	expect(host.textContent).toContain("live.waitingForSave");
});

it("defers an incomplete workbook without reporting unsafe bytes", async () => {
	const check = vi.fn();
	vi.mocked(window.vomp.invoke).mockResolvedValueOnce({ ok: false, reason: "incomplete" });
	await show(1, undefined, check);
	expect(check).toHaveBeenLastCalledWith(null);
	expect(check).not.toHaveBeenCalledWith(false);
	expect(host.textContent).toContain("live.waitingForSave");
});
