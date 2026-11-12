import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHeartbeatDiagnostics } from './heartbeat-diagnostics.mjs';
import { createGateRuntimeProbe } from './gate-runtime-probe.mjs';
import { compareRssObservation, originalCloseWindow } from './windows-gate-policy.mjs';

// Package the production entry separately, without replacing its imports or implementation:
// bun build ./src/main/omp/shell-visualization-worker.ts --target=node --format=esm --outfile=<bundle>/worker.mjs
// Copy this file, heartbeat-diagnostics.mjs, gate-runtime-probe.mjs, windows-gate-policy.mjs and the three bash-visualization-windows-* fixture sources next to it.
// Run with native Windows Node, using an unused --output directory. This driver never runs on another OS.
const args = process.argv.slice(2);
const cli = {};
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  assert.ok(['--worker', '--omp', '--trace', '--output', '--expected-version'].includes(flag) && args[index + 1] && !(flag.slice(2) in cli), 'Expected --worker, --omp, --trace and --output once each, with optional --expected-version');
  cli[flag.slice(2)] = args[index + 1];
}
assert.equal(process.platform, 'win32', 'The gate requires native Windows Node');
for (const name of ['worker', 'omp', 'trace', 'output']) assert.ok(cli[name] && isAbsolute(cli[name]), `--${name} must be absolute`);
assert.match(cli.omp, /\.(exe|com)$/i, '--omp must name a native executable');
cli['expected-version'] ??= '18.18.5';
assert.match(cli['expected-version'], /^\d+\.\d+\.\d+$/, '--expected-version must be an exact release version');
const thresholds = Object.freeze({ startupMs: 15000, requestMs: 2000, rssBytes: 512 * 1024 * 1024, monitorRssBytes: 160 * 1024 * 1024, totalRssBytes: 672 * 1024 * 1024, pollMs: 100, sampleMs: 1000, closeMs: 250, heartbeatMs: 100 });
let active;
let stage = 'preflight-output';
const diagnosticContext = {};
const diagnostics = createHeartbeatDiagnostics({
  thresholdMs: thresholds.heartbeatMs,
  context: () => { diagnosticContext.stage = stage; diagnosticContext.case = active?.name; return diagnosticContext; },
});
await mkdir(cli.output); // Exclusive ownership. Never overwrite another run's evidence.
const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureSource = join(fixtureDirectory, 'bash-visualization-windows-fixture.cs');
const inspectorScript = join(fixtureDirectory, 'bash-visualization-windows-inspector.ps1');
const sentinelSource = join(fixtureDirectory, 'bash-visualization-windows-sentinel.mjs');
const windows = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1];
assert.ok(windows && win32.isAbsolute(windows), 'SYSTEMROOT must be absolute');
const powershell = join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const psArgs = script => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];
const originalSpawn = cp.spawn.bind(cp);
const originalExecFile = cp.execFile.bind(cp);
const evidence = { platform: process.platform, arch: process.arch, node: process.version, argv: cli, thresholds, cases: [], forbiddenProcesses: [], inspector: [], passed: false };
stage = 'preflight';
const originalJsonParse = JSON.parse;
const originalJsonStringify = JSON.stringify;
JSON.parse = function(text, reviver) { return diagnostics.sync('json.parse', () => originalJsonParse(text, reviver), { inputChars: typeof text === 'string' ? text.length : null }); };
JSON.stringify = function(value, replacer, space) { return diagnostics.sync('json.stringify', () => originalJsonStringify(value, replacer, space)); };
function enterStage(value) { stage = value; (evidence.stages ??= []).push({ stage, at: performance.now(), case: active?.name }); }
let observer;
let unrelated;
let unrelatedKey;
let safeEnv;
let runtimeProbe;
let inspectorId = 0;
const inspectorPending = new Map();
const epochFileTime = milliseconds => ((BigInt(Math.trunc(milliseconds)) + 11644473600000n) * 10000n).toString();
const textError = error => error instanceof Error ? `${error.name}: ${error.message}` : String(error);
const exited = child => child.exitCode !== null || child.signalCode !== null;
function deadline(promise, milliseconds, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]).finally(() => clearTimeout(timer));
}
function exitPromise(child) {
  if (exited(child)) return Promise.resolve();
  return new Promise((resolveExit, reject) => { child.once('exit', resolveExit); child.once('error', reject); });
}
async function until(predicate, milliseconds, label) {
  const start = performance.now();
  do { const result = await predicate(); if (result) return result; await sleep(20); } while (performance.now() - start < milliseconds);
  throw new Error(label);
}
async function peArchitecture(path) {
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    const dos = Buffer.alloc(64);
    assert.equal((await file.read(dos, 0, dos.length, 0)).bytesRead, dos.length, 'Truncated executable DOS header');
    assert.equal(dos.readUInt16LE(0), 0x5a4d, 'Executable has no DOS signature');
    const offset = dos.readUInt32LE(60);
    assert.ok(offset >= 64 && offset <= size - 6, 'Executable PE header offset is outside the file');
    const pe = Buffer.alloc(6);
    assert.equal((await file.read(pe, 0, pe.length, offset)).bytesRead, pe.length, 'Truncated executable PE header');
    assert.equal(pe.readUInt32LE(0), 0x00004550, 'Executable has no PE signature');
    const machine = pe.readUInt16LE(4);
    const architecture = { 0x014c: 'ia32', 0x8664: 'x64', 0xaa64: 'arm64' }[machine];
    assert.ok(architecture, 'Unsupported native executable PE architecture');
    return { architecture, machine, headerBytesRead: dos.length + pe.length, fileBytes: size };
  } finally { await file.close(); }
}
function spawnObserved(file, args, options, origin) {
  const child = diagnostics.sync('child_process.spawn', () => originalSpawn(file, args, options), { origin });
  if (child.stdout) {
    const emit = child.stdout.emit;
    child.stdout.emit = function(event, ...values) {
      if (event !== 'data') return emit.call(this, event, ...values);
      return diagnostics.sync('child.stdout.data.handlers', () => emit.call(this, event, ...values), { origin, chunkBytes: Buffer.isBuffer(values[0]) ? values[0].length : Buffer.byteLength(String(values[0]), 'utf8') });
    };
  }
  return child;
}
function lines(stream, onLine, onError, maximumBytes = 1024 * 1024) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => diagnostics.sync('driver.protocol.chunk', () => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
      try { assert.ok(Buffer.byteLength(line, 'utf8') <= maximumBytes, 'Protocol line exceeds evidence bound'); onLine(line); } catch (error) { onError(error); }
    }
    if (Buffer.byteLength(buffer, 'utf8') > maximumBytes) { onError(new Error('Protocol line exceeds evidence bound')); buffer = ''; }
  }, { chunkChars: chunk.length }));
  stream.on('end', () => { if (buffer.trim()) onError(new Error('Incomplete protocol line')); });
}
function sampleBreakdown(message) {
  assert.ok(Number.isSafeInteger(message.helperRssBytes) && message.helperRssBytes > 0 && message.helperRssBytes <= message.rssBytes, 'Invalid sampled helper RSS');
  if (message.pids.length > 256) {
    assert.equal(message.breakdownOmitted, true, 'Large job must mark its omitted member breakdown');
    assert.equal(message.memberRssBytes, undefined, 'Large job member breakdown exceeds the diagnostic bound');
  } else {
    assert.equal(message.breakdownOmitted, undefined, 'Unexpected omitted member breakdown');
    assert.ok(Array.isArray(message.memberRssBytes) && message.memberRssBytes.length === message.pids.length && message.memberRssBytes.every(bytes => Number.isSafeInteger(bytes) && bytes > 0), 'Invalid aligned member RSS breakdown');
    const sum = message.memberRssBytes.reduce((total, bytes) => total + bytes, message.helperRssBytes);
    assert.ok(Number.isSafeInteger(sum) && sum === message.rssBytes, 'Sample RSS differs from full member and helper working-set sum');
  }
  const jobRssBytes = message.rssBytes - message.helperRssBytes;
  assert.ok(Number.isSafeInteger(jobRssBytes) && jobRssBytes > 0, 'Invalid sampled native job RSS');
  return { jobRssBytes, helperRssBytes: message.helperRssBytes, memberRssBytes: message.memberRssBytes, breakdownOmitted: message.breakdownOmitted };
}
function forbidden(file, args = []) {
  const index = args.findIndex(value => String(value).toLowerCase() === '-file');
  const monitor = index >= 0 && win32.basename(String(args[index + 1])).toLowerCase() === 'monitor.ps1';
  if (/taskkill(?:\.exe)?$/i.test(file) || (/powershell(?:\.exe)?$/i.test(file) && !monitor) || args.some(value => /Get-CimInstance|Win32_Process/i.test(String(value)))) {
    evidence.forbiddenProcesses.push({ case: active?.name, file, at: performance.now() });
  }
}
cp.execFile = function(file, args, ...rest) { forbidden(String(file), Array.isArray(args) ? args : []); return diagnostics.sync('child_process.execFile', () => originalExecFile(file, args, ...rest), { origin: 'production' }); };
cp.spawn = function(file, args, options) {
  forbidden(String(file), args);
  const spawnAt = performance.now(); const spawnWallAt = Date.now();
  const child = spawnObserved(file, args, options, 'production');
  const fileIndex = args?.findIndex(value => String(value).toLowerCase() === '-file') ?? -1;
  const script = fileIndex >= 0 ? args[fileIndex + 1] : undefined;
  if (!script || win32.basename(script).toLowerCase() !== 'monitor.ps1') return child;
  const entry = active;
  if (!entry) { evidence.forbiddenProcesses.push({ file, reason: 'Monitor launched outside a gate case' }); return child; }
  const monitor = { pid: child.pid, script, config: args[fileIndex + 2], at: spawnAt, wallAt: spawnWallAt, spawnReturnedAt: performance.now(), commands: [], events: [], samples: [], violations: [], maxConcurrentSamples: 0, pending: new Map(), child };
  entry.monitors.push(monitor);
  monitor.exit = exitPromise(child).then(() => { monitor.exitAt = performance.now(); });
  void monitor.exit.catch(error => monitor.violations.push(textError(error)));
  const commandWrite = child.stdin.write.bind(child.stdin);
  let commands = '';
  child.stdin.write = function(chunk, ...rest) {
    commands += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    for (;;) {
      const end = commands.indexOf('\n'); if (end < 0) break;
      const command = commands.slice(0, end).replace(/\r$/, ''); commands = commands.slice(end + 1);
      const at = performance.now(); monitor.commands.push({ command, at });
      if (command === 'start') {
        if (!monitor.events.some(event => event.event === 'ready')) monitor.violations.push('Target authorized before helper readiness');
        monitor.startAt = at;
      } else if (/^sample:[1-9]\d*$/.test(command)) {
        const id = Number(command.slice(7));
        if (monitor.pending.has(id)) monitor.violations.push('Duplicate sample id');
        monitor.pending.set(id, at); monitor.maxConcurrentSamples = Math.max(monitor.maxConcurrentSamples, monitor.pending.size);
      } else if (/^stop:[1-9]\d*$/.test(command)) {
        monitor.stopAt = at; monitor.stopId = Number(command.slice(5));
        for (const [id, requestedAt] of monitor.pending) monitor.samples.push({ id, requestedAt, cancelledAt: at });
        monitor.pending.clear();
      } else monitor.violations.push('Unexpected monitor command');
    }
    return commandWrite(chunk, ...rest);
  };
  lines(child.stdout, line => {
    const message = JSON.parse(line); const at = performance.now();
    monitor.events.push({ ...message, at });
    if (message.event === 'ready') {
      monitor.readyAt = at;
      if (entry.cancelOnReady && !entry.abortAt) { entry.abortAt = performance.now(); entry.controller.abort(); }
    } else if (message.event === 'spawned') {
      assert.ok(Number.isSafeInteger(message.pid) && message.pid > 0, 'Invalid target PID');
      assert.ok(monitor.startAt !== undefined, 'Target spawned without authorization');
      monitor.targetPid = message.pid; monitor.spawnedWallAt = Date.now();
    } else if (message.event === 'sample') {
      const requestedAt = monitor.pending.get(message.id);
      if (requestedAt === undefined) {
        const cancelled = monitor.samples.find(sample => sample.id === message.id && sample.cancelledAt !== undefined && sample.lateCompletionAt === undefined);
        assert.ok(cancelled, 'Sample has no matching request');
        cancelled.lateCompletionAt = at;
        cancelled.lateCompletionIgnored = true;
        return;
      }
      assert.ok(requestedAt !== undefined, 'Sample has no matching request'); monitor.pending.delete(message.id);
      assert.ok(Number.isSafeInteger(message.rssBytes) && message.rssBytes > 0, 'Invalid sampled RSS');
      assert.ok(Number.isFinite(message.cpuMs) && message.cpuMs >= 0, 'Invalid helper CPU');
      assert.ok(Array.isArray(message.pids) && message.pids.length > 0 && message.pids.length <= 4096 && new Set(message.pids).size === message.pids.length && message.pids.every(pid => Number.isSafeInteger(pid) && pid > 0), 'Invalid sampled job members');
      monitor.samples.push({ id: message.id, requestedAt, at, rttMs: at - requestedAt, rssBytes: message.rssBytes, pids: message.pids, cpuMs: message.cpuMs, ...sampleBreakdown(message) });
    } else if (message.event === 'stopped') {
      assert.equal(message.id, monitor.stopId, 'Stop acknowledgement id differs'); monitor.stoppedAt = at;
    } else if (message.event === 'error') {
      assert.ok(['startup', 'start', 'command', 'sample', 'stop'].includes(message.phase), 'Invalid fixed monitor error phase');
      assert.ok(['failed', 'deadline'].includes(message.code), 'Invalid fixed monitor error code');
      assert.ok(Object.keys(message).every(key => ['event', 'id', 'phase', 'code'].includes(key)), 'Monitor error contains unexpected diagnostics');
      if (message.id !== undefined) assert.ok(Number.isSafeInteger(message.id) && message.id > 0, 'Invalid monitor error id');
      const requestedAt = monitor.pending.get(message.id);
      if (requestedAt !== undefined) {
        monitor.pending.delete(message.id);
        monitor.samples.push({ id: message.id, requestedAt, errorAt: at, rttMs: at - requestedAt, phase: message.phase, code: message.code });
      }
    } else throw new Error('Unexpected monitor event');
  }, error => monitor.violations.push(textError(error)), 64 * 1024);
  return child;
};
syncBuiltinESMExports(); // Install observers before production captures the built-in spawn binding.

function inspect(request) {
  const id = ++inspectorId;
  const reply = new Promise((resolveReply, reject) => inspectorPending.set(id, { resolve: resolveReply, reject }));
  observer.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
  return deadline(reply, 5000, 'Independent process inspection timed out').finally(() => inspectorPending.delete(id));
}
async function pin(entry, row, maximum = Date.now(), minimum = entry.wallAt) {
  const key = `${entry.name}:${row.pid}`;
  const value = await inspect({ op: 'pin', key, pid: row.pid, minimum: epochFileTime(minimum), maximum: epochFileTime(maximum + 1), image: row.image, marker: row.marker, expected: row.creation ?? '' });
  if (!entry.keys.includes(key)) entry.keys.push(key); return value;
}
async function snapshots(entry, exitDeadline) { return Promise.all(entry.keys.map(key => inspect({ op: 'snapshot', key, ...(exitDeadline === undefined ? {} : { exitDeadline }) }))); }
async function verifyClosed(entry, startAt, startWallAt) {
  const exitDeadline = epochFileTime(startWallAt + thresholds.closeMs);
  entry.exitDeadline = exitDeadline;
  try { entry.afterClose = await snapshots(entry, exitDeadline); }
  finally {
    entry.independentCloseMs = performance.now() - startAt;
    entry.independentVerifiedAt = epochFileTime(Date.now());
  }
  assert.ok(entry.afterClose.every(row => row.exited), 'Owned process survived successful close');
  assert.ok(entry.afterClose.every(row => typeof row.exitRechecked === 'boolean' && typeof row.exitConfirmedAt === 'string' && /^\d+$/.test(row.exitConfirmedAt) && BigInt(row.exitConfirmedAt) <= BigInt(exitDeadline)), 'Independent process exit was not confirmed within the original close deadline');
  assert.ok(entry.independentCloseMs <= thresholds.closeMs && BigInt(entry.independentVerifiedAt) <= BigInt(exitDeadline), 'Complete independent close verification exceeded the original 250 milliseconds');
}
async function request(worker, entry, value) {
  const at = performance.now();
  try { return await deadline(diagnostics.sync('production.request.dispatch', () => worker.request(value), { operation: value.op }), thresholds.requestMs + 100, 'Production request exceeded its deadline'); }
  finally { const wallMs = performance.now() - at; entry.requests.push({ op: value.op, wallMs }); assert.ok(wallMs <= thresholds.requestMs, 'Production request exceeded 2 seconds'); }
}
function validateMonitor(entry) {
  assert.equal(entry.monitors.length, 1, 'Expected one private PowerShell monitor');
  const monitor = entry.monitors[0];
  assert.deepEqual(monitor.violations, [], 'Monitor protocol violations');
  assert.equal(monitor.events.some(event => event.event === 'error'), false, 'Monitor reported a fixed phase/code failure');
  assert.ok(monitor.readyAt !== undefined && monitor.readyAt - monitor.at <= thresholds.startupMs, 'Helper startup exceeded 15 seconds');
  assert.ok(monitor.maxConcurrentSamples <= 1, 'Overlapping production samples');
  assert.ok(monitor.exitAt !== undefined, 'Monitor exit is unconfirmed');
  if (entry.cancelOnReady) {
    assert.equal(monitor.targetPid, undefined, 'Startup cancellation created a target');
    assert.equal(monitor.commands.some(command => command.command === 'start'), false, 'Startup cancellation authorized a target');
    return;
  }
  assert.ok(monitor.targetPid, 'Monitor never reported a target');
  assert.ok(monitor.stoppedAt !== undefined, 'Missing positive stopped acknowledgement');
  assert.ok(monitor.stoppedAt - monitor.stopAt <= 200, 'Stop acknowledgement exceeded the parent deadline');
  // The job is confirmed empty at acknowledgement; the helper's exit may use the rest of the same 250 ms close window.
  assert.ok(monitor.exitAt - monitor.stopAt <= thresholds.closeMs, 'Helper exit exceeded the 250 millisecond close window');
  const complete = monitor.samples.filter(sample => sample.at !== undefined);
  assert.ok(complete.length >= 3, 'Insufficient production samples');
  for (let index = 0; index < complete.length; index++) {
    const sample = complete[index];
    assert.ok(sample.rttMs <= thresholds.sampleMs, 'Sample RTT exceeded 1 second');
    assert.ok(sample.helperRssBytes <= thresholds.monitorRssBytes, 'Private monitor RSS exceeded its independent 160 MiB cap');
    if (entry.mode !== 'memory') assert.ok(sample.jobRssBytes <= thresholds.rssBytes, 'Native job RSS exceeded its unchanged 512 MiB cap');
    assert.ok(!sample.pids.includes(unrelated.pid), 'Unrelated sentinel was counted as an owned descendant');
    if (index) assert.ok(sample.cpuMs >= complete[index - 1].cpuMs, 'Cumulative helper CPU decreased');
  }
  for (const sample of monitor.samples.filter(sample => sample.cancelledAt !== undefined)) assert.ok(sample.cancelledAt - sample.requestedAt <= thresholds.sampleMs, 'An unanswered sample exceeded 1 second before stop');
  assert.equal(monitor.commands.filter(command => command.command === 'start').length, 1, 'Expected exactly one target authorization');
  assert.equal(monitor.commands.some(command => command.command.startsWith('sample:') && command.at > monitor.stopAt), false, 'Sampling continued after stop');
}
async function exercise(name, executable, mode, directory, createInstalledShellWorker) {
  const entry = { name, mode, directory, wallAt: Date.now(), at: performance.now(), monitors: [], requests: [], keys: [], cleanup: [], passed: false, controller: new AbortController(), cancelOnReady: mode === 'startup-cancel' };
  evidence.cases.push(entry); active = entry;
  enterStage('worker-startup');
  let worker;
  try {
    const starting = diagnostics.sync('production.worker.start', () => createInstalledShellWorker({ executable, env: safeEnv, signal: entry.controller.signal, onLoss(reason) { entry.loss = reason; entry.lossAt = performance.now(); entry.lossWallAt = Date.now(); } }));
    if (entry.cancelOnReady) {
      try { worker = await deadline(starting, thresholds.startupMs + 1000, 'Startup cancellation never settled'); throw new Error('Cancelled startup resolved'); }
      catch (error) { entry.startupError = textError(error); assert.equal(error.reason, 'cancelled', 'Startup cancellation must report cancelled'); }
      entry.closeMs = performance.now() - entry.abortAt;
      assert.ok(Number.isFinite(entry.closeMs) && entry.closeMs <= thresholds.closeMs, 'Startup cancellation cleanup exceeded 250 milliseconds');
    } else {
      worker = await deadline(starting, thresholds.startupMs + 1000, 'Production startup never settled');
      entry.startupMs = performance.now() - entry.at;
      assert.ok(entry.startupMs <= thresholds.startupMs, 'Native worker startup exceeded 15 seconds');
      enterStage('worker-requests');
      await request(worker, entry, { op: 'restore', handle: name, json: evidence.traceText });
      const presentation = await request(worker, entry, { op: 'present', handle: name, options: { view: 'pseudo', layers: { color: true, inline: true, idioms: true, effects: true, unwrap: true }, split: false, playing: false, speed: 1, expandedNodes: [] } });
      assert.ok(presentation && typeof presentation === 'object' && Array.isArray(presentation.rows) && presentation.rows.length > 0, 'Production native presentation returned no rows');
      entry.presentationRows = presentation.rows.length;
      assert.equal(entry.monitors.length, 1, 'Missing private monitor instrumentation');
      const monitor = entry.monitors[0];
      const config = JSON.parse(await readFile(monitor.config, 'utf8'));
      assert.equal(resolve(config.executable).toLowerCase(), resolve(executable).toLowerCase(), 'Monitor did not launch the requested executable');
      const extensionIndex = config.args.indexOf('-e');
      assert.ok(extensionIndex >= 0 && isAbsolute(config.args[extensionIndex + 1]), 'Expected production private extension');
      entry.extension = config.args[extensionIndex + 1];
      enterStage('identity-verification');
      await pin(entry, { pid: monitor.pid, image: powershell, marker: monitor.script }, monitor.wallAt + 1000);
      await pin(entry, { pid: monitor.targetPid, image: executable, marker: mode === 'direct' ? entry.extension : executable }, monitor.spawnedWallAt);
      if (mode !== 'direct') {
        const ledger = await until(async () => { try { return JSON.parse(await readFile(join(directory, 'launcher-owned.json'), 'utf8')); } catch { return undefined; } }, 2000, 'Launcher did not publish owned identities');
        assert.ok(Array.isArray(ledger) && ledger.length === 3 && new Set(ledger.map(row => row.pid)).size === 3, 'Expected three distinct launcher-owned processes');
        assert.deepEqual(ledger.map(row => row.role).sort(), ['node', 'omp', 'root'], 'Launcher roles must describe the actual nested processes');
        const root = ledger.find(row => row.role === 'root');
        const node = ledger.find(row => row.role === 'node');
        const omp = ledger.find(row => row.role === 'omp');
        assert.equal(root.pid, monitor.targetPid, 'Launcher root differs from the production target');
        assert.equal(root.parentPid, monitor.pid, 'Launcher root is outside the private monitor');
        assert.equal(node.parentPid, root.pid, 'Node sentinel is outside the launcher root');
        assert.equal(omp.parentPid, node.pid, 'Native omp is outside the Node sentinel');
        const nodeLedger = JSON.parse(await readFile(join(directory, 'node.json'), 'utf8'));
        assert.equal(nodeLedger.pid, node.pid);
        assert.equal(nodeLedger.parentPid, root.pid);
        assert.equal(nodeLedger.ompPid, omp.pid);
        assert.equal(nodeLedger.retainedBytes, 0, 'Fixture allocated pressure buffers before authorization');
        assert.equal(resolve(nodeLedger.ompExecutable).toLowerCase(), resolve(cli.omp).toLowerCase());
        assert.deepEqual(nodeLedger.ompArgs, config.args, 'Nested omp argv differs from production');
        for (const [row, image, marker] of [[root, executable, executable], [node, process.execPath, join(directory, 'sentinel.mjs')], [omp, cli.omp, entry.extension]]) {
          assert.equal(resolve(row.image).toLowerCase(), resolve(image).toLowerCase(), 'Launcher image differs from its owned role');
          assert.equal(row.marker, marker, 'Launcher marker differs from its owned role');
          const pinned = await pin(entry, row);
          assert.equal(pinned.parentPid, row.parentPid, 'Independent parent identity differs from the launcher ledger');
        }
        entry.topology = ledger;
        entry.nativeArgv = nodeLedger.ompArgs;
      }
      enterStage('sampling-coverage');
      const beforeCaptureStart = performance.now();
      const before = await snapshots(entry); entry.identities = before;
      const beforeCaptureEnd = performance.now();
      assert.ok(before.every(row => !row.exited), 'An owned process exited before the gate');
      const expectedPids = before.filter(row => row.pid !== monitor.pid).map(row => row.pid);
      const beforeBytes = before.reduce((sum, row) => sum + row.rssBytes, 0);
      const nextAt = performance.now();
      entry.samplingCoverage = await until(() => monitor.samples.filter(sample => sample.at !== undefined).length >= 3 && monitor.samples.find(sample => sample.at !== undefined && sample.requestedAt >= nextAt && expectedPids.every(pid => sample.pids.includes(pid))), 2000, 'Production sampling did not include all owned descendants');
      const afterCaptureStart = performance.now();
      const afterSample = await snapshots(entry);
      const afterCaptureEnd = performance.now();
      assert.ok(afterSample.every(row => !row.exited), 'An owned process exited during sample coverage');
      entry.independentRss = { beforeBytes, afterBytes: afterSample.reduce((sum, row) => sum + row.rssBytes, 0), includesHelperPid: monitor.pid, beforeMembers: before, afterMembers: afterSample };
      entry.independentRss.beforeJobBytes = before.filter(row => row.pid !== monitor.pid).reduce((sum, row) => sum + row.rssBytes, 0);
      entry.independentRss.afterJobBytes = afterSample.filter(row => row.pid !== monitor.pid).reduce((sum, row) => sum + row.rssBytes, 0);
      entry.independentRss.beforeHelperBytes = before.find(row => row.pid === monitor.pid).rssBytes;
      entry.independentRss.afterHelperBytes = afterSample.find(row => row.pid === monitor.pid).rssBytes;
      entry.independentRss.observationWindows = {
        definition: 'Separate native working-set reads at different instants. Production request/receipt bounds follow the completed before capture and precede the after capture.',
        before: { start: beforeCaptureStart, end: beforeCaptureEnd },
        production: { start: entry.samplingCoverage.requestedAt, end: entry.samplingCoverage.at },
        after: { start: afterCaptureStart, end: afterCaptureEnd },
      };
      entry.independentRss.comparisons = {
        job: compareRssObservation(entry.samplingCoverage.jobRssBytes, entry.independentRss.beforeJobBytes, entry.independentRss.afterJobBytes, expectedPids.length),
        helper: compareRssObservation(entry.samplingCoverage.helperRssBytes, entry.independentRss.beforeHelperBytes, entry.independentRss.afterHelperBytes),
        total: compareRssObservation(entry.samplingCoverage.rssBytes, entry.independentRss.beforeBytes, entry.independentRss.afterBytes, before.length),
      };
      assert.ok(entry.independentRss.comparisons.job.withinTolerance, 'Cross-time native job RSS difference exceeds comparison tolerance');
      assert.ok(entry.independentRss.comparisons.helper.withinTolerance, 'Cross-time helper RSS difference exceeds comparison tolerance');
      assert.ok(entry.independentRss.comparisons.total.withinTolerance, 'Cross-time total RSS difference exceeds comparison tolerance');
      assert.equal((await inspect({ op: 'snapshot', key: unrelatedKey })).exited, false, 'Unrelated sentinel died before close');
      if (mode === 'memory') {
        enterStage('memory-pressure');
        await writeFile(join(directory, 'pressure-start'), 'start\n');
        await until(() => entry.loss, 10000, 'Memory watchdog never answered');
        assert.equal(entry.loss, 'memory', 'Production memory watchdog did not report memory');
        assert.ok(monitor.samples.some(sample => sample.jobRssBytes > thresholds.rssBytes), 'No sampled native job RSS crossed the unchanged 512 MiB limit');
      }
      enterStage('worker-close');
      entry.closeAt = performance.now(); entry.closeWallAt = Date.now();
      if (mode === 'abort') { entry.abortAt = entry.closeAt; diagnostics.sync('production.abort.dispatch', () => entry.controller.abort()); }
      await deadline(diagnostics.sync('production.close.dispatch', () => worker.close()), 2000, 'Production close did not settle');
      entry.closeMs = performance.now() - (mode === 'memory' ? entry.lossAt : entry.closeAt);
      assert.ok(entry.closeMs <= thresholds.closeMs, 'Production cleanup exceeded 250 milliseconds');
      if (mode === 'abort') assert.equal(entry.loss, 'cancelled', 'Abort did not report cancelled');
      if (mode !== 'abort' && mode !== 'memory') assert.equal(entry.loss, undefined, 'Unexpected worker loss');
      enterStage('after-close-verification');
      await verifyClosed(entry, mode === 'memory' ? entry.lossAt : entry.closeAt, mode === 'memory' ? entry.lossWallAt : entry.closeWallAt);
    }
    // Independent verification shares the original close deadline; this only allows event delivery.
    await Promise.resolve();
    validateMonitor(entry);
    entry.unrelatedAfterClose = await inspect({ op: 'snapshot', key: unrelatedKey });
    assert.equal(entry.unrelatedAfterClose.exited, false, 'Unrelated sentinel was terminated');
    entry.passed = true;
  } catch (error) { entry.error = textError(error); }
  finally {
    enterStage('case-cleanup');
    entry.cleanupCloseWindow = originalCloseWindow(entry, Date.now(), thresholds.closeMs);
    if (worker) {
      try { await deadline(worker.close(), 2000, 'Failure-path close did not settle'); }
      catch (error) { entry.failureCloseError = textError(error); entry.passed = false; }
    }
    // A failed gate stays failed. Emergency cleanup never repairs the reported result.
    for (const key of [...entry.keys].reverse()) {
      try {
        const before = await inspect({ op: 'snapshot', key, exitDeadline: entry.cleanupCloseWindow.exitDeadline });
        if (!before.exited) { entry.passed = false; entry.cleanup.push({ key, before, after: await inspect({ op: 'kill', key }) }); }
      } catch (error) { entry.cleanup.push({ key, error: textError(error) }); entry.passed = false; }
    }
    for (const monitor of entry.monitors) {
      if (!exited(monitor.child)) {
        // ChildProcess retains the helper's Windows process handle. Job close kills members.
        entry.passed = false;
        try { monitor.child.kill('SIGKILL'); } catch (error) { entry.cleanup.push({ monitor: monitor.pid, error: textError(error) }); }
        try { await deadline(monitor.exit, 5000, 'Private monitor emergency exit unconfirmed'); }
        catch (error) { entry.cleanup.push({ monitor: monitor.pid, error: textError(error) }); }
      }
    }
    active = undefined;
  }
}

try {
  enterStage('production-import');
  const production = await import(pathToFileURL(cli.worker).href);
  assert.equal(typeof production.createInstalledShellWorker, 'function', 'Bundle must export the production worker factory');
  assert.equal(typeof production.shellWorkerEnvironment, 'function', 'Bundle must export the production environment helper');
  assert.equal(production.SHELL_WORKER_LIMITS.startupMs, thresholds.startupMs);
  assert.equal(production.SHELL_WORKER_LIMITS.requestMs, thresholds.requestMs);
  assert.equal(production.SHELL_WORKER_LIMITS.rssBytes, thresholds.rssBytes);
  assert.equal(production.SHELL_WORKER_LIMITS.monitorRssBytes, thresholds.monitorRssBytes);
  assert.equal(production.SHELL_WORKER_LIMITS.sampleMs, thresholds.pollMs);
  evidence.productionLimits = production.SHELL_WORKER_LIMITS;
  evidence.memoryAccounting = { scope: 'per-window-restoration-worker', sharedTraceHandles: 4, expectedMonitorsPerWorker: 1, jobLimitBytes: thresholds.rssBytes, monitorLimitBytes: thresholds.monitorRssBytes, combinedLimitBytes: thresholds.totalRssBytes, definition: 'One private monitor per installed restoration worker. That worker serves up to four trace handles in one window. Separate windows have separate workers and monitors; this is not a global application singleton.' };
  evidence.synchronousWorkReview = {
    recorded: ['Native spawn entry through return', 'JSON parsing and serialization durations without contents', 'Monitor stdout synchronous listener handling', 'Driver line handling', 'Synchronous production startup, request, abort and close dispatch', 'Async-hook callback execution by resource kind, including promise continuations and native callbacks, with bounded significant-duration records', 'Main-thread CPU deltas when process.threadCpuUsage is available', 'GC and event-loop-delay observations when supported'],
    removed: 'Executable hashing runs in the isolated runtime probe rather than synchronous updates on the parent thread.',
    unresolved: 'Async callback wall intervals include their synchronous work and can overlap the explicit spans. The diagnostic report unions these ranges and records omissions. Wall time without measured main-thread CPU does not identify waiting, descheduling or another operating-system cause. Async waits before callback execution and unrecorded work remain unattributed. Overlap is correlation and cannot prove the cause of a heartbeat gap.',
  };
  enterStage('preflight-files');
  runtimeProbe = await diagnostics.sync('gate.runtime-probe.start', () => createGateRuntimeProbe([cli.worker, cli.omp]));
  evidence.workerSha256 = await runtimeProbe.hash(0); evidence.ompSha256 = await runtimeProbe.hash(1);
  evidence.traceText = await readFile(cli.trace, 'utf8'); JSON.parse(evidence.traceText);
  evidence.traceSha256 = diagnostics.sync('preflight.trace.sha256', () => createHash('sha256').update(evidence.traceText).digest('hex'), { inputChars: evidence.traceText.length });
  assert.ok((await stat(cli.omp)).isFile(), 'Missing native omp executable');
  const isolated = join(cli.output, 'observer-profile');
  await Promise.all(['home', 'agent', 'config', 'cache', 'data', 'state', 'runtime', 'tmp', 'work'].map(name => mkdir(join(isolated, name), { recursive: true })));
  safeEnv = production.shellWorkerEnvironment(process.env, isolated);
  enterStage('preflight-native-version');
  evidence.nativePreflight = { expectedVersion: cli['expected-version'], ompPe: await peArchitecture(cli.omp), nodePe: await peArchitecture(process.execPath), isolatedEnvironment: true };
  const version = await runtimeProbe.version({ env: safeEnv, cwd: join(isolated, 'work') });
  evidence.nativePreflight.version = { stdout: version.stdout.trim(), stderr: version.stderr.trim(), error: version.error ? textError(version.error) : undefined };
  if (version.error) throw version.error;
  const versions = version.stdout.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g) ?? [];
  assert.ok(versions.includes(cli['expected-version']), 'Native omp version differs from the expected release');
  enterStage('fixture-compilation');
  const launcher = join(cli.output, 'launcher.exe');
  await new Promise((resolveCompile, reject) => diagnostics.sync('child_process.execFile', () => originalExecFile(powershell, [...psArgs(inspectorScript), 'compile', fixtureSource, launcher], { env: safeEnv, cwd: join(isolated, 'work'), windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    evidence.fixtureCompilation = { stdout, stderr, error: error ? textError(error) : undefined };
    if (error) reject(error); else resolveCompile();
  }), { origin: 'gate.fixture-compilation' }));
  enterStage('inspector-startup');
  observer = spawnObserved(powershell, [...psArgs(inspectorScript), 'inspect', fixtureSource], { env: safeEnv, cwd: join(isolated, 'work'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }, 'gate.inspector');
  observer.on('error', error => { for (const item of inspectorPending.values()) item.reject(error); });
  observer.on('exit', () => { for (const item of inspectorPending.values()) item.reject(new Error('Independent inspector exited')); });
  const observerReady = new Promise((resolveReady, reject) => {
    lines(observer.stdout, line => {
      const value = JSON.parse(line);
      if (value.event === 'ready') { evidence.inspectorReady = value; assert.equal(value.verifierPolicySelfTest?.passed, true, 'Independent inspector recovery-policy self-test did not pass'); resolveReady(); return; }
      const pending = inspectorPending.get(value.id);
      if (!pending) throw new Error('Unexpected independent inspector response');
      evidence.inspector.push(value);
      if (value.error) pending.reject(new Error(value.error)); else pending.resolve(value.value);
    }, error => {
      evidence.inspectorProtocolError = textError(error);
      for (const item of inspectorPending.values()) item.reject(error);
      reject(error);
    });
    observer.stderr.setEncoding('utf8'); observer.stderr.on('data', chunk => { evidence.inspectorStderr = (evidence.inspectorStderr ?? '') + chunk; });
    observer.once('error', reject); observer.once('exit', () => reject(new Error('Inspector exited before readiness')));
  });
  await deadline(observerReady, 30000, 'Independent inspector startup timed out');
  enterStage('unrelated-sentinel-startup');
  const sentinelDirectory = join(cli.output, 'unrelated'); await mkdir(sentinelDirectory);
  const unrelatedSource = join(sentinelDirectory, 'sentinel.mjs'); await copyFile(sentinelSource, unrelatedSource);
  const sentinelEntry = { name: 'unrelated', wallAt: Date.now(), keys: [] };
  unrelated = spawnObserved(process.execPath, [unrelatedSource, 'unrelated', sentinelDirectory], { env: safeEnv, cwd: join(isolated, 'work'), windowsHide: true, stdio: 'ignore' }, 'gate.unrelated-sentinel');
  unrelated.on('error', error => { evidence.unrelatedError = textError(error); });
  const unrelatedLedger = await until(async () => { try { return JSON.parse(await readFile(join(sentinelDirectory, 'unrelated.json'), 'utf8')); } catch { return undefined; } }, 5000, 'Unrelated sentinel never started');
  evidence.unrelated = await pin(sentinelEntry, { pid: unrelated.pid, image: process.execPath, marker: unrelatedSource }, unrelatedLedger.creationUpperMs);
  unrelatedKey = sentinelEntry.keys[0];
  for (const [name, mode] of [['direct-native-close', 'direct'], ['descendant-tree-close', 'tree'], ['descendant-tree-abort', 'abort'], ['descendant-memory-watchdog', 'memory'], ['startup-cancellation', 'startup-cancel']]) {
    const directory = join(cli.output, name); await mkdir(directory);
    const executable = mode === 'direct' ? cli.omp : join(directory, 'launcher.exe');
    if (mode !== 'direct') {
      await copyFile(launcher, executable); await copyFile(sentinelSource, join(directory, 'sentinel.mjs'));
      await writeFile(join(directory, 'launcher.json'), JSON.stringify({ node: process.execPath, omp: cli.omp, sentinel: join(directory, 'sentinel.mjs') }));
    }
    await exercise(name, executable, mode, directory, production.createInstalledShellWorker);
  }
  await sleep(40);
  assert.equal(evidence.forbiddenProcesses.length, 0, 'Production launched a forbidden sampler or taskkill process');
  evidence.passed = evidence.cases.length === 5 && evidence.cases.every(entry => entry.passed);
} catch (error) { evidence.error = textError(error); evidence.passed = false; }
finally {
  enterStage('final-cleanup');
  evidence.maxConcurrentSamples = Math.max(0, ...evidence.cases.flatMap(entry => entry.monitors.map(monitor => monitor.maxConcurrentSamples)));
  evidence.sampleCount = evidence.cases.reduce((sum, entry) => sum + entry.monitors.reduce((count, monitor) => count + monitor.samples.filter(sample => sample.at !== undefined).length, 0), 0);
  if (unrelatedKey) {
    try {
      evidence.unrelatedFinal = await inspect({ op: 'snapshot', key: unrelatedKey });
      if (evidence.unrelatedFinal.exited) evidence.passed = false;
      evidence.unrelatedCleanup = await inspect({ op: 'kill', key: unrelatedKey });
    } catch (error) { evidence.unrelatedCleanupError = textError(error); evidence.passed = false; }
  } else if (unrelated && !exited(unrelated)) {
    unrelated.kill('SIGKILL');
    try { await deadline(exitPromise(unrelated), 5000, 'Unrelated sentinel retained-handle cleanup timed out'); }
    catch (error) { evidence.unrelatedCleanupError = textError(error); evidence.passed = false; }
  }
  if (observer && !exited(observer)) {
    observer.stdin.end();
    try { await deadline(exitPromise(observer), 5000, 'Inspector did not release retained handles'); }
    catch (error) { evidence.inspectorCleanupError = textError(error); evidence.passed = false; observer.kill('SIGKILL'); }
  }
  if (runtimeProbe) {
    try { evidence.runtimeProbe = await runtimeProbe.stop(); }
    catch (error) { evidence.runtimeProbeError = textError(error); evidence.passed = false; }
  }
  cp.spawn = originalSpawn; cp.execFile = originalExecFile; syncBuiltinESMExports();
  JSON.parse = originalJsonParse; JSON.stringify = originalJsonStringify;
  evidence.heartbeat = diagnostics.stop();
  evidence.heartbeatMaxDelayMs = evidence.heartbeat.maxDelayMs;
  evidence.heartbeatMaxIntervalMs = evidence.heartbeat.maxIntervalMs;
  evidence.heartbeatTicks = evidence.heartbeat.ticks;
  if (!evidence.heartbeatTicks || evidence.heartbeatMaxDelayMs > thresholds.heartbeatMs) {
    evidence.passed = false;
    evidence.heartbeatError = 'Parent heartbeat delay exceeded 100 milliseconds';
  }
  // Keep evidence and failed production scratch roots for diagnosis. Do not remove barriers.
  delete evidence.traceText;
  await writeFile(join(cli.output, 'evidence.json'), JSON.stringify(evidence, (key, value) => ['child', 'exit', 'controller', 'pending'].includes(key) ? undefined : value, 2));
  const samplerCost = {
    platform: evidence.platform, arch: evidence.arch, node: evidence.node, passed: evidence.passed,
    nativePreflight: evidence.nativePreflight, memoryAccounting: evidence.memoryAccounting,
    observedMonitorsPerWorker: evidence.cases.map(entry => ({ case: entry.name, monitors: entry.monitors.length })),
    heartbeat: { file: 'evidence.json', key: 'heartbeat', maxDelayMs: evidence.heartbeatMaxDelayMs, maxIntervalMs: evidence.heartbeatMaxIntervalMs, ticks: evidence.heartbeatTicks, error: evidence.heartbeatError },
    cpuDeltaDefinition: 'Last completed sample cpuMs minus first completed sample cpuMs. This steady-state delta excludes bootstrap and all CPU accrued before the first completed sample.',
    memoryDefinition: 'rssBytes remains the full sampled job-member WorkingSetSize sum plus helperRssBytes. jobRssBytes is rssBytes minus helperRssBytes and is checked against 512 MiB. The independent monitor cap is 160 MiB, for a combined 672 MiB per window restoration worker shared by up to four trace handles. Shared pages stay charged in each process. Coincident peaks retain both components from the same sample; separate component maxima must not be added as an observed peak.',
    monitors: evidence.cases.flatMap((entry, caseIndex) => entry.monitors.map((monitor, monitorIndex) => {
      const samples = monitor.samples.filter(sample => sample.at !== undefined);
      const first = samples[0]; const last = samples.at(-1);
      const peakSample = field => samples.reduce((peak, sample) => !peak || sample[field] > peak[field] ? sample : peak, undefined);
      const coincident = sample => sample ? { id: sample.id, at: sample.at, jobRssBytes: sample.jobRssBytes, helperRssBytes: sample.helperRssBytes, totalRssBytes: sample.rssBytes } : null;
      const memberPeaks = new Map();
      for (const sample of samples) {
        if (!sample.memberRssBytes) continue;
        for (let index = 0; index < sample.pids.length; index++) {
          const pid = sample.pids[index];
          memberPeaks.set(pid, Math.max(memberPeaks.get(pid) ?? 0, sample.memberRssBytes[index]));
        }
      }
      return {
        case: entry.name, pid: monitor.pid, passed: entry.passed,
        topology: entry.topology ?? (entry.identities ?? []).filter(row => row.pid === monitor.targetPid).map(row => ({ role: 'omp', pid: row.pid, parentPid: row.parentPid })),
        helperStartupWallMs: monitor.readyAt === undefined ? null : monitor.readyAt - monitor.at,
        workerStartupWallMs: entry.startupMs ?? null, closeWallMs: entry.closeMs ?? null,
        completeIndependentCloseWallMs: entry.independentCloseMs ?? null, exitDeadline: entry.exitDeadline ?? null,
        parentSpawnSyncMs: monitor.spawnReturnedAt - monitor.at,
        stopAcknowledgementWallMs: monitor.stoppedAt === undefined ? null : monitor.stoppedAt - monitor.stopAt,
        helperExitAfterAcknowledgementWallMs: monitor.stoppedAt === undefined || monitor.exitAt === undefined ? null : monitor.exitAt - monitor.stoppedAt,
        maxConcurrentSamples: monitor.maxConcurrentSamples,
        samples: samples.map(sample => ({ id: sample.id, requestedAt: sample.requestedAt, completedAt: sample.at, rttMs: sample.rttMs, cpuMs: sample.cpuMs, rssBytes: sample.rssBytes, jobRssBytes: sample.jobRssBytes, pids: sample.pids, helperRssBytes: sample.helperRssBytes, memberRssBytes: sample.memberRssBytes, breakdownOmitted: sample.breakdownOmitted })),
        peakRssBytes: samples.length ? Math.max(...samples.map(sample => sample.rssBytes)) : null,
        peakHelperRssBytes: samples.length ? Math.max(...samples.map(sample => sample.helperRssBytes)) : null,
        peakJobRssBytes: samples.length ? peakSample('jobRssBytes').jobRssBytes : null,
        coincidentPeaks: { atJobPeak: coincident(peakSample('jobRssBytes')), atHelperPeak: coincident(peakSample('helperRssBytes')), atTotalPeak: coincident(peakSample('rssBytes')) },
        memberPeaks: [...memberPeaks].map(([pid, peakRssBytes]) => ({ pid, role: entry.topology?.find(row => row.pid === pid)?.role ?? (pid === monitor.targetPid && entry.mode === 'direct' ? 'omp' : 'job-member'), peakRssBytes })),
        breakdownOmittedCount: samples.filter(sample => sample.breakdownOmitted === true).length,
        failedSamples: monitor.samples.filter(sample => sample.errorAt !== undefined),
        errors: monitor.events.filter(event => event.event === 'error'),
        cancelledSamples: monitor.samples.filter(sample => sample.cancelledAt !== undefined),
        steadyStateCpuDeltaMs: samples.length < 2 ? null : last.cpuMs - first.cpuMs,
        steadyStateWallMs: samples.length < 2 ? null : last.at - first.at,
        rawEvents: { file: 'evidence.json', caseIndex, monitorIndex },
      };
    })),
  };
  await writeFile(join(cli.output, 'sampler-cost.json'), JSON.stringify(samplerCost, null, 2));
  console.log(JSON.stringify({ passed: evidence.passed, evidence: join(cli.output, 'evidence.json'), error: evidence.error, heartbeatMaxDelayMs: evidence.heartbeatMaxDelayMs, cases: evidence.cases.map(entry => ({ name: entry.name, passed: entry.passed, error: entry.error, startupMs: entry.startupMs, closeMs: entry.closeMs, loss: entry.loss })) }, null, 2));
  process.exitCode = evidence.passed ? 0 : 1;
}
