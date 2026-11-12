import { createHook } from 'node:async_hooks';
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';

const defaultLimits = Object.freeze({ syncSpans: 2048, callbacks: 512, gaps: 512, gc: 256, resources: 8192, callbackDepth: 64, worstGaps: 8, spansPerWorstGap: 64 });
function boundedRecords(capacity) {
  const entries = [];
  let next = 0;
  let omitted = 0;
  return {
    add(entry) {
      if (entries.length < capacity) entries.push(entry);
      else { entries[next] = entry; next = (next + 1) % capacity; omitted++; }
    },
    values() { return next ? [...entries.slice(next), ...entries.slice(0, next)] : entries.slice(); },
    get omitted() { return omitted; },
  };
}
function overlapMs(span, gap) {
  return Math.max(0, Math.min(span.end ?? gap.end, gap.end) - Math.max(span.start, gap.start));
}

// Hooks retain ids and resource kinds only. They never inspect or retain an AsyncResource.
// All hook storage and per-callback work are bounded; short callbacks contribute counts only.
export function createHeartbeatDiagnostics({
  intervalMs = 20, thresholdMs = 100, now = () => performance.now(), context = () => ({}),
  runtime = true, timers = true, asyncHooks = runtime, hookFactory = createHook,
  threadCpuUsage = typeof process.threadCpuUsage === 'function' ? () => process.threadCpuUsage() : null,
  significantCallbackMs = 5, limits: requestedLimits = {},
} = {}) {
  const limits = { ...defaultLimits, ...requestedLimits };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Diagnostic limits must be positive safe integers');
  if (!Number.isFinite(significantCallbackMs) || significantCallbackMs < 0) throw new RangeError('Callback duration threshold must be nonnegative');
  const syncRecords = boundedRecords(limits.syncSpans);
  const callbackRecords = boundedRecords(limits.callbacks);
  const gapRecords = boundedRecords(limits.gaps);
  const gcRecords = boundedRecords(limits.gc);
  const worstGaps = [];
  function preserveOverlap(saved, kind, span) {
    if (overlapMs(span, saved.gap) <= 0 || saved[kind].includes(span)) return;
    const records = saved[kind];
    if (records.length < limits.spansPerWorstGap) { records.push(span); return; }
    saved.omitted[kind]++;
    let smallest = 0;
    for (let index = 1; index < records.length; index++) if (overlapMs(records[index], saved.gap) < overlapMs(records[smallest], saved.gap)) smallest = index;
    if (overlapMs(span, saved.gap) > overlapMs(records[smallest], saved.gap)) records[smallest] = span;
  }
  function preserveForWorstGaps(kind, span) {
    for (const saved of worstGaps) preserveOverlap(saved, kind, span);
  }
  function preserveWorstGap(gap) {
    if (!gap.exceeded) return;
    if (worstGaps.length === limits.worstGaps && gap.delayMs <= worstGaps[worstGaps.length - 1].gap.delayMs) return;
    const saved = { gap, syncSpans: [], callbacks: [], gc: [], omitted: { syncSpans: 0, callbacks: 0, gc: 0 } };
    worstGaps.push(saved);
    worstGaps.sort((left, right) => right.gap.delayMs - left.gap.delayMs);
    if (worstGaps.length > limits.worstGaps) worstGaps.pop();
    for (const span of syncRecords.values()) preserveOverlap(saved, 'syncSpans', span);
    for (const span of callbackRecords.values()) preserveOverlap(saved, 'callbacks', span);
    for (const span of gcRecords.values()) preserveOverlap(saved, 'gc', span);
  }
  const resources = new Map();
  // Reuse frames instead of allocating callback records before duration is known.
  const frames = Array.from({ length: limits.callbackDepth }, () => ({}));
  const callbackCounts = { started: 0, completed: 0, significant: 0, belowThreshold: 0, unknownResourceKind: 0, depthOmitted: 0, unmatchedAfter: 0, incomplete: 0 };
  let resourceEvictions = 0;
  let depth = 0;
  let skippedDepth = 0;
  let nextSyncId = 0;
  let nextCallbackId = 0;
  let threadCpuUnavailableReason = threadCpuUsage ? null : 'process.threadCpuUsage is unavailable in this runtime; process-wide CPU is not a main-thread substitute.';
  const support = { gc: false, eventLoopDelay: false, asyncHooks: false, threadCpuUsage: Boolean(threadCpuUsage) };
  function cpuNow() {
    if (!support.threadCpuUsage) return null;
    try {
      const usage = threadCpuUsage();
      if (!Number.isFinite(usage.user) || !Number.isFinite(usage.system)) throw new Error('Invalid thread CPU counters');
      return (usage.user + usage.system) / 1000;
    } catch {
      support.threadCpuUsage = false;
      threadCpuUnavailableReason = 'process.threadCpuUsage could not provide usable counters; its failure does not identify an operating-system cause.';
      return null;
    }
  }
  const cpuDelta = (start, end) => start === null || end === null ? null : Math.max(0, end - start);
  const startedAt = now();
  const startedCpu = cpuNow();
  let previousBeat = startedAt;
  let previousBeatCpu = startedCpu;
  let stoppedCpu;
  let ticks = 0;
  let maxDelayMs = 0;
  let maxIntervalMs = 0;
  let exceededIntervals = 0;
  let stoppedAt;
  let observer;
  let histogram;
  let hook;
  function finishCallback(frame, end, endCpu, incomplete = false) {
    const durationMs = end - frame.start;
    if (incomplete) callbackCounts.incomplete++;
    else callbackCounts.completed++;
    if (durationMs < significantCallbackMs) { callbackCounts.belowThreshold++; return; }
    callbackCounts.significant++;
    const span = {
      id: ++nextCallbackId, asyncId: frame.asyncId, resourceKind: frame.resourceKind,
      start: frame.start, end, durationMs, mainThreadCpuMs: cpuDelta(frame.cpu, endCpu),
      stage: frame.stage, case: frame.case, ...(incomplete ? { incomplete: true } : {}),
    };
    callbackRecords.add(span);
    preserveForWorstGaps('callbacks', span);
  }
  if (asyncHooks) {
    try {
      hook = hookFactory({
        init(asyncId, type) {
          if (resources.size >= limits.resources) { resources.delete(resources.keys().next().value); resourceEvictions++; }
          resources.set(asyncId, type.slice(0, 80));
        },
        before(asyncId) {
          callbackCounts.started++;
          if (depth === limits.callbackDepth || skippedDepth) { skippedDepth++; callbackCounts.depthOmitted++; return; }
          const frame = frames[depth++];
          frame.start = now(); frame.cpu = cpuNow(); frame.asyncId = asyncId;
          frame.resourceKind = resources.get(asyncId) ?? 'unknown';
          if (frame.resourceKind === 'unknown') callbackCounts.unknownResourceKind++;
          const current = context();
          frame.stage = typeof current.stage === 'string' ? current.stage.slice(0, 80) : undefined;
          frame.case = typeof current.case === 'string' ? current.case.slice(0, 80) : undefined;
        },
        after(asyncId) {
          if (skippedDepth) { skippedDepth--; return; }
          if (!depth || frames[depth - 1].asyncId !== asyncId) { callbackCounts.unmatchedAfter++; return; }
          finishCallback(frames[--depth], now(), cpuNow());
        },
        destroy(asyncId) { resources.delete(asyncId); },
      });
      hook.enable(); support.asyncHooks = true;
    } catch { hook?.disable(); support.asyncHooks = false; }
  }
  const collectGc = entries => {
    for (const entry of entries) {
      const span = { start: entry.startTime, end: entry.startTime + entry.duration, durationMs: entry.duration, kind: entry.detail?.kind };
      gcRecords.add(span);
      preserveForWorstGaps('gc', span);
    }
  };
  if (runtime) {
    try {
      observer = new PerformanceObserver(list => collectGc(list.getEntries()));
      observer.observe({ entryTypes: ['gc'] });
      support.gc = true;
    } catch { support.gc = false; }
    try { histogram = monitorEventLoopDelay({ resolution: 10 }); histogram.enable(); support.eventLoopDelay = true; }
    catch { support.eventLoopDelay = false; }
  }
  function beat() {
    if (stoppedAt !== undefined) return;
    const end = now();
    const endCpu = cpuNow();
    const interval = end - previousBeat;
    const delayMs = Math.max(0, interval - intervalMs);
    const mainThreadCpuMs = cpuDelta(previousBeatCpu, endCpu);
    ticks++;
    maxDelayMs = Math.max(maxDelayMs, delayMs);
    maxIntervalMs = Math.max(maxIntervalMs, interval);
    if (delayMs > thresholdMs) exceededIntervals++;
    if (delayMs > 0) {
      const gap = {
        ...context(), start: previousBeat, end, intervalMs: interval, delayMs, exceeded: delayMs > thresholdMs,
        mainThreadCpuMs, wallMinusMainThreadCpuMs: mainThreadCpuMs === null ? null : Math.max(0, interval - mainThreadCpuMs),
      };
      gapRecords.add(gap);
      preserveWorstGap(gap);
    }
    previousBeat = end; previousBeatCpu = endCpu;
  }
  const timer = timers ? setInterval(beat, intervalMs) : undefined;
  timer?.unref(); // Diagnostic collection must not keep a failed preflight alive.
  function begin(label, metadata = {}) {
    if (stoppedAt !== undefined) return () => {};
    const span = { ...context(), ...metadata, id: ++nextSyncId, label, start: now() };
    const startCpu = cpuNow();
    syncRecords.add(span); // Capture the start before entering a potentially blocking native call.
    let ended = false;
    return (extra = {}) => {
      if (ended) return;
      ended = true;
      span.end = now(); span.durationMs = span.end - span.start;
      span.mainThreadCpuMs = cpuDelta(startCpu, cpuNow());
      Object.assign(span, extra);
      preserveForWorstGaps('syncSpans', span);
    };
  }
  function sync(label, callback, metadata) {
    const end = begin(label, metadata);
    try { const result = callback(); end(); return result; }
    catch (error) { end({ threw: true }); throw error; }
  }
  function snapshot() {
    const syncSpans = [...new Set([...syncRecords.values(), ...worstGaps.flatMap(saved => saved.syncSpans)])].sort((left, right) => left.id - right.id);
    const callbacks = [...new Set([...callbackRecords.values(), ...worstGaps.flatMap(saved => saved.callbacks)])].sort((left, right) => left.id - right.id);
    const gc = [...new Set([...gcRecords.values(), ...worstGaps.flatMap(saved => saved.gc)])].sort((left, right) => left.start - right.start);
    const retainedGaps = [...new Set([...gapRecords.values(), ...worstGaps.map(saved => saved.gap)])].sort((left, right) => left.start - right.start);
    const mainThreadCpuMs = cpuDelta(startedCpu, stoppedAt === undefined ? cpuNow() : stoppedCpu);
    return {
      intervalMs, thresholdMs, startedAt, stoppedAt, ticks, maxDelayMs, maxIntervalMs, exceededIntervals, support: { ...support },
      mainThreadCpuMs,
      threadCpuUnavailableReason,
      cpuDefinition: 'Monotonic wall intervals and cumulative main-thread CPU deltas are measured separately. CPU includes diagnostic overhead. Wall time minus thread CPU is time without measured thread CPU; it does not distinguish waiting, descheduling, runtime activity or counter resolution. No operating-system cause is inferred. Nested callback CPU is inclusive and must not be summed.',
      attributionDefinition: 'Overlaps are wall-time correlations, not CPU causality. Async hooks bracket callback execution, including promise continuations and native callbacks; they do not measure the preceding asynchronous wait. Nested ranges are unioned. Short, evicted and untracked work can remain unattributed, as can time between callbacks.',
      syncSpans, callbacks, gc, significantCallbackMs, callbackCounts: { ...callbackCounts },
      retention: {
        limits: { ...limits }, policy: 'Bounded rings retain recent entries. An independent bounded set preserves the worst exceeded gaps and their longest overlapping sync, callback and GC records. Ring eviction counts include records preserved for worst gaps. Maxima, threshold failures and callback counts cover the entire collection.',
        omittedSyncSpans: syncRecords.omitted, omittedCallbacks: callbackRecords.omitted,
        omittedGaps: gapRecords.omitted, omittedGcEntries: gcRecords.omitted,
        belowThresholdCallbacks: callbackCounts.belowThreshold, resourceEvictions, trackedResources: resources.size,
        depthOmittedCallbacks: callbackCounts.depthOmitted,
        preservedWorstGaps: worstGaps.map(saved => ({ start: saved.gap.start, end: saved.gap.end, delayMs: saved.gap.delayMs, omittedSyncSpans: saved.omitted.syncSpans, omittedCallbacks: saved.omitted.callbacks, omittedGcEntries: saved.omitted.gc })),
      },
      gaps: retainedGaps.map(gap => {
        const overlappingSync = syncSpans.filter(span => overlapMs(span, gap) > 0);
        const overlappingCallbacks = callbacks.filter(span => overlapMs(span, gap) > 0);
        const overlappingGc = gc.filter(span => overlapMs(span, gap) > 0);
        const ranges = [...overlappingSync, ...overlappingCallbacks, ...overlappingGc].map(span => [Math.max(span.start, gap.start), Math.min(span.end ?? gap.end, gap.end)]).sort((left, right) => left[0] - right[0]);
        let coveredMs = 0; let coveredUntil = gap.start;
        for (const [start, end] of ranges) { coveredMs += Math.max(0, end - Math.max(start, coveredUntil)); coveredUntil = Math.max(coveredUntil, end); }
        return {
          ...gap,
          syncOverlaps: overlappingSync.map(span => ({ id: span.id, overlapMs: overlapMs(span, gap) })),
          callbackOverlaps: overlappingCallbacks.map(span => ({ id: span.id, resourceKind: span.resourceKind, overlapMs: overlapMs(span, gap) })),
          gcOverlaps: overlappingGc.map(span => ({ start: span.start, durationMs: span.durationMs, overlapMs: overlapMs(span, gap) })),
          observedWorkMs: coveredMs, unattributedIntervalMs: Math.max(0, gap.intervalMs - coveredMs),
          attribution: ranges.length ? 'overlapping-observed-work; remainder-unattributed' : 'unattributed',
        };
      }),
      eventLoopDelay: histogram && histogram.count > 0 ? { count: histogram.count, minMs: histogram.min / 1e6, maxMs: histogram.max / 1e6, meanMs: histogram.mean / 1e6, p50Ms: histogram.percentile(50) / 1e6, p99Ms: histogram.percentile(99) / 1e6 } : null,
    };
  }
  function stop() {
    if (stoppedAt === undefined) {
      clearInterval(timer);
      if (now() - previousBeat >= intervalMs) beat();
      stoppedAt = now(); stoppedCpu = cpuNow();
      hook?.disable();
      while (depth) finishCallback(frames[--depth], stoppedAt, stoppedCpu, true);
      resources.clear();
      if (observer) { collectGc(observer.takeRecords()); observer.disconnect(); }
      histogram?.disable();
    }
    return snapshot();
  }
  return { begin, sync, beat, snapshot, stop };
}
