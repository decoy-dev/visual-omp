import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { spawn, type IPty } from 'node-pty';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { z } from 'zod';
import { LoopbackRelay } from '../../src/main/omp/relay';
import { GuestClient } from '../../src/renderer/src/collab/lib/client';
import { ShellVisualizationService } from '../../src/main/omp/shell-visualization';
import { createInstalledShellWorker } from '../../src/main/omp/shell-visualization-worker';
import { initializeFixture, fixtureEnvironment } from './environment.mjs';
import { setAppRendererUrl } from '../../src/main/services/app-origin';
import { parseCfgLeaf } from '../../src/main/services/omp-config';

// Actual classic terminal host, actual GuestClient data, and production read-only presentation service.
// The HTTP/SSE bridge replaces Electron transport only. It does not manufacture shell state.
const executable = process.env.OMP_BIN ?? '/Users/chrishaddox/.bun/bin/omp';
const destination = resolve(process.env.OMP_SHELL_EVIDENCE ?? '/tmp/vomp-classic-acceptance');
const root = await realpath(await mkdtemp(join(tmpdir(), 'vomp-classic-')));
const env = fixtureEnvironment(root);
const cwd = join(root, 'work');
const sessionDirectory = join(env.PI_CODING_AGENT_DIR, 'sessions', 'classic-acceptance');
const configFile = join(env.PI_CODING_AGENT_DIR, 'config.yml');
const execute = promisify(execFile);
const command = process.env.OMP_SHELL_CONTEXT_CHECK === '1'
  ? 'cd /; VALUE="café-0"; for STEP in $(seq 1 8); do VALUE="café-$STEP"; printf "%s\\n" "$VALUE"; sleep 0.25; done; printf "classic-complete\\n"'
  : 'VALUE="café-0"; for STEP in $(seq 1 160); do VALUE="café-$STEP"; printf "%s\\n" "$VALUE"; sleep 0.25; done; printf "classic-complete\\n"';
const prompt = 'Run the fixed classic background acceptance command.';
const clients = new Set<ServerResponse>();
const collab: object[] = [];
const terminal: object[] = [];
const requests: object[] = [];
const operations: object[] = [];
const frames: object[] = [];
const nativeRequests: object[] = [];
const sourceSnapshots: object[] = [];
const hostPrompts: object[] = [];
const browserEvidence: unknown[] = [];
const workerLosses: object[] = [];
const invalidations: object[] = [];
const errors: string[] = [];
let guest: GuestClient | undefined;
let child: IPty | undefined;
let ready = false;
let exited = false;
let sequence = 0;
let round = 0;
let latest: object | null = null;
let browserLink = '';
let sourceTrace: unknown;
let sourceRevision = 0;
let refuse: 'unavailable' | 'too-large' | null = null;
const stop = Promise.withResolvers<void>();
const relay = new LoopbackRelay();
let vite: ViteDevServer | undefined;
const now = () => Date.now();
const SnapshotSource = z.object({ sourceId: z.string(), sourceRevision: z.number(), json: z.string(), handle: z.string().optional(), requestId: z.string().optional() });
const SnapshotOpen = SnapshotSource.extend({ requestId: z.string(), toolCallId: z.string(), cwd: z.string(), executionCwd: z.string().optional(), cdSeparator: z.literal(';').optional() });
const SnapshotUpdate = SnapshotSource.extend({ handle: z.string(), executionCwd: z.string().optional(), cdSeparator: z.literal(';').optional() });
async function readSetting(folder: string) {
  assert.equal(await realpath(folder), cwd);
  const { stdout } = await execute(executable, ['read', 'cfg://display.shellVisualization'], { cwd: folder, env, timeout: 10_000 });
  return parseCfgLeaf(stdout);
}
function send(event: string, value: unknown) {
  const data = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
  for (const client of clients) client.write(data);
}
function publishGuest() {
  const state = guest!.getSnapshot();
  const tool = [...state.activeTools.values()].at(-1) ?? [...state.backgroundTools.values()].at(-1);
  const partial = tool?.partialResult;
  const details = partial && typeof partial === 'object' && 'details' in partial ? partial.details : undefined;
  const candidate = details && typeof details === 'object' && 'trace' in details ? details.trace : undefined;
  if (candidate && sourceTrace !== candidate) { sourceTrace = candidate; sourceRevision++; }
  const trace = z.object({ seq: z.number(), history: z.array(z.unknown()).optional(), status: z.string().optional() }).safeParse(sourceTrace);
  const packet = { at: now(), revision: ++sequence, sourceRevision, cwd, identity: state.header?.id ?? null,
    entries: state.entries, activeTools: [...state.activeTools], backgroundTools: [...state.backgroundTools], working: state.working };
  latest = packet;
  collab.push({ at: packet.at, revision: sequence, sourceRevision, seq: trace.success ? trace.data.seq : undefined, history: trace.success ? trace.data.history?.length : undefined, status: trace.success ? trace.data.status : undefined,
    active: [...state.activeTools.keys()], background: [...state.backgroundTools.keys()], working: state.working,
    results: state.entries.filter(entry => entry.type === 'message' && entry.message.role === 'toolResult').length });
  send('guest', packet);
}
const local = new ShellVisualizationService({
  loadTrace: async () => ({ status: 'unavailable' }),
  getSetting: (_key, folder) => readSetting(folder),
  createWorker: async (onLoss, signal) => {
    const worker = await createInstalledShellWorker({ executable, env, signal, onLoss: reason => { workerLosses.push({ at: now(), reason }); onLoss(reason); } });
    return { close: () => worker.close(), request: async request => {
      const started = now();
      let status: object = {};
      try { const data = await worker.request(request); status = { status: 'ready', responseBytes: Buffer.byteLength(JSON.stringify(data)) }; return data; }
      catch (error) { status = { status: 'rejected', reason: error && typeof error === 'object' && 'reason' in error ? error.reason : String(error) }; throw error; }
      finally { nativeRequests.push({ op: request.op, handle: request.handle, options: request.op === 'present' ? request.options : undefined, at: started, durationMs: now() - started, ...status }); }
    } };
  },
  onFrame: frame => { frames.push({ at: now(), ...frame }); send('ipc', { channel: 'shellviz:frame', value: frame }); },
  onInvalidated: value => { invalidations.push({ at: now(), ...value, lastSource: sourceSnapshots.at(-1) }); send('ipc', { channel: 'shellviz:invalidated', value }); },
});
async function persisted() {
  const files = (await readdir(sessionDirectory)).filter(file => file.endsWith('.jsonl'));
  return Promise.all(files.map(async name => {
    const file = join(sessionDirectory, name);
    const text = await readFile(file, 'utf8');
    const entries = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { file, sha256: createHash('sha256').update(text).digest('hex'), results: entries.flatMap(entry => entry.message?.role === 'toolResult' ? [{ id: entry.message.toolCallId, async: entry.message.details?.async, trace: entry.message.details?.trace }] : []) };
  }));
}
async function save() {
  const data = { executable, version: execFileSync(executable, ['--version'], { env, encoding: 'utf8' }).trim(), root, cwd, sessionDirectory,
    transport: 'classic terminal, no TSP handshake; browser GuestClient reads view-only collab link', command, settings: { thresholdMs: 400 }, requests, hostPrompts, terminal, collab, sourceSnapshots, operations, frames, nativeRequests, workerLosses, invalidations, browserEvidence, persisted: await persisted(), errors };
  await writeFile(join(destination, 'classic-evidence.json'), JSON.stringify(data, null, 2));
  return { destination, sourceRevision, seq: sourceTrace && typeof sourceTrace === 'object' && 'seq' in sourceTrace ? sourceTrace.seq : undefined, modelRequests: requests.length, operations: operations.length, frames: frames.length, errors };
}
const server = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.end(); return; }
  try {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      clients.add(res); if (latest) res.write(`event: guest\ndata: ${JSON.stringify(latest)}\n\n`);
      req.on('close', () => clients.delete(res)); return;
    }
    if (req.url === '/state') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ latest, collab: collab.slice(-8), operations: operations.slice(-8), frames: frames.slice(-4), modelRequests: requests.length })); return; }
    if (req.url === '/metrics') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        nativeRequests: nativeRequests.map(value => { const { op, handle, at, durationMs, status, reason } = value as Record<string, unknown>; return { op, handle, at, durationMs, status, reason }; }),
        frames: frames.map(value => { const { at, handle, revision, sourceRevision } = value as Record<string, unknown>; return { at, handle, revision, sourceRevision }; }),
        invalidations: invalidations.map(value => { const { at, handles, reason } = value as Record<string, unknown>; return { at, handles, reason }; }),
        workerLosses,
      }));
      return;
    }
    if (req.url === '/connection') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ link: browserLink, cwd })); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (req.url === '/run') {
      assert.ok(ready && guest); round++; hostPrompts.push({ at: now(), round, prompt }); await guest.sendPrompt(prompt); res.end('{}'); return;
    }
    if (req.url === '/setting') {
      const config = JSON.parse(await readFile(configFile, 'utf8'));
      config.display = { ...config.display, shellVisualization: body.enabled === true };
      await writeFile(configFile, JSON.stringify(config)); await local.settingsChanged();
      send('ipc', { channel: 'config:changed', value: { scope: 'global', cwd: null } }); res.end('{}'); return;
    }
    if (req.url === '/refuse') { assert.ok(body.reason === null || body.reason === 'unavailable' || body.reason === 'too-large'); refuse = body.reason; res.end('{}'); return; }
    if (req.url === '/evidence') { browserEvidence.push(body); res.end(JSON.stringify(await save())); return; }
    if (req.url === '/close') { res.end(JSON.stringify(await save())); stop.resolve(); return; }
    if (req.url === '/invoke') {
      const { channel, args } = z.object({ channel: z.string(), args: z.array(z.unknown()) }).parse(body);
      const started = now();
      const inputSource = SnapshotSource.safeParse(args[0]);
      if (inputSource.success) sourceSnapshots.push({ at: started, ...inputSource.data, trace: JSON.parse(inputSource.data.json), sourceBytes: Buffer.byteLength(inputSource.data.json), sha256: createHash('sha256').update(inputSource.data.json).digest('hex'), json: undefined });
      let result: unknown;
      if (channel === 'config:get') result = await readSetting(z.string().parse(args[1]));
      else if (channel === 'config:watch' || channel === 'config:unwatch') result = undefined;
      else if (channel === 'shellviz:openSnapshot' || channel === 'shellviz:updateSnapshot') {
        const request = channel === 'shellviz:openSnapshot' ? SnapshotOpen.parse(args[0]) : SnapshotUpdate.parse(args[0]);
        // Negative acceptance changes only JSON framing; valid-source runs pass exact collab JSON.
        if (refuse === 'too-large') request.json = ' '.repeat(16 * 1024 * 1024) + request.json;
        else if (refuse === 'unavailable') request.json = '{';
        result = channel === 'shellviz:openSnapshot' ? await local.openSnapshot(SnapshotOpen.parse(request)) : await local.updateSnapshot(SnapshotUpdate.parse(request));
      }
      else if (channel === 'shellviz:action') result = await local.action(String(args[0]), String(args[1]));
      else if (channel === 'shellviz:release') local.release(String(args[0]));
      else if (channel === 'shellviz:cancel') local.cancel(String(args[0]));
      else throw new Error(`Owning-host operation forbidden: ${channel}`);
      const parsedSource = SnapshotSource.safeParse(args[0]);
      const source = parsedSource.success ? parsedSource.data : undefined;
      operations.push({ at: started, durationMs: now() - started, channel, sourceFault: refuse, args: source?.json ? [{ ...source, json: undefined, traceSeq: JSON.parse(source.json).seq, sourceBytes: Buffer.byteLength(source.json) }] : args, nodeObserverRevision: sourceRevision, result });
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result })); return;
    }
    // Only this fixed prompt can request a tool. Background-completion turns answer without tools.
    const messages = z.array(z.object({ role: z.string(), content: z.unknown() })).parse(body.messages);
    const last = messages?.at(-1);
    const content = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
    const tool = last?.role === 'user' && content.includes(prompt);
    requests.push({ at: now(), tool, messages: messages?.length });
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `classic-call-${round}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ i: 'Observing classic background variables', command, timeout: 90 }) } }] } : { role: 'assistant', content: 'The fixed command is recorded.' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'classic', object: 'chat.completion.chunk', created: 1, model: 'preview', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ id: 'classic', object: 'chat.completion.chunk', created: 1, model: 'preview', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } catch (error) { errors.push(String(error)); res.writeHead(400).end(JSON.stringify({ error: String(error) })); }
});
async function until(predicate: () => boolean, label: string) {
  const deadline = now() + 30_000;
  while (!predicate()) { if (exited || now() > deadline) throw new Error(`${label}: ${errors.join('; ')}`); await sleep(25); }
}
try {
  await mkdir(destination, { recursive: true });
  const listening = Promise.withResolvers<void>(); server.listen(0, '127.0.0.1', listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const bridge = `http://127.0.0.1:${address.port}`;
  await initializeFixture(root, bridge + '/v1');
  await relay.start();
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  Object.assign(config, { collab: { autoStart: 'control', relayUrl: relay.url, displayName: 'Classic acceptance' },
    display: { shellVisualization: true }, bash: { autoBackground: { enabled: true, thresholdMs: 400 } }, async: { enabled: true }, update: { auto: false } });
  await writeFile(configFile, JSON.stringify(config)); await mkdir(sessionDirectory, { recursive: true });
  child = spawn(executable, ['--no-extensions', '--no-skills', '--no-rules', '--no-context-files', '--no-lsp', '--no-title', '--no-pty', '--tools', 'bash', '--session-dir', sessionDirectory, '--model', 'fixture/preview', '--thinking', 'off'], { cwd, env, cols: 120, rows: 36, name: 'xterm-256color' });
  child.onExit(() => { exited = true; });
  child.onData(data => {
    terminal.push({ at: now(), data });
    if (data.includes('\u001b[c')) child!.write('\u001b[?62;22c');
    if (data.includes('\u001b[6n')) child!.write('\u001b[1;1R');
  });
  let hosts: { instanceId: string }[] = [];
  await until(() => { hosts = JSON.parse(execFileSync(executable, ['collab', 'list', '--json'], { env, encoding: 'utf8' })).hosts; return hosts.length === 1; }, 'Classic collab host did not register');
  const link = JSON.parse(execFileSync(executable, ['collab', 'link', hosts[0]!.instanceId, '--json'], { env, encoding: 'utf8' })).url;
  browserLink = z.object({ url: z.string() }).parse(JSON.parse(execFileSync(executable, ['collab', 'link', hosts[0]!.instanceId, '--view', '--json'], { env, encoding: 'utf8' }))).url;
  guest = new GuestClient(link, 'Classic visualization acceptance'); guest.setForeground(true); guest.subscribe(publishGuest); guest.connect();
  await until(() => guest!.getSnapshot().phase === 'live', 'Classic collab did not connect');
  ready = true;
  const repo = resolve(import.meta.dirname, '../..');
  vite = await createViteServer({ configFile: false, root: join(repo, 'src/renderer'), cacheDir: join(root, 'vite-cache'), plugins: [react(), tailwindcss()], resolve: { alias: { '@shared': join(repo, 'src/shared'), '@': join(repo, 'src/renderer/src'), '@oh-my-pi/pi-wire': join(repo, 'src/renderer/src/collab/wire/index.ts'), '@oh-my-pi/pi-utils/marked': 'marked', '@oh-my-pi/pi-utils/math-delimiters': join(repo, 'src/renderer/src/collab/math-delimiters.ts') } }, server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } });
  await vite.listen();
  const url = `${vite.resolvedUrls!.local[0]}src/features/shell-visualization/testing/classic.html?bridge=${encodeURIComponent(bridge)}`;
  setAppRendererUrl(url);
  await writeFile(join(destination, 'classic-ready.json'), JSON.stringify({ url, bridge, root, hostPid: child.pid }));
  console.log(JSON.stringify({ ready: true, url, bridge, destination }));
  process.on('SIGTERM', stop.resolve); process.on('SIGINT', stop.resolve);
  await stop.promise;
} finally {
  await save().catch(error => console.error(error));
  await local.close(); guest?.close(); relay.stop();
  for (const client of clients) client.end(); server.closeAllConnections();
  const serverClosed = Promise.withResolvers<void>(); server.close(() => serverClosed.resolve()); await serverClosed.promise;
  await vite?.close();
  if (child && !exited) { child.kill('SIGTERM'); await sleep(250); if (!exited) child.kill('SIGKILL'); }
  console.log(JSON.stringify({ stopped: true, destination }));
}
