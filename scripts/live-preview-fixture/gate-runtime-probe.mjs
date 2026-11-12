import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';

const FILE_BYTES = 512 * 1024 * 1024;
const RECORDS = 512;
const INTERVAL_MS = 20;
const REQUEST_MS = 15000;
const VERSION_BYTES = 64 * 1024;
const now = () => performance.timeOrigin + performance.now();
const validVersionOptions = options => options && Object.keys(options).every(key => key === 'env' || key === 'cwd')
  && typeof options.cwd === 'string' && options.cwd.length > 0
  && options.env && typeof options.env === 'object' && !Array.isArray(options.env)
  && Object.values(options.env).every(value => typeof value === 'string');
const serializeError = error => error ? Object.fromEntries(['name', 'message', 'code', 'signal', 'killed', 'errno', 'syscall']
  .filter(key => error[key] !== undefined).map(key => [key, typeof error[key] === 'string' ? error[key].slice(0, VERSION_BYTES * 2) : error[key]])) : undefined;
let cpuSupported = typeof process.threadCpuUsage === 'function';
const cpuTime = () => {
  if (!cpuSupported) return undefined;
  try {
    const value = process.threadCpuUsage();
    if (!Number.isFinite(value.user) || !Number.isFinite(value.system)) throw new Error('Invalid thread CPU counters');
    return value;
  } catch { cpuSupported = false; return undefined; }
};
const cpuDelta = (before, after) => before && after ? Math.max(0, after.user + after.system - before.user - before.system) / 1000 : null;

// This fixture-only thread hashes preflight files, runs their fixed version command and observes timers.
// Its idle startup intervals can be compared with the parent; concurrent delay is not causal proof.
export async function createGateRuntimeProbe(files) {
  if (!isMainThread || !Array.isArray(files) || files.length !== 2 || files.some(file => typeof file !== 'string')) throw new Error('Invalid gate probe files');
  const worker = new Worker(new URL(import.meta.url), { workerData: { files }, env: {}, execArgv: [], stdout: true, stderr: true });
  const pending = new Map();
  const requestedFiles = new Set();
  let sequence = 0;
  let stopped;
  let cleanup;
  let closing = false;
  let finished = false;
  let cleanupConfirmed = false;
  let failure;
  let versionRequested = false;
  let stopResolve;
  let stopReject;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const startup = setTimeout(() => readyReject(new Error('Gate runtime probe startup timed out')), 5000);
  const rejectPending = error => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  const stop = reason => {
    if (stopped) return stopped;
    closing = true;
    failure ??= reason;
    cleanup = (async () => {
      try {
        // The acknowledgment is sent only after the owned child has emitted close.
        const value = await new Promise((resolve, reject) => {
          stopResolve = resolve; stopReject = reject;
          if (finished) reject(new Error('Gate runtime probe exited before cleanup confirmation'));
          else worker.postMessage({ op: 'stop' });
        });
        const code = await worker.terminate();
        return { ...value, terminationExitCode: code, threadStopped: true };
      } finally { rejectPending(failure ?? new Error('Gate runtime probe is closed')); }
    })();
    // This bound reports failed cleanup. Ownership and the cleanup barrier remain alive.
    stopped = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = Object.assign(new Error('Gate runtime probe cleanup confirmation timed out'), { cleanupPending: true });
        rejectPending(error);
        reject(error);
      }, 1000);
      cleanup.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
    return stopped;
  };
  const fail = error => {
    readyReject(error);
    failure ??= error;
    rejectPending(error);
    if (finished) stopReject?.(error);
    else void stop(error).catch(() => {});
  };
  worker.on('error', error => { finished = true; fail(error); });
  worker.on('exit', () => {
    finished = true;
    if (!cleanupConfirmed) fail(new Error('Gate runtime probe exited before confirmation'));
  });
  for (const stream of [worker.stdout, worker.stderr]) stream.on('data', () => fail(new Error('Gate runtime probe emitted unexpected output')));
  worker.on('message', message => {
    if (message?.event === 'ready') { clearTimeout(startup); readyResolve(); return; }
    if (message?.event === 'stopped') { cleanupConfirmed = true; stopResolve?.(message.value); return; }
    if (message?.event === 'fatal') { fail(new Error('Gate runtime probe failed')); return; }
    const request = pending.get(message?.id);
    if (!request) { if (!closing) fail(new Error('Unexpected gate runtime probe response')); return; }
    if (failure) return;
    if (now() >= request.deadline) { fail(new Error('Gate runtime probe request timed out')); return; }
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error)); else request.resolve(message.value);
  });
  const request = (op, payload) => new Promise((resolve, reject) => {
    if (finished || closing) { reject(new Error('Gate runtime probe is closed')); return; }
    const id = ++sequence;
    const deadline = now() + REQUEST_MS;
    const timer = setTimeout(() => fail(new Error('Gate runtime probe request timed out')), REQUEST_MS);
    pending.set(id, { resolve, reject, timer, deadline });
    worker.postMessage({ id, op, ...payload, deadline });
  });
  try { await ready; }
  catch (error) {
    clearTimeout(startup);
    if (stopped) await stopped.catch(() => {});
    else await worker.terminate(); // No request or child exists before ready.
    throw error;
  }
  return {
    hash(index) {
      if (closing || !Number.isInteger(index) || index < 0 || index >= files.length || requestedFiles.has(index)) return Promise.reject(new Error('Invalid gate runtime probe hash request'));
      requestedFiles.add(index);
      return request('hash', { index });
    },
    async version(options) {
      if (closing || versionRequested || !validVersionOptions(options)) throw new Error('Invalid gate runtime probe version request');
      versionRequested = true;
      const value = await request('version', { options });
      if (value.error) value.error = Object.assign(new Error(value.error.message), value.error);
      return value;
    },
    stop() { return stop(); },
    cleanup() { void stop().catch(() => {}); return cleanup; },
  };
}

if (!isMainThread) {
  const gaps = [];
  const peakGaps = [];
  const hashes = [];
  let droppedGaps = 0;
  let ticks = 0;
  let maximumDelayMs = 0;
  let previous = performance.now();
  let previousCpu = cpuTime();
  let activeHash;
  let busy = false;
  let closing = false;
  let activeRead;
  let versionChild;
  let childClosed;
  let versionFinished;
  let versionRecord;
  let stopStarted = false;
  const startedAt = previous;
  const timer = setInterval(() => {
    const end = performance.now();
    const cpu = cpuTime();
    const intervalMs = end - previous;
    const delayMs = Math.max(0, intervalMs - INTERVAL_MS);
    ticks++;
    maximumDelayMs = Math.max(maximumDelayMs, delayMs);
    if (delayMs >= 5) {
      const gap = { start: previous, end, intervalMs, delayMs, threadCpuMs: cpuDelta(previousCpu, cpu), activeHash: activeHash ?? null };
      if (gaps.length < RECORDS) gaps.push(gap);
      else droppedGaps++;
      peakGaps.push(gap);
      peakGaps.sort((left, right) => right.delayMs - left.delayMs);
      if (peakGaps.length > 8) peakGaps.pop();
    }
    previous = end; previousCpu = cpu;
  }, INTERVAL_MS);
  const closeChild = async () => {
    const child = versionChild;
    if (!child) return;
    child.kill('SIGKILL');
    await childClosed;
    await versionFinished;
  };
  const shutdown = async () => {
    if (stopStarted) return;
    stopStarted = true; closing = true;
    activeRead?.destroy(new Error('Gate runtime probe stopped'));
    await closeChild();
    clearInterval(timer);
    const retainedGaps = [...new Map([...gaps, ...peakGaps].map(gap => [gap.start, gap])).values()].sort((left, right) => left.start - right.start);
    parentPort.postMessage({ event: 'stopped', value: {
      timeOrigin: performance.timeOrigin, startedAt, stoppedAt: performance.now(), intervalMs: INTERVAL_MS,
      ticks, maximumDelayMs, threadCpuSupported: cpuSupported, gaps: retainedGaps, droppedGaps,
      recordLimit: RECORDS + 8, gapRetention: 'First 512 significant intervals plus the eight worst intervals; droppedGaps counts intervals beyond the initial set, some of which the peak set preserves.',
      hashes, hashExecutionThread: 'worker', inheritedEnvironmentKeys: Object.keys(process.env).length,
      inheritedExecArgv: process.execArgv, version: versionRecord,
      definition: 'Independent fixture thread. Hashing and fixed native version preflight run here. Idle-thread delays can be compared with parent intervals using timeOrigin; concurrent delays alone do not identify their cause.',
    } });
  };
  const fatal = () => {
    parentPort.postMessage({ event: 'fatal' });
    void shutdown();
  };
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  const runVersion = async message => {
    if (!validVersionOptions(message.options) || versionRecord) throw new Error('Invalid gate runtime probe version request');
    const remaining = message.deadline - now();
    if (remaining <= 0) throw new Error('Gate runtime probe request timed out');
    versionRecord = { start: performance.now(), executionThread: 'worker', timeoutMs: REQUEST_MS, maxBuffer: VERSION_BYTES, windowsHide: true, environmentKeys: Object.keys(message.options.env).length, childClosed: false, timedOut: false };
    let resultResolve;
    versionFinished = new Promise(resolve => { resultResolve = resolve; });
    let deadlineTimer;
    try {
      const result = new Promise(resolve => {
        versionChild = execFile(workerData.files[1], ['--version'], {
          env: message.options.env, cwd: message.options.cwd, windowsHide: true,
          timeout: REQUEST_MS, maxBuffer: VERSION_BYTES, killSignal: 'SIGKILL',
        }, (error, stdout, stderr) => resolve({ stdout, stderr, error: serializeError(error) }));
        childClosed = new Promise(resolve => versionChild.once('close', () => {
          versionRecord.childClosed = true;
          resolve();
        }));
        // Dispatch and native spawn consume the original request deadline.
        deadlineTimer = setTimeout(() => {
          versionRecord.timedOut = true;
          versionChild?.kill('SIGKILL');
        }, Math.max(0, message.deadline - now()));
      });
      const value = await result;
      await childClosed;
      parentPort.postMessage({ id: message.id, value });
    } finally {
      clearTimeout(deadlineTimer);
      versionRecord.end = performance.now();
      versionChild = undefined;
      resultResolve();
    }
  };
  parentPort.on('message', async message => {
    if (message.op === 'stop') { await shutdown(); return; }
    if (closing || busy || !Number.isFinite(message.deadline) || !['hash', 'version'].includes(message.op)) { parentPort.postMessage({ id: message.id, error: 'Invalid or concurrent gate probe request' }); return; }
    busy = true;
    try {
      if (message.op === 'version') { await runVersion(message); return; }
      if (!Number.isInteger(message.index) || !workerData.files[message.index]) throw new Error('Invalid gate runtime probe hash request');
      activeHash = message.index;
      const start = performance.now(); const before = cpuTime();
      const path = workerData.files[message.index];
      const file = await stat(path);
      if (!file.isFile() || file.size > FILE_BYTES) throw new Error('Preflight file exceeds the probe limit');
      const hash = createHash('sha256');
      let bytes = 0;
      activeRead = createReadStream(path, { highWaterMark: 64 * 1024 });
      for await (const chunk of activeRead) {
        bytes += chunk.length;
        if (bytes > FILE_BYTES) throw new Error('Preflight file exceeds the probe limit');
        hash.update(chunk);
      }
      hashes.push({ index: message.index, start, end: performance.now(), bytes, threadCpuMs: cpuDelta(before, cpuTime()) });
      parentPort.postMessage({ id: message.id, value: hash.digest('hex') });
    } catch (error) { parentPort.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) }); }
    finally { activeHash = undefined; activeRead = undefined; busy = false; }
  });
  parentPort.postMessage({ event: 'ready' });
}
