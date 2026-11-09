// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { commandPanelFrames } from "@shared/tsp/testing/command-panel-fixtures";
import { walkNodes } from "@shared/tsp/view-state";
import type { SessionController, SessionView } from "../../state/session";
import { PresentationVisibility, presentationClaims } from "../../state/tsp/presentation-claims";
import { CommandPanelOwnership, startCommandPanels } from "./command-panels";
import { commandResults, dismissCommandResult, type CommandResultRecord } from "./results";

const fake = vi.hoisted(() => ({ snapshot: null as TspHostSnapshot | null, listeners: new Set<() => void>(), invoke: vi.fn(async () => undefined) }));
vi.mock("../../state/tsp/hosts", () => ({ tspHost: (hostId: string) => ({ hostId, getSnapshot: () => fake.snapshot, subscribe: (listener: () => void) => { fake.listeners.add(listener); return () => fake.listeners.delete(listener); } }) }));
vi.mock("../../state/tsp/useTsp", () => ({ useTsp: () => ({ snapshot: fake.snapshot }) }));
let element: HTMLDivElement; let root: Root;
const stops: (() => void)[] = [];
function chat() {
	const listeners = new Set<() => void>(); const events = new Set<(event: { kind: string }) => void>();
	let view = { mode: "live", host: { hostId: "host", sessionId: "room", generation: 1, transport: "tsp" } } as unknown as SessionView;
	const guest = {};
	const session = { getSnapshot: () => view, guestClient: () => guest, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }, onEvent: (listener: (event: { kind: string }) => void) => { events.add(listener); return () => events.delete(listener); } } as unknown as SessionController;
	return { session, change: (patch: Partial<SessionView>) => { view = { ...view, ...patch }; for (const listener of listeners) listener(); }, event: (kind: string) => { for (const listener of events) listener({ kind }); } };
}
const publish = (snapshot: TspHostSnapshot) => { fake.snapshot = snapshot; for (const listener of fake.listeners) listener(); };
async function render(result: CommandResultRecord, visible = true, onRelease = () => {}) {
	await act(async () => root.render(createElement(PresentationVisibility, { visible }, createElement("section", null, createElement("pre", null, result.lines.join("\n")), createElement(CommandPanelOwnership, { result, onRelease })))));
}
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); fake.listeners.clear(); fake.invoke.mockReset().mockResolvedValue(undefined); Object.assign(window, { vomp: { invoke: fake.invoke } }); element = document.createElement("div"); document.body.append(element); root = createRoot(element); });
afterEach(async () => { await act(async () => root.unmount()); for (const stop of stops.splice(0)) stop(); element.remove(); });
it("records a report once, claims only after visible presentation, then closes the declared node once", async () => {
	const frames = commandPanelFrames("advisor-status"); const { session } = chat(); fake.snapshot = frames[0]!;
	stops.push(startCommandPanels(session, "/advisor status", frames[0]!, "anchor", "room"));
	publish(frames.at(-1)!); publish(frames.at(-1)!);
	const results = commandResults(session); expect(results).toHaveLength(1); const result = results[0]!;
	expect(result).toMatchObject({ command: "/advisor status", title: "Advisor Status", lines: ["Advisor is disabled."], anchor: "anchor", room: "room" });
	expect(fake.invoke).not.toHaveBeenCalled(); expect(presentationClaims.getSnapshot()).toHaveLength(0);
	await render(result, false); expect(fake.invoke).not.toHaveBeenCalled(); expect(presentationClaims.getSnapshot()).toHaveLength(0);
	await render(result); expect(presentationClaims.getSnapshot()).toHaveLength(1);
	expect(fake.invoke).toHaveBeenCalledExactlyOnceWith("host:tsp-event", "host", 1, { ev: "action", sf: result.panel!.surfaceId, id: result.panel!.close!.id, act: "close" }, result.panel!.epoch);
	await render(result); expect(fake.invoke).toHaveBeenCalledTimes(1);
	await act(async () => root.render(null)); expect(presentationClaims.getSnapshot()).toHaveLength(0);
	await render(result); expect(fake.invoke).toHaveBeenCalledTimes(1);
});
it("carries recorded report Markdown into the retained Result", () => {
	const frames = commandPanelFrames("tools"); const { session } = chat(); fake.snapshot = frames[0]!;
	stops.push(startCommandPanels(session, "/tools", frames[0]!, null, "room"));
	for (const frame of frames.slice(1)) publish(frame);
	expect(commandResults(session)).toMatchObject([{ command: "/tools", markdown: true }]);
	expect(commandResults(session)[0]!.lines[0]).toBe("| Tool | Description |");
});
it.each(["epoch", "generation", "room", "disposed", "sent"])("does not attach delayed panel feedback after %s invalidation", kind => {
	const frames = commandPanelFrames("advisor-status"); const owner = chat(); fake.snapshot = frames[0]!;
	stops.push(startCommandPanels(owner.session, "/advisor status", frames[0]!, null, "room"));
	if (kind === "room") owner.change({ host: { ...owner.session.getSnapshot().host!, sessionId: "other" } });
	else if (kind === "disposed" || kind === "sent") owner.event(kind);
	const after = structuredClone(frames.at(-1)!);
	if (kind === "epoch") after.epoch++;
	if (kind === "generation") after.generation++;
	publish(after); expect(commandResults(owner.session)).toEqual([]); expect(fake.listeners.size).toBe(0);
});
it("retains cleanse outcomes after their hook questions close and after panel dismissal", async () => {
	const frames = commandPanelFrames("cleanse"); const { session } = chat(); fake.snapshot = frames[0]!;
	stops.push(startCommandPanels(session, "/cleanse", frames[0]!, null, "room"));
	for (const frame of frames.slice(1)) publish(frame);
	const result = commandResults(session)[0]!; expect(result.tone).toBe("warn"); expect(result.lines[0]).toBe("No runnable checker");
	await render(result); expect(presentationClaims.getSnapshot()).toHaveLength(1); expect(fake.invoke).not.toHaveBeenCalled();
	const closed = structuredClone(frames.at(-1)!); closed.surfaces[0]!.document.c = [];
	publish(closed); await render(result); expect(presentationClaims.getSnapshot()).toHaveLength(0); expect(commandResults(session)).toHaveLength(1);
});
it("retains the omfg settled error and refuses unsupported report content", () => {
	const { session } = chat(); const frames = commandPanelFrames("omfg-error-panel"); fake.snapshot = frames[0]!;
	stops.push(startCommandPanels(session, "/omfg Stop repeating fixture text", frames[0]!, null, "room"));
	for (const frame of frames.slice(1)) publish(frame);
	expect(commandResults(session)[0]).toMatchObject({ tone: "err", lines: ["Error", "Could not create rule.", "The model did not return a valid TTSR rule."] });
	const reports = commandPanelFrames("advisor-status"); const other = chat(); fake.snapshot = reports[0]!;
	stops.push(startCommandPanels(other.session, "/advisor status", reports[0]!, null, "room"));
	const unsupported = structuredClone(reports.at(-1)!); const node = [...walkNodes(unsupported.surfaces[0]!.document)].find(item => item.p?.role === "omp.overlay.report")!;
	node.c = [...node.c!, { id: "unknown", k: "button", p: { text: "New action", actions: { click: "future" } } }]; publish(unsupported);
	expect(commandResults(other.session)).toEqual([]);
});
it("returns a failed Close to fallback by releasing its native Result", async () => {
	const frames = commandPanelFrames("advisor-status"); const { session } = chat(); fake.snapshot = frames[0]!;
	stops.push(startCommandPanels(session, "/advisor status", frames[0]!, null, "room")); publish(frames.at(-1)!);
	const result = commandResults(session)[0]!; fake.invoke.mockRejectedValueOnce(new Error("Unavailable action"));
	const release = vi.fn(() => dismissCommandResult(session, result.id)); await render(result, true, release);
	expect(release).toHaveBeenCalledOnce(); expect(commandResults(session)).toEqual([]);
});

it.each(["rotation", "removal"])("retains the only saved report when Close rejects after %s", async kind => {
	const frames = commandPanelFrames("advisor-status"); const { session } = chat(); fake.snapshot = frames[0]!;
	stops.push(startCommandPanels(session, "/advisor status", frames[0]!, null, "room")); publish(frames.at(-1)!);
	const result = commandResults(session)[0]!;
	const pending = Promise.withResolvers<undefined>(); fake.invoke.mockReturnValueOnce(pending.promise);
	const release = vi.fn(() => dismissCommandResult(session, result.id));
	await render(result, true, release);
	const after = structuredClone(fake.snapshot!);
	if (kind === "rotation") after.epoch++;
	else after.surfaces[0]!.document.c = [];
	fake.snapshot = after;
	await act(async () => { pending.reject(new Error("Old report closed")); await pending.promise.catch(() => undefined); });
	expect(release).not.toHaveBeenCalled(); expect(commandResults(session)).toHaveLength(1);
});

it("does not attribute a cleanse panel to a command with a matching prefix", () => {
	const frames = commandPanelFrames("cleanse"); const { session } = chat(); fake.snapshot = frames[0]!;
	stops.push(startCommandPanels(session, "/cleanse-extra", frames[0]!, null, "room"));
	for (const frame of frames.slice(1)) publish(frame);
	expect(commandResults(session)).toEqual([]);
});
