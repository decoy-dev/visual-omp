// Loaded explicitly over CDP from Vite. This file is not in the production app graph.
import { GuestClient } from '../collab/lib/client';
import { controllerFor, useApp } from '../state/app';
import { DEFAULT_DOCK } from '../state/dockLayout';
import type { HostState } from '@shared/ipc';
import type { HostFrame, AssistantMessage, SessionEntry, SessionHeader, SessionState } from '../collab/wire';

type Scenario = { root: string; projectPath: string; header: SessionHeader; entries: SessionEntry[]; helpers: { id: string; file: string; text: string }[]; assistant: AssistantMessage; state: SessionState; tabs: { id: string; sessionFile: string }[]; streamIntervalMs: number; helperIntervalMs: number; appendIntervalMs: number };
interface Probe { frame(kind: string, ms: number, subscribers: number): void; cost(name: string, ms: number): void; delivery(lagMs: number): void }
interface ReplayState { entries: number; helperCount: number; tick: number; counter: number; appended: number; sourceEnded: boolean; mode: string }
interface Replay { start(seconds: number): void; stop(): void; open(id: string): Promise<void>; tasks(): Promise<void>; state(): ReplayState }
const scope = window as unknown as { __vompSpeed?: Probe; __vompSpeedReplay?: Replay };
const probe = () => scope.__vompSpeed;
const nextPaint = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  return promise;
};
export async function install(data: Scenario) {
  if (!import.meta.env.DEV) throw new Error('Speed replay requires a development build.');
  const session = controllerFor('speed-heavy');
  if (!session || useApp.getState().tabs.some(tab => !tab.id.startsWith('speed-'))) throw new Error('Only the isolated speed layout may be replayed.');
  // A viewed history tab otherwise releases itself when the heavy chat opens.
  useApp.setState(state => ({ docks: { ...state.docks, 'speed-light': { ...DEFAULT_DOCK, width: DEFAULT_DOCK.width + 1 } } }));
  if (session.getSnapshot().host) throw new Error('The speed fixture must not have a real omp host.');
  const connect = GuestClient.prototype.connect;
  GuestClient.prototype.connect = function () {};
  try {
    const host: HostState = { hostId: 'speed-replay', sessionId: data.header.id, sessionFile: data.tabs[0].sessionFile, cwd: data.projectPath, phase: 'live', generation: 1, transport: 'tsp', link: 'ws://127.0.0.1:1/r/speedreplay01.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', error: null, tui: null, pid: null, exitCode: null, cols: 120, rows: 40 };
    session.attach(host);
  } finally { GuestClient.prototype.connect = connect; }
  const guest = session.guestClient();
  if (!guest) throw new Error('Replay could not attach the recorded guest.');
  const apply = (frame: HostFrame) => {
    const before = performance.now();
    guest.applyFrameForTest(frame);
    probe()?.frame(frame.t === 'bus' ? frame.channel : frame.t === 'event' ? frame.event.type : frame.t, performance.now() - before, 0);
  };
  const agents = data.helpers.map(helper => ({ id: helper.id, displayName: helper.id, kind: 'sub' as const, status: 'running' as const, hasSessionFile: true, createdAt: Date.now(), lastActivity: Date.now() }));
  apply({ t: 'welcome', proto: 3, header: data.header, state: data.state, agents, entryCount: data.entries.length } as HostFrame);
  apply({ t: 'snapshot-chunk', entries: data.entries, final: true });
  let tick = 0;
  const updateHelpers = () => {
    for (const [index, helper] of data.helpers.entries()) apply({ t: 'bus', channel: 'task:subagent:progress', data: { index, agent: 'scout', task: `Inspect batch ${index}`, sessionFile: helper.file, progress: { index, id: helper.id, agent: 'scout', task: `Inspect batch ${index}`, status: 'running', stage: `Reading source ${tick}`, completionPercent: tick % 100, lastIntent: 'Reading recorded source', currentTool: 'read', currentToolArgs: 'src/fixture.ts', recentTools: [], recentOutput: [`Progress ${tick}`], toolCount: tick, requests: tick + 1, tokens: tick * 100, cost: 0, durationMs: tick * data.helperIntervalMs } } });
  };
  updateHelpers();
  // Keep the real queued incremental helper reader and parsers, replacing only transport.
  guest.fetchTranscript = async (id, offset) => {
    const before = performance.now();
    const helper = data.helpers.find(helper => helper.id === id);
    if (!helper) throw new Error(`Unknown fixture helper ${id}`);
    const bytes = new TextEncoder().encode(helper.text);
    const result = { kind: 'rows' as const, text: new TextDecoder().decode(bytes.subarray(offset)), newSize: bytes.length };
    probe()?.cost('fixture.fetchTranscript', performance.now() - before);
    return result;
  };
  const clock = new Worker(new URL('./speedClock.worker.ts', import.meta.url), { type: 'module' });
  const ready = Promise.withResolvers<void>();
  clock.onmessage = event => { if (event.data.kind === 'ready') ready.resolve(); };
  clock.onerror = event => ready.reject(new Error(event.message));
  await ready.promise;
  let streamText = '';
  let streamTimestamp = Date.now();
  let counter = 0;
  let appended = 0;
  let sourceEnded = false;
  const helperParents = new Map(data.helpers.map(helper => [helper.id, (JSON.parse(helper.text.trim().split('\n').at(-1)!) as SessionEntry).id]));
  let parentId = data.entries.at(-1)?.id;
  const message = (): AssistantMessage => ({ ...data.assistant, content: [{ type: 'text', text: streamText }], timestamp: streamTimestamp, stopReason: 'stop' });
  const open = async (id: string) => {
    if (!useApp.getState().tabs.some(tab => tab.id === id)) throw new Error(`The fixture chat ${id} was released.`);
    useApp.getState().activateTab(id);
    await nextPaint();
    if (useApp.getState().activeTabId !== id) throw new Error(`The fixture did not activate ${id}.`);
  };
  const stop = () => { clock.onmessage = null; clock.terminate(); };
  let started = false;
  const start = (seconds: number) => {
    if (started) throw new Error('Prepare a fresh replay before starting another stream.');
    started = true;
    apply({ t: 'event', event: { type: 'agent_start' } });
    clock.postMessage({ streamMs: data.streamIntervalMs, helperMs: data.helperIntervalMs, appendMs: data.appendIntervalMs, streamForMs: seconds * 1000 });
  };
  clock.onmessage = (event: MessageEvent<{ kind: string; sentAt: number }>) => {
    const lag = performance.timeOrigin + performance.now() - event.data.sentAt;
    scope.__vompSpeed?.delivery(lag);
    if (event.data.kind === 'stream') {
      streamText += `the quick brown fox keeps streaming ${counter++} `;
      apply({ t: 'event', event: { type: 'message_update', message: message() } } as HostFrame);
    } else if (event.data.kind === 'helper') {
      tick++;
      updateHelpers();
    } else if (event.data.kind === 'stream-source-end') {
      sourceEnded = true;
    } else if (event.data.kind === 'append') {
      const completed = message();
      if (streamText) {
        apply({ t: 'event', event: { type: 'message_end', message: completed } } as HostFrame);
        const entry = { type: 'message', id: `speed-live-${++appended}`, parentId, timestamp: new Date().toISOString(), message: completed };
        parentId = entry.id;
        apply({ t: 'entry', entry } as HostFrame);
        streamText = '';
        streamTimestamp = Date.now();
      }
      for (const helper of data.helpers) {
        const id = `${helper.id}-live-${tick}`;
        helper.text += JSON.stringify({ type: 'message', id, parentId: helperParents.get(helper.id), timestamp: new Date().toISOString(), message: { ...completed, timestamp: Date.now(), content: [{ type: 'text', text: `Helper progress ${tick}.` }] } }) + '\n';
        helperParents.set(helper.id, id);
      }
    }
  };
  const replay: Replay = { start, stop, open, tasks: async () => { useApp.getState().showPane('tasks', session.tabId); await nextPaint(); }, state: () => ({ entries: guest.getSnapshot().entries.length, helperCount: guest.getSnapshot().agents.length, tick, counter, appended, sourceEnded, mode: session.getSnapshot().mode }) };
  scope.__vompSpeedReplay = replay;
  return replay.state();
}
