import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { it, vi } from "vitest";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { startFixture } from "../../../../scripts/live-preview-fixture/server.mjs";
import { fixtureEnvironment } from "../../../../scripts/live-preview-fixture/environment.mjs";
type Observation = Record<string, unknown> & { at?: number; event?: string };
const isolated = vi.hoisted(() => ({ env: {} as NodeJS.ProcessEnv, bin: "", agent: "", events: [] as Observation[] }));
vi.mock("../../env", () => ({ userEnv: async () => isolated.env, ptyEnv: (env: NodeJS.ProcessEnv) => env }));
vi.mock("../../ipc", () => ({ broadcast: vi.fn() }));
vi.mock("../../prefs", () => ({ getPrefs: () => ({ theme: "light", reducedMotion: "on" }) }));
vi.mock("../locate", () => ({ ompPath: async () => isolated.bin }));
vi.mock("../refused", () => ({ ompStartError: (error: unknown) => error }));
vi.mock("../paths", () => ({ agentDir: () => isolated.agent, sessionsDir: () => join(isolated.agent, "sessions") }));
vi.mock("../sessions", () => ({ findSessionFile: async () => null, onSessionsChanged: vi.fn() }));
vi.mock("../../services/diagnostics/events", () => ({ writeDiagnostic: (event: Observation) => isolated.events.push({ at: Date.now(), ...event }) }));
vi.mock("electron", () => ({ BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }, dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) }, nativeTheme: { on: vi.fn(), removeListener: vi.fn(), shouldUseDarkColors: false }, systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: true }) } }));
import { SessionHost } from "../host";
import { GuestClient } from "../../../renderer/src/collab/lib/client";

// Real platform time is required: omp runs in another process and owns heartbeat and reconnect timers.
it.skipIf(!process.env.OMP_BIN || !process.env.SEMANTIC_EVIDENCE)("records paused guest recovery and real omp room replacement", async () => {
 const root = await mkdtemp(join(tmpdir(), "vomp-semantic-run-"));
 const out = process.env.SEMANTIC_EVIDENCE!;
 await mkdir(out, { recursive: true });
 const fixture = await startFixture({ root, port: 0, durationMs: 0 });
 let host: SessionHost | undefined;
 let guest: GuestClient | undefined;
 const clientSockets: WebSocket[] = [];
 const serverSockets: { role: string | null; room: string; socket: WebSocket }[] = [];
 let sampler: NodeJS.Timeout | undefined;
 let frames = 0;
 let hostBytes = 0;
 const samples: Observation[] = [];
 const marks: Observation[] = [];
 let peakBacklog = 0;
 const originalUpgrade = WebSocketServer.prototype.handleUpgrade;
 vi.spyOn(WebSocketServer.prototype, "handleUpgrade").mockImplementation(function (this: WebSocketServer, req, socket, head, callback) {
  return originalUpgrade.call(this, req, socket, head, (ws, request) => {
   const url = new URL(req.url!, "http://localhost");
   serverSockets.push({ role: url.searchParams.get("role"), room: url.pathname, socket: ws });
   if (url.searchParams.get("role") === "host") ws.on("message", (data: RawData, binary: boolean) => { if (binary) { frames++; hostBytes += Buffer.byteLength(data as Buffer); } });
   callback(ws, request);
  });
 });
 class CapturedWebSocket extends WebSocket {
  constructor(url: string) { super(url); clientSockets.push(this); }
 }
 vi.stubGlobal("WebSocket", CapturedWebSocket);
 vi.stubEnv("VOMP_TSP", "1");
 const capture = (label?: string) => {
  const tsp = host?.tspSnapshot();
  const backlog = Math.max(0, ...serverSockets.filter(v => v.role === "guest").map(v => v.socket.bufferedAmount));
  peakBacklog = Math.max(peakBacklog, backlog);
  const value = { at: Date.now(), label, phase: host?.state.phase, generation: host?.state.generation, sessionId: host?.state.sessionId, link: host?.state.link, tspEpoch: tsp?.epoch, lifecycle: tsp?.lifecycle, availability: host?.state.tspAvailability, surfaces: tsp?.surfaces.map(v => ({ id: v.open.id, sequence: v.sequence, closed: v.closed, generation: v.documentGeneration })), guestPhase: guest?.getSnapshot().phase, agents: guest?.getSnapshot().agents, working: guest?.getSnapshot().working, frames, hostBytes, backlog };
  samples.push(value); if (label) { marks.push(value); console.log(JSON.stringify(value)); } return value;
 };
 const until = async (predicate: () => boolean, label: string, ms = 30000) => {
  const end = Date.now() + ms;
  while (!predicate()) { if (Date.now() > end || host?.state.phase === "exited") throw new Error(label); await sleep(50); }
 };
 try {
  isolated.bin = process.env.OMP_BIN!; isolated.env = fixtureEnvironment(root); isolated.agent = isolated.env.PI_CODING_AGENT_DIR!;
  host = new SessionHost({ cwd: join(root, "work"), extraArgs: ["--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--model", "fixture/preview", "--thinking", "off"] });
  await host.start();
  await until(() => host!.state.phase === "live" && !!host!.state.link && host!.state.tspAvailability?.available === true, "Host not ready");
  guest = new GuestClient(host.state.link!, "Semantic recovery fixture"); guest.connect();
  await until(() => guest!.getSnapshot().phase === "live", "Guest not ready");
  capture("initial"); sampler = setInterval(() => capture(), 250);
  const initialGeneration = host.state.generation;
  const paused = clientSockets.at(-1)!; paused.pause();
  capture("guest-paused");
  await host.submit("fixture helpers");
  await until(() => isolated.events.some(e => e.event === "collab-resync") || Date.now() - Number(marks[1]!.at) > 65000, "Workload timed out", 75000);
  capture("before-resume"); paused.resume();
  await until(() => clientSockets.length > 1 && guest!.getSnapshot().phase === "live", "Guest did not reconnect after backlog drop", 30000);
  capture("guest-resynced");
  marks.push({ label: "guest-generation-stable", stable: host.state.generation === initialGeneration });
  await until(() => host!.state.generation > initialGeneration || !guest!.getSnapshot().working && guest!.getSnapshot().agents.filter(a => a.kind === "sub").every(a => a.status !== "running") && guest!.getSnapshot().activeTools.size === 0, "Helpers did not settle or replace their room", 120000);
  if (host.state.generation === initialGeneration) {
   capture("idle-before-room-drop");
   serverSockets.findLast(v => v.role === "host" && v.socket.readyState === WebSocket.OPEN)!.socket.close(4001, "fixture room replacement");
   capture("host-relay-room-closed");
  }
  await until(() => host!.state.generation > initialGeneration && host!.state.phase === "live", "Replacement room did not attach", 90000);
  guest.close(); guest = new GuestClient(host.state.link!, "Replacement fixture"); guest.connect();
  await until(() => guest!.getSnapshot().phase === "live", "Replacement guest did not connect");
  capture("replacement-attached");
  await until(() => host!.state.tspAvailability?.available === true, "Semantic editor did not recover after room replacement", 10000);
  capture("replacement-editor-recovered");
  await host.submit("fixture notes");
  capture("submitted-after-replacement");
 } catch (error) { marks.push({ error: String(error) }); throw error; }
 finally {
  clearInterval(sampler); capture("final"); guest?.close();
  await writeFile(join(out, "evidence.json"), JSON.stringify({ root, marks, peakBacklog, events: isolated.events, samples }, null, 2));
  for (const ws of clientSockets) ws.resume();
  await host?.stop(); await fixture.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true });
 }
}, 280000);
