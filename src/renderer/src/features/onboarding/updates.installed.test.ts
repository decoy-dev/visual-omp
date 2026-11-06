import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostState } from "@shared/ipc";
import type { NativeSnapshot } from "@shared/contracts/native";
import type { SessionView } from "../../state/session";
const fake = vi.hoisted(() => ({
 listeners: new Map<string, (value: unknown) => void>(), controllers: [] as FakeChat[],
 toast: vi.fn(), updateToast: vi.fn(), openSheet: vi.fn(), refreshOmp: vi.fn(async () => {}), acknowledged: null as string | null, pending: null as string | null,
}));
vi.mock("../../ui", () => ({ toast: fake.toast, updateToast: fake.updateToast, dismissToast: vi.fn() }));
vi.mock("../../state/app", () => ({ allControllers: () => fake.controllers, controllerFor: (id: string) => fake.controllers.find(c => c.tabId === id), useApp: { getState: () => ({ openSheet: fake.openSheet, refreshOmp: fake.refreshOmp }) } }));
vi.mock("./quit", () => ({ quitAfterConfirm: vi.fn() }));
vi.mock("../../registry/commands", () => ({ registerCommand: vi.fn() }));
vi.mock("../../registry/slots", () => ({ sheets: { register: vi.fn() } }));
import { installUpdateWatchers, reconcileInstalledOmp, restartStaleChats, acknowledgeOmpNotes, useUpdates, OMP_NOTES_SHEET } from "./updates";
const snapshot = (version: string, generation = 1): NativeSnapshot => ({ modes: null, theme: null, ompVersion: version, asyncJobsGeneration: generation });
class FakeChat {
 readonly listeners = new Set<() => void>();
 // A narrow synthetic session sufficient for the real workInFlight predicate and update consumer.
 view = { mode: "live", working: false, host: { hostId: "", generation: 1 } as HostState, guest: null, readOnly: false, follow: null } as SessionView;
 constructor(readonly tabId: string) { this.view.host!.hostId = tabId; }
 getSnapshot = () => this.view;
 subscribe = (fn: () => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
 restart = vi.fn(async (guard?: () => void) => { guard?.(); });
 emit() { for (const fn of this.listeners) fn(); }
 engine(version: string, hostId = this.tabId, generation = 1) {
  this.view.host = { ...this.view.host!, hostId, generation };
  fake.listeners.get("native:changed")!({ hostId, snapshot: snapshot(version, generation) }); this.emit();
 }
}
function chat(id: string, version: string, working = false) {
 const controller = new FakeChat(id); controller.view.working = working; fake.controllers.push(controller); controller.engine(version); return controller;
}
const flush = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); };
beforeEach(() => {
 fake.listeners.clear(); fake.controllers.length = 0; fake.toast.mockClear(); fake.openSheet.mockClear(); fake.acknowledged = null;
 fake.pending = null; fake.updateToast.mockClear(); fake.toast.mockReturnValue("engine-notice");
 vi.stubGlobal("window", { vomp: {
  on: (channel: string, callback: (value: unknown) => void) => { fake.listeners.set(channel, callback); return () => {}; },
  invoke: vi.fn(async (channel: string, version?: string) => {
   if (channel === "updates:omp:acknowledge") fake.acknowledged = version ?? null;
   if (channel === "updates:omp:notice" || channel === "updates:omp:acknowledge") return { observedVersion: version, pendingVersion: fake.acknowledged === version ? null : fake.pending ?? version, acknowledgedVersion: fake.acknowledged };
   return null;
  }),
 } });
 useUpdates.setState({ installedOmp: null, staleChats: [], omp: null, restartingChats: 0 }); installUpdateWatchers();
});
describe("installed omp reconciliation", () => {
 it("notices external updates once, offers notes and leaves working chats alone", async () => {
  chat("old", "18.16.0", true); chat("new", "18.17.0"); reconcileInstalledOmp("18.17.0"); await flush();
  expect(useUpdates.getState().staleChats).toEqual(["old"]); expect(fake.toast).toHaveBeenCalledTimes(1);
  const notice = fake.toast.mock.calls[0]![0]; notice.secondaryAction.onClick(); expect(fake.openSheet).toHaveBeenCalledWith(OMP_NOTES_SHEET);
  reconcileInstalledOmp("18.17.0"); await flush(); expect(fake.toast).toHaveBeenCalledTimes(1);
  await restartStaleChats(); expect(fake.controllers[0]!.restart).not.toHaveBeenCalled();
 });
 it("retains stale identity until the current generation reports its actual engine", () => {
  const controller = chat("generation", "18.16.0"); reconcileInstalledOmp("18.17.1");
  controller.view.host!.generation = 2;
  fake.listeners.get("native:changed")!({ hostId: "generation", snapshot: snapshot("18.16.0", 1) });
  expect(useUpdates.getState().staleChats).toEqual(["generation"]);
  controller.engine("18.17.1", "generation", 2); expect(useUpdates.getState().staleChats).toEqual([]);
 });
 it("does not restart helper-only work", async () => {
  const controller = chat("helpers", "18.16.0");
  // Same helper metadata used by the Tasks running-count consumer.
  controller.view.guest = { agents: [{ id: "helper", displayName: "Helper", kind: "sub", status: "running" }], progress: new Map(), lifecycle: new Map() } as unknown as SessionView["guest"];
  reconcileInstalledOmp("18.17.3"); await restartStaleChats();
  expect(controller.restart).not.toHaveBeenCalled(); expect(useUpdates.getState().staleChats).toEqual(["helpers"]);
 });
 it("confirms a replacement host and reserves the batch through preparation", async () => {
  const controller = chat("replacement", "18.16.0"); reconcileInstalledOmp("18.17.4");
  const preparation = Promise.withResolvers<void>();
  controller.restart.mockImplementationOnce(async guard => { await preparation.promise; guard?.(); controller.engine("18.17.4", "replacement-new", 1); });
  const first = restartStaleChats(); await restartStaleChats(); expect(controller.restart).toHaveBeenCalledTimes(1);
  preparation.resolve(); await first;
  expect(useUpdates.getState().staleChats).toEqual([]); expect(useUpdates.getState().restartingChats).toBe(0);
 });
 it("does not confirm a new generation that still reports the old engine", async () => {
  const controller = chat("unchanged", "18.16.0"); reconcileInstalledOmp("18.17.5");
  controller.restart.mockImplementationOnce(async guard => { guard?.(); controller.engine("18.16.0", "unchanged", 2); });
  await restartStaleChats(); expect(useUpdates.getState().staleChats).toEqual(["unchanged"]);
  expect(fake.toast.mock.calls.some(([notice]) => notice.tone === "err")).toBe(true);
 });
 it("keeps the restart action independent of acknowledged notes", async () => {
  fake.acknowledged = "18.17.6"; chat("acknowledged", "18.16.0"); reconcileInstalledOmp("18.17.6"); await flush();
  expect(fake.toast).not.toHaveBeenCalled(); expect(useUpdates.getState().staleChats).toEqual(["acknowledged"]);
  await acknowledgeOmpNotes("18.17.6"); expect(fake.acknowledged).toBe("18.17.6");
 });
 it("updates the existing notice when exact host versions arrive or staleness clears", async () => {
  fake.pending = "18.17.7"; reconcileInstalledOmp("18.17.7"); await flush();
  expect(fake.toast.mock.calls[0]![0].secondaryAction).toBeUndefined();
  const controller = chat("late-version", "18.16.0");
  expect(fake.updateToast).toHaveBeenLastCalledWith("engine-notice", expect.objectContaining({ action: expect.objectContaining({ label: "Restart open chats" }) }));
  controller.engine("18.17.7", "late-version", 2);
  expect(fake.updateToast).toHaveBeenLastCalledWith("engine-notice", expect.objectContaining({ action: expect.objectContaining({ label: "What's new in omp" }), secondaryAction: undefined }));
  expect(fake.toast).toHaveBeenCalledTimes(1);
 });
 it("removes an obsolete update offer after a background installer replaces omp", () => {
  useUpdates.setState({ omp: { currentVersion: "18.16.0", latestVersion: "18.17.2", updateAvailable: true, channel: "stable", packageMovedTo: null, checkedAt: 1, fromCache: false, error: null } });
  reconcileInstalledOmp("18.17.2"); expect(useUpdates.getState().omp).toMatchObject({ currentVersion: "18.17.2", updateAvailable: false });
 });
});
