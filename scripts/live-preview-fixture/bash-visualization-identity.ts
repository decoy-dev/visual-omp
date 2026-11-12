import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, copyFile, stat, realpath, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn, type IPty } from 'node-pty';
import { z } from 'zod';
import { TspSession } from '../../src/main/omp/tsp/session';
import { TspStream } from '../../src/main/omp/tsp/stream';
import { encodeTspJson } from '../../src/main/omp/tsp/encode';
import { LoopbackRelay } from '../../src/main/omp/relay';
import { GuestClient } from '../../src/renderer/src/collab/lib/client';
import { initializeFixture, fixtureEnvironment } from './environment.mjs';
import { TSP_KINDS } from '../../src/shared/tsp';
import type { TspHostSnapshot } from '../../src/shared/tsp-host';
import { createHash } from 'node:crypto';
import { ShellVisualizationService } from '../../src/main/omp/shell-visualization';
import { createInstalledShellWorker } from '../../src/main/omp/shell-visualization-worker';
import { loadSavedShellTrace } from '../../src/main/omp/session-tool-output';
import { helperSessionFile } from '../../src/main/omp/helper-file';
import type { ShellOpenRequest } from '../../src/shared/shell-visualization';
import { promisify } from 'node:util';
import { parseCfgLeaf } from '../../src/main/services/omp-config';

type EvidenceNode = { id: string; k: string; p?: Record<string, unknown>; c?: EvidenceNode[] };
const Node: z.ZodType<EvidenceNode> = z.lazy(() => z.object({ id: z.string(), k: z.string(), p: z.record(z.string(), z.unknown()).optional(), c: z.array(Node).optional() }));
const Presentation = z.object({ rows: z.array(z.unknown()), watches: z.array(z.unknown()) }).loose();
const binary = process.env.OMP_BIN ?? 'omp';
const destination = resolve(process.env.OMP_SHELL_EVIDENCE ?? '/tmp/vomp-bash-visualization-slice1');
const retainedPath = process.env.OMP_SHELL_RETAINED;
const root = await realpath(await mkdtemp(join(tmpdir(), 'vomp-shell-identity-')));
const keepAlive = process.env.VOMP_SHELL_UI_KEEPALIVE === '1';
const contextCheck = process.env.OMP_SHELL_CONTEXT_CHECK === '1';
const command = keepAlive ? 'VALUE="café"; mkdir -p build; sleep 10; printf "%s\\n" "$VALUE"; false | true' : 'sleep 0.4; VALUE="café"; printf "%s\\n" "$VALUE"';
const commands = contextCheck ? ['cd / && VALUE="café"; printf "%s\\n" "$VALUE"; sleep 0.4', 'cd /; VALUE="semicolon café"; printf "%s\\n" "$VALUE"; sleep 0.4'] : [command, command];
const requests: object[] = [];
const frames: object[] = [];
const shellIds = new Set<string>();
const matched = new Map<string, object>();
const errors: string[] = [];
let child: IPty | undefined;
let guest: GuestClient | undefined;
let exited = false;
let maxActiveCalls = 0;
let session: TspSession | undefined;
let revision = 0;
let callRound = 0;
const uiClosed = Promise.withResolvers<void>();
const uiActions: object[] = [];
const localEvents: { channel: string; value: unknown; sequence: number }[] = [];
const localActions: { op: string; args: unknown[] }[] = [];
let enabled: boolean | undefined = true;
let sources: { mode: 'saved' | 'helper' | 'read-only' | 'retained'; file: string; cwd: string }[] = [];
let helperFile: string | undefined;
let helperReleased = false;
let helperStarted = false;
const helperCommand = contextCheck
  ? `cd /; VALUE="helper café"; printf "%s\\n" "helper started"; while [ ! -f ${JSON.stringify(join(root, 'helper-release'))} ]; do sleep 0.1; done; printf "%s\\n" "$VALUE"; false | true`
  : 'VALUE="helper café"; printf "%s\\n" "helper started"; while [ ! -f ../helper-release ]; do sleep 0.1; done; printf "%s\\n" "$VALUE"; false | true';
const helperEvidence: object[] = [];
const settingReads: object[] = [];
let sourceBaseline: unknown;
let baselineModelRequests = 0;
let local: ShellVisualizationService | undefined;
const isolatedEnvironment = fixtureEnvironment(root);
const sessionDirectory = join(isolatedEnvironment.PI_CODING_AGENT_DIR, 'sessions', 'bash-fixture');
const execute = promisify(execFile);
async function effectiveSetting(cwd: string) {
  if (enabled === undefined) return { key: 'display.shellVisualization', type: 'unknown', value: undefined };
  let effectiveCwd = cwd;
  if (cwd === join(root, 'work', 'missing-project')) {
    const folder = await stat(cwd).catch(error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; });
    assert.equal(folder, null, 'The missing-project fixture folder must remain absent.');
    // The production config:get missing-folder branch is covered separately. This preload adaptation
    // performs its neutral-folder native read without importing Electron or touching the owner's folders.
    effectiveCwd = isolatedEnvironment.HOME;
  } else assert.equal(await realpath(cwd), join(root, 'work'));
  try {
    const { stdout } = await execute(binary, ['read', 'cfg://display.shellVisualization'], { cwd: effectiveCwd, env: isolatedEnvironment, timeout: 10_000 });
    const setting = parseCfgLeaf(stdout);
    settingReads.push({ cwd, effectiveCwd, setting });
    return setting;
  } catch (error) {
    settingReads.push({ cwd, effectiveCwd, error: String(error), stderr: error && typeof error === 'object' && 'stderr' in error ? error.stderr : undefined });
    throw error;
  }
}
function publish(channel: string, value: unknown) {
  localEvents.push({ channel, value, sequence: (localEvents.at(-1)?.sequence ?? 0) + 1 });
  if (localEvents.length > 100) localEvents.shift();
}
async function sourceEvidence() {
  return Promise.all(sources.map(async source => {
    const text = await readFile(source.file, 'utf8');
    const entries = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
    const header = z.object({ id: z.string(), cwd: z.string() }).parse(entries.find(entry => entry.type === 'session'));
    const sidecar = join(root, 'state', 'omp', 'run', 'session-owners', `${header.id}.lock`);
    const lease = await readFile(sidecar).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const metadata = lease ? await stat(sidecar) : null;
    const fileMetadata = await stat(source.file);
    let holders: string[] = [];
    if (process.platform === 'darwin' && lease) {
      try {
        holders = execFileSync('/usr/sbin/lsof', ['-w', '-F', 'p', '--', sidecar], { encoding: 'utf8' }).trim().split('\n').filter(line => /^p\d+$/.test(line) && line !== `p${process.pid}`).sort();
      } catch (error) {
        const failure = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
        // lsof's empty status 1 means no current holder, not a failed evidence run.
        // Preserve the empty list so the before/after comparison exposes a released lease.
        if (failure?.status !== 1 || String(failure.stdout ?? '').trim() || String(failure.stderr ?? '').trim()) throw error;
      }
    }
    return { mode: source.mode, file: source.file, fileIdentity: [fileMetadata.dev, fileMetadata.ino], sessionId: header.id, cwd: await realpath(header.cwd), sha256: createHash('sha256').update(text).digest('hex'), lease: lease?.toString('hex') ?? null, leaseIdentity: metadata ? [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs] : null, holders };
  }));
}
function snapshot(): TspHostSnapshot | null {
  if (!session) return null;
  const state = session.snapshot();
  return { ...state, hostId: 'shell-fixture', generation: 1, revision, lifecycle: 'live', documentGeneration: 1, failure: null, availability: session.availability(), surfaces: state.surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) };
}
function fixtureTools() {
  const state = guest?.getSnapshot();
  if (!state) return [];
  const results = new Map(state.entries.flatMap(entry => entry.type === 'message' && entry.message.role === 'toolResult' ? [[entry.message.toolCallId, entry.message] as const] : []));
  const calls = state.entries.flatMap(entry => entry.type === 'message' && entry.message.role === 'assistant' ? entry.message.content.flatMap(block => block.type === 'toolCall' ? [{ id: block.id, args: block.arguments, name: block.name }] : []) : []);
  return calls.map(call => ({ ...call, result: results.get(call.id), running: state.activeTools.has(call.id), partialResult: state.activeTools.get(call.id)?.partialResult }));
}
const relay = new LoopbackRelay();
const provider = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.end(); return; }
  if (req.url === '/shell/state') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ snapshot: snapshot(), tools: fixtureTools(), actions: uiActions, sources, events: localEvents })); return; }
  if (req.url === '/shell/close') { uiClosed.resolve(); res.end('{}'); return; }
  if (req.url === '/shell/run' && session) { await session.submit('Run the two fixed identity fixture commands again.'); res.end('{}'); return; }
  if (req.url === '/helper/start' && session && !helperStarted) {
    helperStarted = true;
    await session.submit('fixture helpers. Start the one SavedTraceHelper for saved result arrival acceptance.');
    const deadline = Date.now() + 30_000;
    while (!helperFile && Date.now() < deadline) {
      const parent = sources.find(source => source.mode === 'read-only')!;
      helperFile = await helperSessionFile(parent.file, 'SavedTraceHelper') ?? undefined;
      if (!helperFile) await sleep(50);
    }
    if (!helperFile) throw new Error('The native task did not create its helper transcript.');
    let text = '';
    while (Date.now() < deadline) {
      text = await readFile(helperFile, 'utf8');
      if (text.includes('shell-helper-arrival')) break;
      await sleep(50);
    }
    assert.ok(text.includes('shell-helper-arrival'), 'The helper bash call was not persisted.');
    const entries = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal(entries.filter(entry => entry.message?.role === 'toolResult' && entry.message.toolCallId === 'shell-helper-arrival').length, 0);
    sources.push({ mode: 'helper', file: helperFile, cwd: join(root, 'work') });
    helperEvidence.push({ phase: 'resultless', file: helperFile, toolCallId: 'shell-helper-arrival', resultCount: 0, fileIdentity: [(await stat(helperFile)).dev, (await stat(helperFile)).ino] });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ file: helperFile })); return;
  }
  if (req.url === '/helper/release' && helperFile) {
    helperReleased = true;
    await writeFile(join(root, 'helper-release'), 'released\n');
    const deadline = Date.now() + 30_000;
    let results: unknown[] = [];
    let helperSettled = false;
    let ownerSettled = false;
    while (Date.now() < deadline) {
      const entries = (await readFile(helperFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      results = entries.filter(entry => entry.message?.role === 'toolResult' && entry.message.toolCallId === 'shell-helper-arrival');
      helperSettled = entries.some(entry => entry.message?.role === 'assistant' && entry.message.stopReason === 'stop');
      const ownerFile = sources.find(source => source.mode === 'read-only')!.file;
      const ownerEntries = (await readFile(ownerFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      const delivered = ownerEntries.findIndex(entry => entry.type === 'custom_message' && entry.customType === 'async-result' && entry.details?.jobs?.some((job: { jobId?: string; status?: string }) => job.jobId === 'SavedTraceHelper' && job.status === 'completed'));
      ownerSettled = delivered >= 0 && ownerEntries.slice(delivered + 1).some(entry => entry.message?.role === 'assistant' && entry.message.stopReason === 'stop');
      if (results.length && helperSettled && ownerSettled && !guest?.getSnapshot().working) break;
      await sleep(50);
    }
    assert.equal(results.length, 1);
    assert.ok(helperSettled && ownerSettled, 'Wait for helper final reply and the owning host completion delivery before taking the immutable-source baseline.');
    const trace = await loadSavedShellTrace(helperFile, 'shell-helper-arrival');
    assert.equal(trace.status, 'ready');
    helperEvidence.push({ phase: 'settled', file: helperFile, toolCallId: 'shell-helper-arrival', resultCount: results.length, fileIdentity: [(await stat(helperFile)).dev, (await stat(helperFile)).ino], traceStatus: trace.status, helperSettled, ownerSettled });
    sourceBaseline = await sourceEvidence();
    baselineModelRequests = requests.length;
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ resultCount: results.length, baselineModelRequests })); return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  if (req.url === '/local/invoke') {
    try {
      const { op, args } = z.object({ op: z.string(), args: z.array(z.unknown()) }).parse(JSON.parse(Buffer.concat(chunks).toString()));
      localActions.push({ op, args });
      let result: unknown;
      if (op === 'config:get') result = await effectiveSetting(z.string().parse(args[1]));
      else if (op === 'config:watch' || op === 'config:unwatch') result = undefined;
      else if (op === 'shellviz:open' && local) {
        const request = z.object({ requestId: z.string(), file: z.string(), toolCallId: z.string() }).parse(args[0]) satisfies ShellOpenRequest;
        if (!sources.some(source => source.file === request.file)) throw new Error('Only fixture source files are allowed.');
        result = await local.open(request);
      } else if (op === 'shellviz:action' && local) result = await local.action(z.string().parse(args[0]), z.string().parse(args[1]));
      else if (op === 'shellviz:release') local?.release(z.string().parse(args[0]));
      else if (op === 'shellviz:cancel') local?.cancel(z.string().parse(args[0]));
      else if (op === 'sessions:read') {
        const file = z.string().parse(args[0]);
        if (!sources.some(source => source.file === file)) throw new Error('Only fixture source files are allowed.');
        result = { text: await readFile(file, 'utf8'), identity: (await stat(file)).mtimeMs };
      } else throw new Error('Unsupported fixture operation.');
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result }));
    } catch (error) { res.writeHead(400).end(JSON.stringify({ error: String(error) })); }
    return;
  }
  if (req.url === '/local/source-cwd') {
    const body = z.object({ mode: z.enum(['saved', 'helper', 'read-only', 'retained']), missing: z.boolean() }).parse(JSON.parse(Buffer.concat(chunks).toString()));
    const source = sources.find(source => source.mode === body.mode);
    assert.ok(source, 'The source must exist before changing its fixture folder.');
    source.cwd = join(root, 'work', ...(body.missing ? ['missing-project'] : []));
    res.end('{}'); return;
  }
  if (req.url === '/local/setting') {
    const body = z.object({ enabled: z.boolean().optional(), project: z.boolean().nullable().optional(), remove: z.boolean().optional() }).parse(JSON.parse(Buffer.concat(chunks).toString()));
    enabled = body.remove ? true : body.enabled;
    const configFile = join(isolatedEnvironment.PI_CODING_AGENT_DIR, 'config.yml');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    config.display = { ...config.display, shellVisualization: body.enabled ?? true };
    if (body.remove) delete config.display.shellVisualization;
    await writeFile(configFile + '.fixture-next', JSON.stringify(config));
    await rename(configFile + '.fixture-next', configFile);
    if (body.project !== undefined) {
      const directory = join(root, 'work', '.omp');
      await mkdir(directory, { recursive: true });
      const projectFile = join(directory, 'config.yml');
      await writeFile(projectFile + '.fixture-next', JSON.stringify({ display: body.project === null ? {} : { shellVisualization: body.project } }));
      await rename(projectFile + '.fixture-next', projectFile);
    }
    await local?.settingsChanged();
    publish('config:changed', { scope: 'global', cwd: null });
    res.end('{}'); return;
  }
  if (req.url === '/local/evidence') {
    const after = await sourceEvidence();
    const evidence = { before: sourceBaseline, after, helperEvidence, helperReleased, holderPid: child?.pid, settingReads, localActions, hostActions: uiActions, baselineModelRequests, modelRequests: requests, unchanged: JSON.stringify(sourceBaseline) === JSON.stringify(after) && requests.length === baselineModelRequests && uiActions.length === 0 };
    await writeFile(join(destination, 'saved-browser-evidence.json'), JSON.stringify(evidence, null, 2));
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(evidence)); return;
  }
  if (req.url === '/shell/action') {
    try {
      const action = z.object({ hostId: z.literal('shell-fixture'), generation: z.literal(1), epoch: z.number().int(), sf: z.string(), id: z.string(), value: z.string() }).parse(JSON.parse(Buffer.concat(chunks).toString()));
      if (!session || action.epoch !== session.snapshot().epoch) throw new Error('Stale fixture shell action');
      await session.send({ ev: 'action', sf: action.sf, id: action.id, act: 'shell-viz', value: action.value });
      uiActions.push(action);
      res.end('{}');
    } catch (error) { res.writeHead(400).end(JSON.stringify({ error: String(error) })); }
    return;
  }
  const body = z.object({ messages: z.array(z.object({ role: z.string() }).loose()) }).parse(JSON.parse(Buffer.concat(chunks).toString()));
  const messageText = (message: Record<string, unknown> | undefined) => typeof message?.content === 'string' ? message.content : Array.isArray(message?.content) ? message.content.flatMap(part => part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? [part.text] : []).join('\n') : '';
  const last = body.messages.at(-1);
  const text = messageText(last);
  const lastUser = body.messages.findLast(message => message.role === 'user');
  const helperTurn = messageText(lastUser).includes('fixture helper-work');
  const taskTurn = !helperTurn && messageText(lastUser).includes('fixture helpers');
  // Harness notices can follow tool results as user-role messages. Explicit fixture prompts alone start tools.
  const afterTool = last?.role !== 'user' || (!text.includes('Run the two fixed identity fixture commands') && !text.includes('fixture helper-work') && !text.includes('fixture helpers'));
  if (!afterTool && !helperTurn && !taskTurn) callRound++;
  requests.push({ afterTool, helperTurn, taskTurn, messages: body.messages.length });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const toolCalls = helperTurn
    ? [{ index: 0, id: 'shell-helper-arrival', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ i: 'Recording helper result arrival', command: helperCommand, timeout: 240, async: false }) } }]
    : taskTurn
      ? [{ index: 0, id: 'shell-native-task', type: 'function', function: { name: 'task', arguments: JSON.stringify({ i: 'Starting saved trace helper', context: 'Use only the isolated loopback fixture provider.', tasks: [{ name: 'SavedTraceHelper', task: 'fixture helper-work. Run the fixed saved result arrival command.', solutionSpace: 'One fixed bash command, then one final reply.' }] }) } }]
      : [0, 1].map(index => ({ index, id: callRound === 1 ? `shell-identity-${index}` : `shell-identity-${callRound}-${index}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ i: 'Checking matching shell calls', command: commands[index], timeout: keepAlive ? 30 : 10 }) } }));
  const delta = afterTool ? { role: 'assistant', content: helperTurn ? 'The helper trace command finished.' : 'The identity fixture request finished.' } : { role: 'assistant', tool_calls: toolCalls };
  res.write(`data: ${JSON.stringify({ id: 'identity', object: 'chat.completion.chunk', created: 1, model: 'preview', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ id: 'identity', object: 'chat.completion.chunk', created: 1, model: 'preview', choices: [{ index: 0, delta: {}, finish_reason: afterTool ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
});
const until = async (predicate: () => boolean, label: string) => {
  const deadline = Date.now() + 30000;
  while (!predicate()) { if (exited || Date.now() > deadline) throw new Error(label + ': ' + errors.join('; ')); await sleep(20); }
};
function visit(node: EvidenceNode, owner?: { id: string; k: string; key: string }, sf?: string) {
  const current = node.p?.role === 'omp.tool.bash' && typeof node.p.key === 'string' ? { id: node.id, k: node.k, key: node.p.key } : owner;
  if (shellIds.has(node.id) && current && node.p?.presentation) {
    const presentation = Presentation.parse(node.p.presentation);
    matched.set(current.key, { toolCallId: current.key, ancestorKind: current.k, ancestorId: current.id, childKey: node.p.key ?? null, childId: node.id, surface: sf, rows: presentation.rows.length, watches: presentation.watches, liveOrigin: node.p.liveOrigin, presentation });
  }
  for (const item of node.c ?? []) visit(item, current, sf);
}
// This evidence harness advertises shell without changing the production vocabulary.
// A code-kind surrogate lets the existing 18.15 document applier retain the new props.
function surrogate(node: EvidenceNode): EvidenceNode {
  if (node.k === 'shell') shellIds.add(node.id);
  return { ...node, ...(node.k === 'shell' && !TSP_KINDS.some(kind => kind === 'shell') ? { k: 'code' } : {}), ...(node.c ? { c: node.c.map(surrogate) } : {}) };
}
try {
  await mkdir(destination, { recursive: true });
  const listening = Promise.withResolvers<void>();
  provider.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('No fixture provider port');
  await initializeFixture(root, `http://127.0.0.1:${address.port}/v1`);
  const env = { ...fixtureEnvironment(root), TERM_PROGRAM: 'tern' };
  if (keepAlive) {
    // The whole Node-only probe must use fresh paths before the production saved reader resolves userEnv.
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
  }
  await relay.start();
  const configFile = join(env.PI_CODING_AGENT_DIR, 'config.yml');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.collab = { autoStart: 'control', relayUrl: relay.url, displayName: 'Shell identity fixture' };
  config.display = { shellVisualization: true };
  config.update = { auto: false };
  await writeFile(configFile, JSON.stringify(config));
  const outbound = new TspStream({ onMessage: message => {
    const body = z.record(z.string(), z.unknown()).parse(JSON.parse(message.body));
    if (message.verb === 'r' && body.r === 'hello') body.kinds = [...new Set([...z.array(z.string()).parse(body.kinds), 'shell'])];
    child!.write(encodeTspJson(z.enum(['r', 'e']).parse(message.verb), body));
  }, onData: data => child!.write(data.toString()) });
  const currentSession = session = new TspSession({ cols: 110, dark: false, reduceMotion: true, write: data => outbound.push(Buffer.from(data)), onUpdate: () => { revision++; }, onError: error => errors.push(String(error)) });
  const stream = new TspStream({ onMessage: message => {
    const body = z.record(z.string(), z.unknown()).parse(JSON.parse(message.body));
    frames.push({ verb: message.verb, body: structuredClone(body) });
    if (message.verb === 'f') body.ops = z.array(z.array(z.unknown())).parse(body.ops).map(op => op[0] === 'add' ? [...op.slice(0, 4), surrogate(Node.parse(op[4]))] : op);
    currentSession.receive({ ...message, body: JSON.stringify(body) });
    for (const surface of currentSession.snapshot().surfaces) visit(Node.parse(surface.document), undefined, surface.open.id);
  }, onData: data => {
    if (data.includes(Buffer.from('\x1b[c'))) currentSession.terminalReply('\x1b[?62;22c');
    if (data.includes(Buffer.from('\x1b[6n'))) currentSession.terminalReply('\x1b[1;1R');
  } });
  await mkdir(sessionDirectory, { recursive: true });
  child = spawn(binary, ['--no-extensions', '--no-skills', '--no-rules', '--no-context-files', '--no-lsp', '--no-title', '--tools', 'bash,task,wait', '--session-dir', sessionDirectory, '--model', 'fixture/preview', '--thinking', 'off'], { cwd: join(root, 'work'), env, cols: 110, rows: 32, name: 'xterm-256color', encoding: null });
  child.onData(data => stream.push(typeof data === 'string' ? Buffer.from(data) : data));
  child.onExit(() => { exited = true; });
  await until(() => currentSession.availability().available, 'TSP editor did not become ready');
  let hosts: { instanceId: string }[] = [];
  await until(() => {
    hosts = z.object({ hosts: z.array(z.object({ instanceId: z.string() })) }).parse(JSON.parse(execFileSync(binary, ['collab', 'list', '--json'], { env, encoding: 'utf8' }))).hosts;
    return hosts.length === 1;
  }, 'The isolated collab host did not register');
  const link = z.object({ url: z.string() }).parse(JSON.parse(execFileSync(binary, ['collab', 'link', hosts[0]!.instanceId, '--json'], { env, encoding: 'utf8' }))).url;
  guest = new GuestClient(link, 'Shell visualization identity evidence');
  guest.subscribe(() => { maxActiveCalls = Math.max(maxActiveCalls, guest!.getSnapshot().activeTools.size); });
  guest.connect();
  await until(() => guest!.getSnapshot().phase === 'live', 'Collab did not connect');
  await currentSession.submit('Run the two fixed identity fixture commands.');
  await until(() => requests.length >= 2 && !guest!.getSnapshot().working && matched.size === 2, 'The two matching shell nodes did not settle');
  const results = guest.getSnapshot().entries.flatMap(entry => entry.type === 'message' && entry.message.role === 'toolResult' ? [{ toolCallId: entry.message.toolCallId, details: entry.message.details, output: entry.message.content }] : []);
  assert.equal(results.length, 2);
  for (const result of results) assert.ok(matched.has(result.toolCallId));
  assert.equal(new Set(results.map(result => result.toolCallId)).size, 2);
  assert.equal(errors.length, 0, errors.join('\n'));
  if (contextCheck) for (const [index, result] of results.entries()) {
    const details = z.object({ cwd: z.literal('/'), cdSeparator: z.literal(';').optional(), trace: z.object({ script: z.string() }) }).parse(result.details);
    const commandIndex = Number(result.toolCallId.split('-').at(-1));
    assert.equal(details.cdSeparator, commandIndex === 1 ? ';' : undefined);
    assert.ok(!details.trace.script.startsWith('cd /'), `The trace must hold the executed remainder (${index}).`);
  }
  await writeFile(join(destination, 'identity.json'), JSON.stringify({ version: execFileSync(binary, ['--version'], { env, encoding: 'utf8' }).trim(), command, commands, contextCheck, requests, maxActiveCalls, matches: [...matched.values()], results, errors }, null, 2));
  await writeFile(join(destination, 'identity.frames.json'), JSON.stringify(frames));
  console.log(JSON.stringify({ destination, calls: results.map(result => result.toolCallId), shellNodes: matched.size, maxActiveCalls, errors }));
  if (keepAlive) {
    const source = join(sessionDirectory, (await readdir(sessionDirectory)).find(file => file.endsWith('.jsonl'))!);
    const saved = join(sessionDirectory, 'saved-copy.jsonl');
    await copyFile(source, saved);
    sources = [{ mode: 'saved', file: saved, cwd: join(root, 'work') }, { mode: 'read-only', file: source, cwd: join(root, 'work') }];
    if (retainedPath) {
      const retained = JSON.parse(await readFile(retainedPath, 'utf8')).retained;
      const text = (await readFile(source, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      for (const entry of text) {
        const message = entry.message;
        if (message?.role === 'assistant') for (const block of message.content) if (block.type === 'toolCall' && block.id === results[0]!.toolCallId) block.arguments.command = retained.trace.script;
        if (message?.role === 'toolResult' && message.toolCallId === results[0]!.toolCallId) {
          message.details = { ...message.details, trace: retained.trace, cwd: retained.cwd, cdSeparator: retained.cdSeparator };
          message.content = [{ type: 'text', text: retained.output }];
        }
      }
      const file = join(sessionDirectory, 'retained-copy.jsonl');
      await writeFile(file, text.map(entry => JSON.stringify(entry)).join('\n') + '\n');
      sources.push({ mode: 'retained', file, cwd: join(root, 'work') });
    }
    const executable = binary.startsWith('/') ? binary : execFileSync('/usr/bin/which', [binary], { env, encoding: 'utf8' }).trim();
    local = new ShellVisualizationService({
      loadTrace: (file, toolCallId) => loadSavedShellTrace(file, toolCallId, () => sources.filter(source => source.mode !== 'helper').map(source => source.file)),
      getSetting: (_key, cwd) => effectiveSetting(cwd),
      createWorker: (onLoss, signal) => createInstalledShellWorker({ executable, env, onLoss, signal }),
      onFrame: frame => publish('shellviz:frame', frame),
      onInvalidated: event => publish('shellviz:invalidated', event),
    });
    sourceBaseline = await sourceEvidence();
    baselineModelRequests = requests.length;
    console.log(`Shell UI fixture ready http://127.0.0.1:${address.port}`);
    await uiClosed.promise;
    await writeFile(join(destination, 'ui-actions.json'), JSON.stringify(uiActions, null, 2));
  }
  await currentSession.submit('/exit');
  await until(() => exited, 'Fixture host did not exit');
} finally {
  guest?.close();
  await local?.close();
  if (child && !exited) child.kill();
  relay.stop();
  provider.closeAllConnections();
  const closed = Promise.withResolvers<void>();
  provider.close(() => closed.resolve());
  await closed.promise;
  await rm(root, { recursive: true, force: true });
}
