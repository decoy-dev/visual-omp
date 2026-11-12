import { createRoot } from "react-dom/client";
import { Profiler, memo, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { motion } from "motion/react";
import { z } from "zod";
import { ToolCard } from "../../../chat/transcript/ToolCard";
import { FileRefContext } from "../../../chat/transcript/fileRefScope";
import { GuestClient, type GuestSnapshot } from "../../../collab/lib/client";
import type { ToolResultLike } from "../../../tool-render/types";
import { PresentationVisibility } from "../../../state/tsp/presentation-claims";
import { ObservedShellProvider, type ObservedShellStore } from "../observed";
import { MotionProvider } from "../../../ui/motion";
import { TooltipProvider } from "../../../ui/Tooltip";
import { Button } from "../../../ui/Button";
import type { ShellFrame } from "@shared/shell-visualization";
import { shellProps, type TspShellProps } from "@shared/tsp/shell";
import { Composer } from "../../../chat/composer/Composer";
import { useComposerDrafts } from "../../../chat/composer/drafts";
import { Shortcuts } from "../../palette/Shortcuts";
import { useModifierHeld } from "../../../shell/hooks";
import { useApp } from "../../../state/app";
import { SessionController } from "../../../state/session";
import "../../../i18n";
import "../../../theme/tokens.css";
import "../../../theme/base.css";
import "../../../ui/ui.css";
import "../../../tool-render/tool-render.css";
import "../../../chat/transcript/transcript.css";

const bridge = new URLSearchParams(location.search).get("bridge");
if (!bridge || new URL(bridge).hostname !== "127.0.0.1") throw new Error("Provide the isolated classic bridge.");
const Frame = z.object({ handle: z.string(), revision: z.number(), sourceRevision: z.number().optional(), props: z.custom<TspShellProps>(value => !!shellProps(value)) });
const listeners = new Map<string, Set<(value: unknown) => void>>();
const changes = new Set<() => void>();
const statusChanges = new Set<() => void>();
const cardChanges = new Set<() => void>();
const invokes: object[] = [];
const received: object[] = [];
const commits: object[] = [];
const renders: object[] = [];
const ipcEvents: object[] = [];
const keyEvents: object[] = [];
let pageCloses = 0;
let guest: GuestClient | undefined;
let packet: GuestSnapshot | undefined;
let cwd = "";
let sourceRevision = 0;
let lastTrace: unknown;
let cards: { id: string; name: string; args: unknown; result?: ToolResultLike; running: boolean; partialResult?: unknown }[] = [];
let cardKey = "";
let lastFrame: ShellFrame | undefined;
let pendingFrames: { at: number; frame: ShellFrame }[] = [];
const store: ObservedShellStore = { subscribe: listener => { changes.add(listener); return () => changes.delete(listener); }, getSnapshot: () => packet ?? null };
async function post(path: string, body: unknown = {}) {
  const response = await fetch(bridge + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
function emit(channel: string, value: unknown) { for (const listener of listeners.get(channel) ?? []) listener(value); }
Object.defineProperty(window, "vomp", { configurable: true, value: {
  platform: "darwin",
  on(channel: string, callback: (value: unknown) => void) { const set = listeners.get(channel) ?? new Set(); set.add(callback); listeners.set(channel, set); return () => set.delete(callback); },
  async invoke(channel: string, ...args: unknown[]) {
    if (!/^(config:|shell-viz:)/.test(channel)) throw new Error(`Owning-host operation forbidden: ${channel}`);
    const started = performance.now();
    const result = (await post("/invoke", { channel, args })).result;
    const source = args[0] && typeof args[0] === "object" && "json" in args[0] ? args[0] : undefined;
    invokes.push({ at: started, durationMs: performance.now() - started, channel, sourceRevision: source && "sourceRevision" in source ? source.sourceRevision : undefined, result: result?.status === "ready" ? { handle: result.handle, revision: result.revision, sourceRevision: result.sourceRevision, timeline: result.props.presentation.timeline, preferences: result.props.presentation.preferences } : result });
    if (result?.status === "ready") { const frame = Frame.parse(result); lastFrame = frame; pendingFrames.push({ at: performance.now(), frame }); }
    return result;
  },
} });
const events = new EventSource(bridge + "/events");
events.addEventListener("ipc", event => {
  const value = JSON.parse(event.data);
  ipcEvents.push({ at: performance.now(), wallAt: Date.now(), channel: value.channel, value: value.channel === "shell-viz:frame" ? { handle: value.value.handle, revision: value.value.revision, sourceRevision: value.value.sourceRevision } : value.value });
  if (value.channel === "shell-viz:frame") { const frame = Frame.parse(value.value); lastFrame = frame; pendingFrames.push({ at: performance.now(), frame }); }
  emit(value.channel, value.value);
});
function updateGuest() {
  packet = guest!.getSnapshot();
  const tool = [...packet.activeTools.values()].at(-1) ?? [...packet.backgroundTools.values()].at(-1);
  const partial = tool?.partialResult;
  const details = partial && typeof partial === "object" && "details" in partial ? partial.details : undefined;
  const trace = details && typeof details === "object" && "trace" in details ? details.trace : undefined;
  if (trace && trace !== lastTrace) {
    lastTrace = trace; sourceRevision++;
    received.push({ at: performance.now(), wallAt: Date.now(), sourceRevision, toolCallId: tool?.toolCallId, seq: typeof trace === "object" && "seq" in trace ? trace.seq : undefined, active: packet.activeTools.size, background: packet.backgroundTools.size, working: packet.working });
  }
  // Production provider subscribes to these exact GuestClient maps, without trace reduction or polling.
  for (const listener of changes) listener();
  const results = new Map(packet.entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [[entry.message.toolCallId, entry.message] as const] : []));
  const nextCards = packet.entries.flatMap(entry => entry.type === "message" && entry.message.role === "assistant" ? entry.message.content.flatMap(block => block.type === "toolCall" ? [{ id: block.id, name: block.name, args: block.arguments, result: results.get(block.id), running: packet!.activeTools.has(block.id), partialResult: packet!.activeTools.get(block.id)?.partialResult }] : []) : []);
  const key = JSON.stringify(nextCards);
  if (key !== cardKey) { cardKey = key; cards = nextCards; for (const listener of cardChanges) listener(); }
  for (const listener of statusChanges) listener();
}
void fetch(bridge + "/connection").then(response => response.json()).then(value => {
  const connection = z.object({ link: z.string(), cwd: z.string() }).parse(value);
  cwd = connection.cwd;
  guest = new GuestClient(connection.link, "Classic browser acceptance");
  guest.setForeground(true); guest.subscribe(updateGuest); guest.connect(); updateGuest();
});
window.addEventListener("beforeunload", () => { guest?.close(); events.close(); });
const Cards = memo(function Cards() {
  const calls = useSyncExternalStore(listener => { cardChanges.add(listener); return () => cardChanges.delete(listener); }, () => cards);
  renders.push({ at: performance.now(), component: "cards", count: calls.length });
  return <div>{calls.map(call => <div key={call.id} data-fixture-call={call.id}><ToolCard name={call.name} args={call.args} result={call.result} running={call.running} partialResult={call.partialResult} verbose={true} toolCallId={call.id} engageId={call.id} /></div>)}</div>;
});
function Status() {
  const state = useSyncExternalStore(listener => { statusChanges.add(listener); return () => statusChanges.delete(listener); }, () => packet);
  return <p id="classic-status" className="text-sm text-fg-muted" data-working={state?.working} data-active={state?.activeTools.size} data-background={state?.backgroundTools.size}>Source revision {sourceRevision}. Active calls {state?.activeTools.size ?? 0}. Background calls {state?.backgroundTools.size ?? 0}. {state?.working ? "Chat is working." : "Chat is idle."}</p>;
}
function KeyboardEnvironment({ folder }: { folder: string }) {
  const controller = useMemo(() => new SessionController({ tabId: "classic-keyboard-composer", projectPath: folder, sessionFile: null }), [folder]);
  const modifierHeld = useModifierHeld();
  useEffect(() => {
    const original = useApp.getState();
    useApp.setState({ view: "chat", closePage: () => { pageCloses++; original.closePage(); } });
    useComposerDrafts.getState().setDraft(controller.tabId, "unsent composer sentinel");
    const capture = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const before = event.defaultPrevented;
      queueMicrotask(() => {
        const composer = document.querySelector<HTMLTextAreaElement>("[data-fixture-composer] textarea");
        keyEvents.push({ at: performance.now(), key: event.key, code: event.code, target: target?.getAttribute("role") ?? target?.tagName, preventedAtCapture: before, preventedAfterDispatch: event.defaultPrevented, composerFocused: document.activeElement === composer, composerValue: composer?.value, pageCloses });
      });
    };
    window.addEventListener("keydown", capture, true);
    return () => {
      window.removeEventListener("keydown", capture, true);
      useApp.setState({ view: original.view, closePage: original.closePage });
      void controller.dispose();
    };
  }, [controller]);
  return <><Shortcuts /><p data-fixture-modifier-held={modifierHeld} className="sr-only">App modifier tracking is mounted.</p><div data-fixture-composer><Composer session={controller} /></div></>;
}
function Harness() {
  const [scope, setScope] = useState<{ identity: string; cwd: string }>();
  const [hidden, setHidden] = useState(false);
  const [mounted, setMounted] = useState(true);
  useEffect(() => {
    const refresh = () => { const id = packet?.header?.id; if (id) setScope(previous => previous?.identity === id ? previous : { identity: id, cwd }); };
    statusChanges.add(refresh); refresh();
    return () => { statusChanges.delete(refresh); };
  }, []);
  return <MotionProvider><TooltipProvider><motion.main layoutScroll className="mx-auto h-screen max-w-[960px] space-y-4 overflow-auto bg-sheet p-4 text-fg">
    <h1 className="text-xl font-semibold">Classic bash visualization</h1><p className="text-sm text-fg-muted">Installed omp, classic terminal host, collab trace updates and isolated native presentation.</p>
    <div className="flex flex-wrap items-center gap-2"><Button onClick={() => void post("/run")}>Run fixed command</Button><Button onClick={() => setHidden(!hidden)}>Toggle visibility</Button><Button onClick={() => setMounted(!mounted)}>Toggle mount</Button></div>
    <Status />
    {scope && <KeyboardEnvironment folder={scope.cwd} />}
    {scope && mounted && <PresentationVisibility visible={!hidden}><ObservedShellProvider store={store} identity={scope.identity} cwd={scope.cwd}><FileRefContext.Provider value={{ chat: scope.identity, bases: [scope.cwd] }}><div hidden={hidden}><Profiler id="classic-card" onRender={(_id, phase, duration, _base, _start, commit) => {
      const candidates = pendingFrames; pendingFrames = [];
      commits.push({ at: performance.now(), wallAt: Date.now(), phase, durationMs: duration, commit, sourceRevision, frames: candidates.map(item => ({ at: item.at, handle: item.frame.handle, revision: item.frame.revision, sourceRevision: item.frame.sourceRevision })), dom: document.querySelector(".shell-view")?.textContent, status: document.getElementById("classic-status")?.dataset });
    }}><Cards /></Profiler></div></FileRefContext.Provider></ObservedShellProvider></PresentationVisibility>}
  </motion.main></TooltipProvider></MotionProvider>;
}
Object.defineProperty(window, "shellClassicFixture", { value: {
  evidence: () => ({ invokes, received, commits, renders, ipcEvents, keyEvents, pageCloses, lastFrame, packet: packet && { sourceRevision, phase: packet.phase, readOnly: packet.readOnly, endedReason: packet.endedReason, notices: packet.notices, header: packet.header, working: packet.working, active: packet.activeTools.size, background: packet.backgroundTools.size } }),
  save: async () => post("/evidence", { invokes, received, commits, renders, ipcEvents, keyEvents, pageCloses, lastFrame }),
  setting: (enabled: boolean) => post("/setting", { enabled }),
  refuse: (reason: "unavailable" | "too-large" | null) => post("/refuse", { reason }),
} });
createRoot(document.getElementById("root")!).render(<Harness />);
