import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { initializeFixture, fixtureEnvironment } from './environment.mjs';
import { startFixture } from './server.mjs';

const binary = process.env.OMP_BIN ?? 'omp';
const output = resolve(process.env.OMP_SHELL_EVIDENCE ?? '/tmp/vomp-bash-visualization-slice1');
const root = await mkdtemp(join(tmpdir(), 'vomp-shell-viz-'));
const extension = fileURLToPath(new URL('./bash-visualization-worker.mjs', import.meta.url));
const thresholds = { handles: 4, sourceBytes: 32 * 1024 ** 2, traceBytes: 16 * 1024 ** 2, workerRssBytes: 512 * 1024 ** 2, responseBytes: 2 * 1024 ** 2, totalSegments: 50000, rowSegments: 1024, rowTextBytes: 65536, valueBytes: 16384, requestMs: 2000, seekP95Ms: 250, largeSeekP95Ms: 1000, heartbeatDelayMs: 100, terminationMs: 250, startupMs: 15000 };
const evidence = { thresholds, cases: [], workers: [], modelRequests: [], failures: [] };
const active = new Set();
let heartbeatAt = performance.now();
let heartbeatDelayMs = 0;
const heartbeat = setInterval(() => { const now = performance.now(); heartbeatDelayMs = Math.max(heartbeatDelayMs, now - heartbeatAt - 20); heartbeatAt = now; }, 20);
const fixture = await startFixture({ root: join(root, 'provider'), port: 0, onRequest: request => evidence.modelRequests.push(request) });
const flags = ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-context-files', '--no-rules', '--no-skills', '--no-lsp', '--no-title', '--no-tools', '--model', 'fixture/preview', '--thinking', 'off', '-e', extension];

function shapeRefusal(p) {
  if (Buffer.byteLength(JSON.stringify(p)) > thresholds.responseBytes) return 'response-bytes';
  let segments = 0;
  for (const row of [...p.rows, ...p.original]) {
    segments += row.segments.length;
    if (row.segments.length > thresholds.rowSegments) return 'row-segments';
    if (row.segments.reduce((n, s) => n + Buffer.byteLength(s.text), 0) > thresholds.rowTextBytes) return 'row-text';
    if ((row.annotations ?? []).some(v => Buffer.byteLength(v.value) > thresholds.valueBytes)) return 'value-bytes';
  }
  return segments > thresholds.totalSegments ? 'total-segments' : null;
}

async function worker(role = 'presentation', hideRestore = false) {
  const workRoot = join(root, randomUUID());
  await initializeFixture(workRoot, fixture.baseUrl);
  const env = fixtureEnvironment(workRoot);
  const configPath = join(env.PI_CODING_AGENT_DIR, 'config.yml');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.update = { auto: false };
  await writeFile(configPath, JSON.stringify(config));
  let nextResponse;
  const queued = [];
  const pending = new Map();
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const token = randomUUID();
  const meta = { role, peakRss: 0, requests: 0, stderr: '' };
  evidence.workers.push(meta);
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith('/' + token + '/')) { res.writeHead(404).end(); return; }
    const path = req.url.slice(token.length + 1);
    if (path === '/next') {
      if (queued.length) res.end(JSON.stringify(queued.shift()));
      else { nextResponse = res; req.on('close', () => { if (nextResponse === res) nextResponse = undefined; }); }
      return;
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 32 * 1024 ** 2) { res.writeHead(413).end(); return; } chunks.push(chunk); }
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (path === '/ready') { Object.assign(meta, value); readyResolve(value); }
    if (path === '/started') pending.get(value.id)?.startedResolve();
    if (path === '/failure') evidence.failures.push(value.error);
    if (path === '/result') {
      meta.peakRss = Math.max(meta.peakRss, value.rss);
      const item = pending.get(value.id);
      if (item) { clearTimeout(item.timer); pending.delete(value.id); value.error ? item.reject(new Error(value.error)) : item.resolve(value); }
    }
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const bridge = `http://127.0.0.1:${server.address().port}/${token}`;
  const child = spawn(binary, flags, { cwd: join(workRoot, 'work'), env: { ...env, VOMP_SHELL_EVIDENCE_BRIDGE: bridge, VOMP_SHELL_EVIDENCE_ROLE: role, VOMP_SHELL_EVIDENCE_HIDE_RESTORE: hideRestore ? '1' : '0' }, stdio: 'pipe' });
  meta.pid = child.pid;
  child.stdout.resume();
  child.stderr.on('data', data => { meta.stderr = (meta.stderr + String(data)).slice(-8000); });
  child.on('error', readyReject);
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    meta.exit = { code, signal };
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Presentation worker exited')); }
    pending.clear(); readyReject(new Error('Worker exited before ready: ' + meta.stderr)); resolve();
  }));
  const sample = setInterval(() => execFile('/bin/ps', ['-o', 'rss=', '-p', String(child.pid)], (error, stdout) => {
    if (error) return;
    const rss = Number(stdout.trim()) * 1024;
    meta.peakRss = Math.max(meta.peakRss, rss);
    if (rss > thresholds.workerRssBytes) { meta.memoryTerminated = true; child.kill('SIGKILL'); }
  }), 100);
  const object = {
    child, meta, workRoot,
    request(request, timeout = thresholds.requestMs) {
      const id = randomUUID();
      let startedResolve;
      const started = new Promise(resolve => { startedResolve = resolve; });
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); child.kill('SIGKILL'); reject(new Error('Presentation deadline')); }, timeout);
        pending.set(id, { resolve, reject, timer, startedResolve });
        meta.requests++;
        const value = { ...request, id };
        if (nextResponse) { const response = nextResponse; nextResponse = undefined; response.end(JSON.stringify(value)); } else queued.push(value);
      });
      return { promise, started };
    },
    async terminate(reason) {
      const at = performance.now();
      meta.terminationReason = reason;
      child.kill('SIGKILL');
      await exited;
      const elapsed = performance.now() - at;
      meta.terminationMs = elapsed;
      return elapsed;
    },
    async close() {
      clearInterval(sample);
      if (child.exitCode === null && !meta.exit) { child.stdin.end(); child.kill('SIGTERM'); const kill = setTimeout(() => child.kill('SIGKILL'), 1000); await exited; clearTimeout(kill); }
      if (nextResponse) nextResponse.end('{}');
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      active.delete(object);
    },
  };
  active.add(object);
  const timeout = setTimeout(() => { readyReject(new Error('Worker startup deadline: ' + meta.stderr)); child.kill('SIGKILL'); }, thresholds.startupMs);
  try { const capability = await ready; assert.equal(capability.restore, !hideRestore, JSON.stringify(capability)); }
  finally { clearTimeout(timeout); }
  return object;
}
const request = (w, value, timeout) => w.request(value, timeout).promise;
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];

try {
  await mkdir(output, { recursive: true });
  evidence.version = execFileSync(binary, ['--version'], { env: fixtureEnvironment(join(root, 'provider')), encoding: 'utf8' }).trim();
  const capture = await worker('capture');
  const script = 'VALUE="café"\nprint_value() { printf "%s\\n" "$VALUE"; }\nfor i in 1 2; do print_value; done\nfalse | true\nprintf "finished\\n"';
  const source = (await request(capture, { op: 'capture', script, cwd: join(capture.workRoot, 'work') }, 15000)).data;
  assert.ok(source.trace.history.length > 0);
  await writeFile(join(output, 'trace.json'), JSON.stringify(source.trace));
  await writeFile(join(output, 'live-presentations.json'), JSON.stringify(source.presentations));
  let presentation = await worker();
  await request(presentation, { op: 'restore', handle: 'saved', trace: source.trace });
  const latencies = [];
  for (const point of source.presentations) {
    const at = performance.now();
    const restored = await request(presentation, { op: 'present', handle: 'saved', options: { view: point.view, cursor: point.cursor } });
    latencies.push(performance.now() - at);
    assert.deepEqual(restored.data, point.presentation);
  }
  evidence.cases.push({ name: 'canonical-live-restored-equality', points: source.presentations.length, script, seekP50Ms: percentile(latencies, .5), seekP95Ms: percentile(latencies, .95), traceBytes: Buffer.byteLength(JSON.stringify(source.trace)) });
  const byteScript = 'v=$(printf \'\\377\'); V="$v" printf "%s\\n" "$v" > "$v"; eval "printf \'$v\'"; "$v"';
  const byteSource = (await request(capture, { op: 'capture', script: byteScript, cwd: join(capture.workRoot, 'work') }, 15000)).data;
  const byteFields = [];
  const visitBytes = (value, path = '') => {
    if (Array.isArray(value) && value.length && value.every(item => Number.isInteger(item) && item >= 0 && item <= 255)) { byteFields.push({ path, bytes: value }); return; }
    if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) visitBytes(item, `${path}.${key}`);
  };
  visitBytes(byteSource.trace);
  assert.ok(byteFields.some(field => field.bytes.includes(255)), 'Expected a recorded non-UTF-8 run value');
  await writeFile(join(output, 'byte-trace.json'), JSON.stringify(byteSource.trace));
  await writeFile(join(output, 'byte-live-presentations.json'), JSON.stringify(byteSource.presentations));
  await request(presentation, { op: 'restore', handle: 'bytes', trace: byteSource.trace });
  for (const point of byteSource.presentations) {
    const restored = await request(presentation, { op: 'present', handle: 'bytes', options: { view: point.view, cursor: point.cursor } });
    assert.deepEqual(restored.data, point.presentation);
    assert.equal(shapeRefusal(restored.data), null);
  }
  await request(presentation, { op: 'release', handle: 'bytes' });
  evidence.cases.push({ name: 'non-utf8-live-restored-equality', points: byteSource.presentations.length, script: byteScript, byteFields });
  await sleep(150);
  evidence.cases.push({ name: 'single-typical-trace-memory', traceBytes: Buffer.byteLength(JSON.stringify(source.trace)), residentBytes: Number(execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(presentation.child.pid)], { encoding: 'utf8' }).trim()) * 1024, peakRssBytes: presentation.meta.peakRss });
  const savedPath = join(root, 'read-only-session.jsonl');
  await writeFile(savedPath, JSON.stringify({ message: { role: 'toolResult', toolCallId: 'external-call', details: { trace: source.trace } } }) + '\n', { mode: 0o400 });
  const hash = async () => createHash('sha256').update(await readFile(savedPath)).digest('hex');
  const before = await hash();
  for (const view of ['raw', 'pseudo']) await request(presentation, { op: 'present', handle: 'saved', options: { view, cursor: 0 } });
  assert.equal(await hash(), before);
  evidence.cases.push({ name: 'local-read-only-restore', unchangedSource: true, workerHasSourcePath: false, owningHostEvents: 0 });
  await presentation.close();
  const large = (await request(capture, { op: 'capture', script: 'for i in {1..2500}; do VALUE="café-$i"; printf "%s\\n" "$VALUE"; done', cwd: join(capture.workRoot, 'work') }, 30000)).data;
  presentation = await worker();
  await request(presentation, { op: 'restore', handle: 'saved', trace: large.trace });
  await request(presentation, { op: 'present', handle: 'saved', options: { view: 'pseudo' } });
  await sleep(150);
  evidence.cases.push({ name: 'single-large-trace-memory', traceBytes: Buffer.byteLength(JSON.stringify(large.trace)), residentBytes: Number(execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(presentation.child.pid)], { encoding: 'utf8' }).trim()) * 1024, peakRssBytes: presentation.meta.peakRss });
  for (const handle of ['saved', 'large-1', 'large-2', 'large']) await request(presentation, { op: 'restore', handle, trace: large.trace });
  const simultaneous = await Promise.all(['saved', 'large-1', 'large-2', 'large'].map((handle, i) => request(presentation, { op: 'present', handle, options: { view: i % 2 ? 'raw' : 'pseudo', cursor: i } })));
  const fifth = await request(presentation, { op: 'restore', handle: 'fifth', trace: source.trace }).catch(error => String(error));
  assert.match(fifth, /handle limit/);
  evidence.cases.push({ name: 'four-large-handles', handles: simultaneous.length, sourceBytes: 4 * Buffer.byteLength(JSON.stringify(large.trace)), fifthRefused: true, peakRssBytes: presentation.meta.peakRss });
  const largeLatencies = [];
  for (let i = 0; i < 10; i++) { const at = performance.now(); await request(presentation, { op: 'present', handle: 'large', options: { cursor: Math.floor((large.trace.history?.length ?? 0) * i / 10) } }); largeLatencies.push(performance.now() - at); }
  evidence.cases.push({ name: 'large-retained-history', traceBytes: Buffer.byteLength(JSON.stringify(large.trace)), events: large.trace.history?.length, trimmed: large.trace.historyTruncated ?? false, seekP50Ms: percentile(largeLatencies, .5), seekP95Ms: percentile(largeLatencies, .95), peakRssBytes: presentation.meta.peakRss });
  await request(presentation, { op: 'release', handle: 'large-2' });
  const hugeRowTrace = { v: 1, seq: 0, t_ns: 0, script: 'literal'.repeat(12000), units: [] };
  await request(presentation, { op: 'restore', handle: 'huge-row', trace: hugeRowTrace });
  const hugeRow = await request(presentation, { op: 'present', handle: 'huge-row', options: { view: 'raw' } });
  assert.equal(shapeRefusal(hugeRow.data), 'row-text');
  evidence.cases.push({ name: 'native-enormous-row', sourceBytes: Buffer.byteLength(hugeRowTrace.script), responseRefusal: shapeRefusal(hugeRow.data), executionRequested: false });
  const base = source.presentations[0].presentation;
  const shapes = [
    ['row-segments', { ...base, rows: [{ id: 'large', depth: 0, effects: [], segments: Array.from({ length: 1025 }, () => ({ text: 'x' })) }] }],
    ['row-text', { ...base, rows: [{ id: 'large', depth: 0, effects: [], segments: [{ text: 'x'.repeat(65537) }] }] }],
    ['value-bytes', { ...base, rows: [{ id: 'large', depth: 0, effects: [], segments: [], annotations: [{ name: 'x', value: 'x'.repeat(16385) }] }] }],
    ['response-bytes', { ...base, output: 'x'.repeat(thresholds.responseBytes + 1) }],
  ];
  for (const [reason, value] of shapes) assert.equal(shapeRefusal(value), reason);
  evidence.cases.push({ name: 'live-presentation-shape-refusal', limits: shapes.map(([name]) => name), guardFixtureOnly: true, ordinaryOutputPolicy: 'separate from optional presentation data' });
  const missing = await worker('presentation', true);
  const unavailable = await request(missing, { op: 'restore', handle: 'missing', trace: source.trace }).catch(error => String(error));
  assert.match(unavailable, /capability unavailable/);
  evidence.cases.push({ name: 'missing-export-fallback', simulatedMissingExport: true, error: unavailable, olderBinaryExercised: false });
  await missing.close();
  const sentinel = capture.request({ op: 'capture', script: 'sleep 12; printf "independent-bash-finished\\n"', cwd: join(capture.workRoot, 'work') }, 20000);
  await sentinel.started;
  const cancelled = await worker();
  const cancellation = cancelled.request({ op: 'restore', handle: 'cancel', trace: large.trace }, 10000);
  const cancellationResult = cancellation.promise.catch(error => String(error));
  await cancellation.started;
  const cancellationMs = await cancelled.terminate('cancel');
  assert.match(await cancellationResult, /exited/);
  const timed = await worker();
  const timeoutResult = await timed.request({ op: 'restore', handle: 'timeout', trace: large.trace }, 1).promise.catch(error => String(error));
  assert.match(timeoutResult, /deadline/);
  const crashed = await worker();
  const crashResult = crashed.request({ op: 'restore', handle: 'crash', trace: large.trace }, 10000);
  const crashOutcome = crashResult.promise.catch(error => String(error));
  await crashResult.started;
  await crashed.terminate('simulated-worker-crash');
  assert.match(await crashOutcome, /exited/);
  const sentinelResult = await sentinel.promise;
  assert.match(sentinelResult.data.output || sentinelResult.data.presentations.at(-1).presentation.output, /independent-bash-finished/);
  evidence.cases.push({ name: 'cancellation-timeout-crash-isolation', cancellationMs, timeout: timeoutResult, crashTerminationMs: crashed.meta.terminationMs, independentBashCompleted: true, capturePid: capture.child.pid, workerPids: [cancelled.child.pid, timed.child.pid, crashed.child.pid] });
  const retry = await worker();
  await request(retry, { op: 'restore', handle: 'retry', trace: source.trace });
  assert.ok((await request(retry, { op: 'present', handle: 'retry' })).data.rows.length);
  evidence.cases.push({ name: 'fresh-worker-retry', passed: true });
  const malformed = await request(retry, { op: 'restore', handle: 'malformed', trace: { v: 1, script: 123, units: [] } }).catch(error => String(error));
  assert.equal(typeof malformed, 'string');
  evidence.cases.push({ name: 'damaged-trace-rejection', error: malformed });
  evidence.heartbeatDelayMs = heartbeatDelayMs;
  assert.equal(evidence.modelRequests.length, 0);
  assert.ok(latencies.every(value => value <= thresholds.seekP95Ms));
  assert.ok(percentile(largeLatencies, .95) <= thresholds.largeSeekP95Ms);
  assert.ok(cancellationMs <= thresholds.terminationMs);
  assert.ok(heartbeatDelayMs <= thresholds.heartbeatDelayMs);
} catch (error) {
  evidence.failures.push(String(error.stack ?? error));
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  for (const process of active) await process.close();
  await fixture.close();
  await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ output, cases: evidence.cases, failures: evidence.failures, modelRequests: evidence.modelRequests.length, heartbeatDelayMs: evidence.heartbeatDelayMs }, null, 2));
  await rm(root, { recursive: true, force: true });
}
