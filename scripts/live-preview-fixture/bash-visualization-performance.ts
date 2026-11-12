// Run from the repository root: bun --tsconfig-override tsconfig.node.json scripts/live-preview-fixture/bash-visualization-performance.ts
// Optional: OMP_BIN=/absolute/path/to/omp OMP_SHELL_PERFORMANCE=/tmp/evidence-directory
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { ShellVisualizationService, SHELL_SERVICE_LIMITS } from '../../src/main/omp/shell-visualization';
import { createInstalledShellWorker, SHELL_WORKER_LIMITS } from '../../src/main/omp/shell-visualization-worker';
import { shellPresentation, shellProps, type ShellVizPresentation } from '../../src/shared/tsp/shell';
import type { ShellFailureReason, ShellResult } from '../../src/shared/shell-visualization';
import { initializeFixture, fixtureEnvironment } from './environment.mjs';
import { startFixture } from './server.mjs';

const limits = { handles: 4, sourceBytes: 32 * 1024 ** 2, traceBytes: 16 * 1024 ** 2, rssBytes: 512 * 1024 ** 2,
  sampleMs: 100, responseBytes: 2 * 1024 ** 2, segments: 50000, rowSegments: 1024, rowBytes: 65536, valueBytes: 16384,
  smallSeekP95Ms: 250, retainedSeekP95Ms: 1000, heartbeatMs: 20, heartbeatDelayMs: 100, terminationMs: 250 };
const output = resolve(process.env.OMP_SHELL_PERFORMANCE ?? '/tmp/vomp-bash-visualization-performance');
const root = await mkdtemp(join(tmpdir(), 'vomp-shell-performance-'));
const resultFile = join(output, 'fixture-results.json');
const commandEnv = fixtureEnvironment(root);
const cases: Record<string, unknown>[] = [];
const failures: string[] = [];
let phase = 'initialization';
const modelRequests: unknown[] = [];
const groups: Group[] = [];
const services = new Set<ShellVisualizationService>();
const evidence: Record<string, unknown> = { limits, cases, groups, failures, modelRequests, platform: process.platform,
  invocation: 'bun --tsconfig-override tsconfig.node.json scripts/live-preview-fixture/bash-visualization-performance.ts',
  scope: 'Production Node service and installed worker. Browser responsiveness is measured separately.',
  isolation: { freshHome: commandEnv.HOME, freshAgent: commandEnv.PI_CODING_AGENT_DIR, environmentKeys: Object.keys(commandEnv).sort(), provider: 'loopback only' } };
let fixture: { baseUrl: string; close(): Promise<void> } | undefined;
let capture: Capture | undefined;
let binary = '';
let heartbeat: NodeJS.Timeout | undefined;
let heartbeatAt = 0;
let heartbeatMax = 0;
let phaseMax = 0;
let heartbeatSamples = 0;
let fixtureHash = '';
const sources = new Map<string, string>();
const captured: Record<string, CaptureResult> = {};

type Trace = { v: number; seq: number; t_ns: number; script: string; units: unknown[]; history?: { seq: number; t_ns: number }[]; historyTruncated?: boolean };
type CaptureResult = { trace: Trace; output: string; result: unknown; presentations: { presentation: ShellVizPresentation }[] };
type Capture = { close(): Promise<void>; run(script: string): Promise<CaptureResult> };
type ProcessRow = { pid: number; ppid: number; pgid: number; rssBytes: number; command: string };
type Group = { name: string; pid?: number; baselineRssBytes?: number; peakRssBytes: number; samples: { atMs: number; bytes: number; pids: number[] }[];
  loss?: ShellFailureReason; lossAtMs?: number; exitAtMs?: number; terminationAfterCrossingMs?: number; pressureStartedAtMs?: number; firstOverLimitAtMs?: number; closed?: boolean };
const elapsed = () => performance.now();
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function exec(file: string, args: string[], env = commandEnv): Promise<string> {
  const result = Promise.withResolvers<string>();
  execFile(file, args, { env, cwd: join(root, 'work'), timeout: 30000, maxBuffer: 4 * 1024 ** 2 }, (error, stdout) => error ? result.reject(error) : result.resolve(stdout));
  return result.promise;
}
async function processes(): Promise<ProcessRow[]> {
  const text = await exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,rss=,command=']);
  return [...text.matchAll(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/gm)].map(row => ({ pid: Number(row[1]), ppid: Number(row[2]), pgid: Number(row[3]), rssBytes: Number(row[4]) * 1024, command: row[5]! }));
}
async function findBinary(): Promise<string> {
  const supplied = process.env.OMP_BIN;
  if (supplied) { ensure(isAbsolute(supplied), 'OMP_BIN must be an absolute installed executable.'); return supplied; }
  for (const directory of (commandEnv.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, 'omp');
    try { await access(candidate, constants.X_OK); return resolve(candidate); } catch {}
  }
  throw new Error('Installed omp was not found on PATH. Set OMP_BIN to its absolute path.');
}
function startHeartbeat(): void {
  heartbeatAt = elapsed();
  heartbeat = setInterval(() => { const now = elapsed(); const delay = Math.max(0, now - heartbeatAt - limits.heartbeatMs);
    heartbeatMax = Math.max(heartbeatMax, delay); phaseMax = Math.max(phaseMax, delay); heartbeatSamples++; heartbeatAt = now; }, limits.heartbeatMs);
}
async function runCase(name: string, body: (entry: Record<string, unknown>) => Promise<void>): Promise<void> {
  const entry: Record<string, unknown> = { name };
  cases.push(entry); phaseMax = 0;
  const at = elapsed();
  try { await body(entry); entry.passed = true; }
  catch (error) { entry.passed = false; entry.cause = String(error instanceof Error ? error.message : error); failures.push(`${name}: ${entry.cause}`); }
  finally {
    await sleep(40);
    entry.elapsedMs = elapsed() - at;
    entry.heartbeatMaxDelayMs = phaseMax;
    if (fixtureHash) {
      const after = digest(await readFile(resultFile));
      entry.ordinaryOutputUnchanged = after === fixtureHash;
      if (after !== fixtureHash) { entry.passed = false; failures.push(`${name}: fixture output changed.`); }
    }
  }
}

async function startCapture(executable: string, providerUrl: string) {
  const captureRoot = join(root, 'capture');
  await initializeFixture(captureRoot, providerUrl);
  const env = fixtureEnvironment(captureRoot);
  const configFile = join(env.PI_CODING_AGENT_DIR, 'config.yml');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.update = { auto: false };
  await writeFile(configFile, JSON.stringify(config));
  const token = randomUUID();
  let next: ServerResponse | undefined;
  const queue: unknown[] = [];
  const pending = new Map<string, { resolve(value: CaptureResult): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const ready = Promise.withResolvers<Record<string, unknown>>();
  void ready.promise.catch(() => {});
  let stderr = '';
  let child: ChildProcess | undefined;
  const server = createServer(async (request, response) => {
    if (!request.url?.startsWith(`/${token}/`)) { response.writeHead(404).end(); return; }
    const path = request.url.slice(token.length + 1);
    if (path === '/next') {
      if (queue.length) response.end(JSON.stringify(queue.shift()));
      else { next = response; response.on('close', () => { if (next === response) next = undefined; }); }
      return;
    }
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 64 * 1024 ** 2) throw new Error('Capture response exceeded 64 MiB.'); chunks.push(Buffer.from(chunk)); }
      const value = JSON.parse(Buffer.concat(chunks).toString());
      if (path === '/ready') ready.resolve(value);
      if (path === '/failure') ready.reject(new Error(value.error));
      if (path === '/result') { const waiter = pending.get(value.id); if (waiter) { pending.delete(value.id); clearTimeout(waiter.timer); value.error ? waiter.reject(new Error(value.error)) : waiter.resolve(value.data); } }
      response.end('{}');
    } catch (error) { response.writeHead(400).end(); ready.reject(new Error(String(error))); }
  });
  const listening = Promise.withResolvers<void>(); server.listen(0, '127.0.0.1', listening.resolve); await listening.promise;
  const address = server.address(); ensure(address && typeof address !== 'string', 'Capture bridge did not bind.');
  const bridge = `http://127.0.0.1:${address.port}/${token}`;
  child = spawn(executable, ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-context-files', '--no-rules', '--no-skills', '--no-lsp', '--no-title', '--no-tools', '--model', 'fixture/preview', '--thinking', 'off', '-e', fileURLToPath(new URL('./bash-visualization-worker.mjs', import.meta.url))],
    { cwd: join(captureRoot, 'work'), env: { ...env, VOMP_SHELL_EVIDENCE_BRIDGE: bridge, VOMP_SHELL_EVIDENCE_ROLE: 'capture' }, stdio: 'pipe' });
  child.stdout?.resume(); child.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-8000); });
  const exited = Promise.withResolvers<void>();
  child.once('error', error => ready.reject(error));
  child.once('exit', () => { exited.resolve(); ready.reject(new Error(`Capture exited: ${stderr}`)); for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(`Capture exited: ${stderr}`)); } pending.clear(); });
  const timer = setTimeout(() => { ready.reject(new Error(`Capture startup timed out: ${stderr}`)); child?.kill('SIGKILL'); }, 15000);
  const close = async () => {
    clearTimeout(timer); next?.end('{}'); server.closeAllConnections();
    const stopped = Promise.withResolvers<void>(); server.close(() => stopped.resolve()); await stopped.promise;
    if (child?.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited.promise; }
  };
  try { const capability = await ready.promise; ensure(capability.live === true, 'Installed native RunTrace is unavailable.'); }
  catch (error) { await close(); throw error; }
  finally { clearTimeout(timer); }
  return { close, async run(script: string): Promise<CaptureResult> {
    const id = randomUUID();
    const result = Promise.withResolvers<CaptureResult>();
    const timeout = setTimeout(() => { pending.delete(id); result.reject(new Error('Capture request timed out.')); }, 45000);
    pending.set(id, { resolve: result.resolve, reject: result.reject, timer: timeout });
    const request = { id, op: 'capture', script, cwd: join(captureRoot, 'work') };
    if (next) { const response = next; next = undefined; response.end(JSON.stringify(request)); } else queue.push(request);
    return result.promise;
  } };
}

async function service(name: string, executable = binary): Promise<{ service: ShellVisualizationService; group: Group; stop(): Promise<void> }> {
  const group: Group = { name, peakRssBytes: 0, samples: [] }; groups.push(group);
  let sampling = false;
  let stopping = false;
  let current = false;
  const known = new Set((await processes()).map(row => row.pid));
  const sample = async () => {
    if (sampling || stopping) return;
    sampling = true;
    try {
      const rows = await processes();
      if (!group.pid) group.pid = rows.find(row => row.ppid === process.pid && row.pgid === row.pid && !known.has(row.pid))?.pid;
      if (!group.pid) return;
      const members = rows.filter(row => row.pgid === group.pid);
      const bytes = members.reduce((sum, row) => sum + row.rssBytes, 0);
      if (members.length) {
        group.samples.push({ atMs: elapsed(), bytes, pids: members.map(row => row.pid) }); group.peakRssBytes = Math.max(group.peakRssBytes, bytes);
        if (current && group.baselineRssBytes === undefined) group.baselineRssBytes = bytes;
        if (bytes > limits.rssBytes && group.firstOverLimitAtMs === undefined) group.firstOverLimitAtMs = elapsed();
      } else if (group.exitAtMs === undefined) {
        group.exitAtMs = elapsed();
        if (group.firstOverLimitAtMs !== undefined) group.terminationAfterCrossingMs = group.exitAtMs - group.firstOverLimitAtMs;
      }
    } finally { sampling = false; }
  };
  const timer = setInterval(() => { void sample().catch(error => failures.push(`${name} sampler: ${error}`)); }, limits.sampleMs);
  const instance = new ShellVisualizationService({
    async loadTrace(_file, toolCallId) { const json = sources.get(toolCallId); return json === undefined ? { status: 'unavailable' } : { status: 'ready', json, cwd: join(root, 'work'), sessionId: 'performance-fixture', identity: digest(json) }; },
    async getSetting(key) { return { key, type: 'boolean', value: true }; },
    async createWorker(onLoss, signal) {
      const worker = await createInstalledShellWorker({ executable, env: commandEnv, signal, onLoss(reason) { group.loss = reason; group.lossAtMs = elapsed(); onLoss(reason); } });
      current = true;
      while (sampling) await sleep(1);
      await sample();
      return worker;
    },
  });
  services.add(instance);
  return { service: instance, group, async stop() {
    await instance.close(); services.delete(instance);
    while (sampling) await sleep(1);
    await sample(); stopping = true; clearInterval(timer); group.closed = true;
  } };
}
const open = (instance: ShellVisualizationService, key: string) => instance.open({ requestId: randomUUID(), file: resultFile, toolCallId: key });
function ready(result: ShellResult): asserts result is Extract<ShellResult, { status: 'ready' }> { ensure(result.status === 'ready', `Expected a ready production frame, received ${JSON.stringify(result)}.`); }
const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * .95) - 1)]!;
async function seeks(instance: ShellVisualizationService, frames: Extract<ShellResult, { status: 'ready' }>[], rounds: number) {
  const measurements: { handle: string; cursor: number; ms: number; status: string; reason?: string }[] = [];
  for (let index = 0; index < rounds; index++) {
    const batch = await Promise.all(frames.map(async frame => {
      const cursor = Math.floor(frame.props.presentation.timeline.length * ((index * 7) % rounds) / Math.max(1, rounds - 1));
      const at = elapsed(); const result = await instance.action(frame.handle, `seek:${cursor}`);
      return { handle: frame.handle, cursor, ms: elapsed() - at, status: result.status, ...(result.status === 'unavailable' ? { reason: result.reason } : {}) };
    }));
    measurements.push(...batch);
  }
  return { measurements, p95Ms: p95(measurements.map(item => item.ms)) };
}
function padded(json: string, bytes: number): string { const size = Buffer.byteLength(json); ensure(size <= bytes, 'Padding target is smaller than trace.'); return json + ' '.repeat(bytes - size); }

try {
  ensure(process.platform === 'darwin' || process.platform === 'linux', 'This group-RSS acceptance probe requires POSIX ps and process groups.');
  await mkdir(output, { recursive: true });
  fixture = await startFixture({ root: join(root, 'provider'), port: 0, onRequest: request => modelRequests.push(request) });
  await initializeFixture(root, fixture.baseUrl);
  binary = await findBinary();
  evidence.executable = binary;
  evidence.version = (await exec(binary, ['--version'])).trim();
  const expectedVersion = process.env.OMP_EXPECTED_VERSION ?? '18.17.0';
  ensure(String(evidence.version).trim() === `omp/${expectedVersion}`, `Expected installed omp ${expectedVersion}, received ${evidence.version}.`);
  ensure(SHELL_SERVICE_LIMITS.handles === limits.handles && SHELL_SERVICE_LIMITS.traceBytes === limits.traceBytes && SHELL_SERVICE_LIMITS.sourceBytes === limits.sourceBytes && SHELL_WORKER_LIMITS.rssBytes === limits.rssBytes && SHELL_WORKER_LIMITS.sampleMs === limits.sampleMs, 'Production budgets differ from the approved acceptance budgets.');
  phase = 'capture-bootstrap';
  capture = await startCapture(binary, fixture.baseUrl);
  phase = 'small-capture';
  captured.small = await capture.run('VALUE="café"\nprint_value() { printf "%s\\n" "$VALUE"; }\nfor i in 1 2; do print_value; done\nfalse | true\nprintf "finished\\n"');
  phase = 'retained-capture';
  captured.retained = await capture.run('for i in {1..2500}; do VALUE="café-$i"; printf "%s\\n" "$VALUE"; done');
  phase = 'value-capture';
  captured.value = await capture.run('VALUE="$(printf "%17000s" x)"; printf "value-bytes=%s\\n" "${#VALUE}"');
  await capture.close(); capture = undefined;
  phase = 'production-gates';
  for (const [name, result] of Object.entries(captured)) sources.set(name, JSON.stringify(result.trace));
  // Complete captured output stays beside each original trace. No presentation refusal rewrites it.
  const replacementFile = join(output, `fixture-results-${randomUUID()}.json`);
  await writeFile(replacementFile, JSON.stringify(captured), { mode: 0o400 });
  await rename(replacementFile, resultFile);
  fixtureHash = digest(await readFile(resultFile));
  evidence.fixture = { file: resultFile, sha256Before: fixtureHash, captures: Object.fromEntries(Object.entries(captured).map(([name, value]) => [name, {
    sourceBytes: Buffer.byteLength(sources.get(name)!), outputBytes: Buffer.byteLength(value.output), outputSha256: digest(value.output), history: value.trace.history?.length ?? 0, trimmed: value.trace.historyTruncated ?? false,
    timestampRegressions: (value.trace.history ?? []).flatMap((event, index, history) => index > 0 && event.t_ns < history[index - 1]!.t_ns ? [{ index, previousNs: history[index - 1]!.t_ns, atNs: event.t_ns }] : []),
  }])) };
  startHeartbeat();
  await runCase('small-seek', async entry => {
    const run = await service('small');
    try { const frame = await open(run.service, 'small'); ready(frame); const result = await seeks(run.service, [frame], 24); Object.assign(entry, result); ensure(result.measurements.every(item => item.status === 'ready'), 'A small seek was refused.'); ensure(result.p95Ms <= limits.smallSeekP95Ms, `Small seek p95 ${result.p95Ms}ms exceeds 250ms.`); }
    finally { await run.stop(); }
  });
  await runCase('four-retained-handles', async entry => {
    const run = await service('four-retained');
    try {
      const frames = await Promise.all(Array.from({ length: 4 }, () => open(run.service, 'retained')));
      entry.openResults = frames.map(frame => frame.status === 'ready' ? { status: frame.status, handle: frame.handle } : frame);
      entry.sourceBytes = 4 * Buffer.byteLength(sources.get('retained')!);
      for (const frame of frames) ready(frame);
      const fifth = await open(run.service, 'small'); entry.fifth = fifth;
      ensure(fifth.status === 'unavailable' && fifth.reason === 'too-large', 'A fifth simultaneous handle was admitted.');
      const readyFrames = frames.filter(frame => frame.status === 'ready');
      const result = await seeks(run.service, readyFrames, 12);
      Object.assign(entry, result);
      ensure(result.measurements.every(item => item.status === 'ready'), 'A retained seek was refused.');
      ensure(result.p95Ms <= limits.retainedSeekP95Ms, `Retained seek p95 ${result.p95Ms}ms exceeds 1000ms.`);
      ensure(run.group.pid !== undefined && run.group.baselineRssBytes !== undefined, 'Native process-group RSS could not be observed.');
      ensure(run.group.peakRssBytes <= limits.rssBytes, `Four-handle group RSS ${run.group.peakRssBytes} bytes exceeds 512 MiB.`);
    } finally { await run.stop(); }
  });
  await runCase('aggregate-source-byte-ceiling', async entry => {
    // JSON whitespace deliberately isolates source-byte accounting from semantic/native allocation.
    const bytes = Math.floor(limits.sourceBytes / 3) + 1;
    sources.set('padded', padded(sources.get('small')!, bytes));
    entry.perHandleSourceBytes = bytes; entry.attemptedAggregateBytes = 3 * bytes; entry.padding = 'Trailing JSON whitespace, with the captured trace unchanged.';
    const run = await service('source-ceiling');
    try {
      const first = await open(run.service, 'padded'); ready(first);
      const second = await open(run.service, 'padded'); ready(second);
      const third = await open(run.service, 'padded'); entry.third = third;
      ensure(third.status === 'unavailable' && third.reason === 'too-large', 'The 32 MiB aggregate source ceiling was not enforced.');
      const stillReady = await run.service.action(first.handle, 'reset'); ready(stillReady);
      entry.admittedAggregateBytes = 2 * bytes; entry.existingHandleStillReady = true;
    } finally { await run.stop(); sources.delete('padded'); }
  });
  await runCase('single-source-byte-ceiling', async entry => {
    sources.set('over-source', padded(sources.get('small')!, limits.traceBytes + 1));
    const run = await service('single-source-ceiling');
    try { const result = await open(run.service, 'over-source'); entry.result = result; entry.sourceBytes = limits.traceBytes + 1; ensure(result.status === 'unavailable' && result.reason === 'too-large', 'A trace over 16 MiB was admitted.'); ensure(run.group.pid === undefined, 'An oversized trace started a native worker.'); }
    finally { await run.stop(); sources.delete('over-source'); }
  });
  await runCase('native-enormous-row', async entry => {
    sources.set('huge-row', JSON.stringify({ v: 1, seq: 0, t_ns: 0, script: 'literal'.repeat(12000), units: [] }));
    const run = await service('native-enormous-row');
    try { const result = await open(run.service, 'huge-row'); entry.result = result; entry.rowSourceBytes = 84000; entry.executed = false; ensure(result.status === 'unavailable', 'An enormous native row passed the production shape guard.'); }
    finally { await run.stop(); sources.delete('huge-row'); }
  });
  await runCase('native-large-value-capture', async entry => {
    const run = await service('native-enormous-value');
    try { const result = await open(run.service, 'value'); entry.result = result.status === 'ready' ? { status: 'ready' } : result;
      entry.capturedValueBytes = 17000; entry.output = captured.value!.output;
      const maximum = Math.max(0, ...captured.value!.presentations.flatMap(point => [...point.presentation.watches, ...point.presentation.rows.flatMap(row => row.annotations ?? [])].map(watch => Buffer.byteLength(watch.value))));
      entry.maximumCapturedAnnotationBytes = maximum;
      entry.scope = 'Installed native capture bounds observed values. Oversized values are injected into the shared live guard in the following case.';
      ensure(captured.value!.output === 'value-bytes=17000\n', 'The native capture did not execute the 17000-byte value fixture.');
      ensure(maximum <= limits.valueBytes || result.status === 'unavailable', 'An enormous native value passed the production shape guard.');
    } finally { await run.stop(); }
  });
  await runCase('oversized-live-presentation-guards', async entry => {
    const base = captured.small!.presentations.at(-1)!.presentation;
    ensure(shellPresentation(base) !== null, 'The captured live presentation is invalid before mutation.');
    const row = (segments: { text: string }[]) => ({ id: 'oversized', depth: 0, effects: [], segments });
    const variants: [string, unknown][] = [
      ['row-segments', { ...base, rows: [row(Array.from({ length: 1025 }, () => ({ text: 'x' })))] }],
      ['row-text', { ...base, rows: [row([{ text: 'x'.repeat(65537) }])] }],
      ['annotation-value', { ...base, rows: [{ ...row([]), annotations: [{ name: 'VALUE', value: 'x'.repeat(16385) }] }] }],
      ['watch-value', { ...base, watches: [{ name: 'VALUE', value: 'x'.repeat(16385) }] }],
      ['response-bytes', { ...base, output: 'x'.repeat(limits.responseBytes + 1) }],
      ['total-segments', { ...base, rows: Array.from({ length: 50 }, (_, index) => ({ ...row(Array.from({ length: 1001 }, () => ({ text: '' }))), id: `many-${index}` })), original: [] }],
    ];
    entry.fixtureKind = 'Explicit oversized live-presentation mutations passed to the production shared guard.';
    const results = variants.map(([name, presentation]) => { const at = elapsed(); const refused = shellProps({ presentation, liveOrigin: true }) === null; const ms = elapsed() - at; return { name, refused, guardMs: ms }; });
    entry.results = results;
    ensure(results.every(value => value.refused), 'An oversized live presentation passed the production guard.');
    ensure(shellPresentation(base) !== null && base.output === captured.small!.presentations.at(-1)!.presentation.output, 'Guard calls mutated the captured live presentation.');
  });
  await runCase('process-group-rss-watchdog', async entry => {
    const trigger = join(root, 'pressure-start');
    const helper = join(root, 'memory-pressure.mjs');
    const launcher = join(root, 'omp-memory-launcher');
    // Controlled RSS pressure joins the production child's private group. The worker itself is unmodified.
    await writeFile(helper, `import { existsSync } from 'node:fs';\nconst retained=[];\nsetInterval(()=>{if(existsSync(${JSON.stringify(trigger)})) retained.push(Buffer.alloc(16*1024*1024,127));},25);\n`);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(launcher, `#!/bin/sh\n${quote(process.execPath)} ${quote(helper)} &\nexec ${quote(binary)} "$@"\n`, { mode: 0o700 });
    const run = await service('group-watchdog', launcher);
    try {
      const frame = await open(run.service, 'small'); ready(frame);
      await sleep(150);
      ensure(run.group.pid !== undefined && run.group.baselineRssBytes !== undefined, 'Watchdog group baseline is unavailable.');
      run.group.pressureStartedAtMs = elapsed(); await writeFile(trigger, 'start');
      const deadline = elapsed() + 10000;
      while (run.group.loss === undefined && elapsed() < deadline) await sleep(20);
      entry.loss = run.group.loss; entry.pressure = 'A fixture allocator in the same process group commits 16 MiB every 25ms.';
      ensure(run.group.loss === 'memory', `Expected production memory loss, received ${run.group.loss ?? 'no loss'}.`);
      const stoppedAt = elapsed() + 1000;
      while (run.group.exitAtMs === undefined && elapsed() < stoppedAt) await sleep(20);
      const survivors = (await processes()).filter(row => row.pgid === run.group.pid); entry.survivingGroupPids = survivors.map(row => row.pid);
      ensure(survivors.length === 0, 'The memory watchdog left a process-group member alive.');
      const after = await run.service.action(frame.handle, 'reset'); entry.invalidatedHandle = after;
      ensure(after.status === 'unavailable', 'The memory watchdog left a native handle available.');
      entry.independentSamplerObservedCrossing = run.group.firstOverLimitAtMs !== undefined;
      entry.terminationAfterObservedCrossingMs = run.group.terminationAfterCrossingMs;
      // The production watchdog can kill between independent 100ms samples. Its memory-loss callback
      // is still an observed threshold decision; require the same termination budget from that point.
      ensure(run.group.lossAtMs !== undefined && run.group.exitAtMs !== undefined, 'The production memory loss or group exit was not observed.');
      const lossToExitMs = run.group.exitAtMs - run.group.lossAtMs;
      entry.terminationAfterProductionMemoryLossMs = lossToExitMs;
      ensure(lossToExitMs >= 0 && lossToExitMs <= limits.terminationMs, 'Process-group termination after production memory loss exceeded 250ms.');
      if (run.group.firstOverLimitAtMs !== undefined) ensure(run.group.terminationAfterCrossingMs !== undefined && run.group.terminationAfterCrossingMs <= limits.terminationMs, 'Process-group termination after independently observed RSS crossing exceeded 250ms.');
    } finally { await run.stop(); }
  });
  await sleep(60);
  evidence.heartbeat = { intervalMs: limits.heartbeatMs, samples: heartbeatSamples, maximumDelayMs: heartbeatMax, passed: heartbeatMax <= limits.heartbeatDelayMs };
  if (heartbeatMax > limits.heartbeatDelayMs) failures.push(`parent-heartbeat: ${heartbeatMax}ms exceeds 100ms.`);
  ensure(modelRequests.length === 0, 'A provider/model request occurred during native capture or presentation.');
} catch (error) { failures.push(`${phase}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`); console.error(error); }
finally {
  clearInterval(heartbeat);
  for (const instance of services) await instance.close().catch(error => failures.push(`Service close: ${error}`));
  await capture?.close().catch(error => failures.push(`Capture close: ${error}`));
  await fixture?.close();
  if (fixtureHash) { evidence.fixtureSha256After = digest(await readFile(resultFile)); evidence.ordinaryOutputUnchanged = evidence.fixtureSha256After === fixtureHash; }
  evidence.modelRequestCount = modelRequests.length;
  evidence.passed = failures.length === 0;
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ output, passed: evidence.passed, cases: cases.map(({ name, passed, cause, p95Ms }) => ({ name, passed, cause, p95Ms })), heartbeat: evidence.heartbeat, memory: groups.map(({ name, pid, baselineRssBytes, peakRssBytes, loss }) => ({ name, pid, baselineRssBytes, peakRssBytes, loss })), failures }, null, 2));
  await rm(root, { recursive: true, force: true });
  if (failures.length) process.exitCode = 1;
}
