// Injected by the opt-in CDP harness before React loads. Never imported by the app.
(() => {
  if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) throw new Error('Disable React DevTools for a comparable speed capture.');
  const production = window.__speedProduction === true;
  const rendererEvidence = [];
  const rootModes = new Set();
  let phase;
  let previousFrame;
  const blank = label => ({ label, startedAt: performance.now(), frames: [], deliveryLagMs: [], longTasks: [], commits: 0, ...(!production ? { reactMs: 0, components: {}, notifications: 0, subscriberCounts: [] } : {}), updates: 0, frameKinds: {}, probeMs: 0, functionCosts: {} });
  phase = blank('bootstrap');
  const component = name => phase.components[name] ||= { renders: 0, commits: 0, actualMs: 0, mountMs: 0, maxCommitMs: 0 };
  window.__vompSpeed = {
    reset(label) { phase = blank(label); previousFrame = undefined; },
    read() { return { ...phase, wallMs: performance.now() - phase.startedAt, visibility: document.visibilityState }; },
    reactEvidence() { return { renderers: rendererEvidence, rootModes: [...rootModes], strictMode: [...rootModes].some(mode => (mode & 24) !== 0), componentDurations: production ? 'unavailable: ordinary production React, no Profiler transform' : 'development Profiler', subscriberInstrumentation: !production }; },
    render(name) { component(name).renders++; },
    delivery(lagMs) { phase.deliveryLagMs.push(lagMs); },
    profile(name, kind, ms) { const before = performance.now(); const item = component(name); item.commits++; item.actualMs += ms; if (kind === 'mount') item.mountMs += ms; item.maxCommitMs = Math.max(item.maxCommitMs, ms); phase.probeMs += performance.now() - before; },
    frame(kind, ms, subscribers) { phase.updates++; phase.frameKinds[kind] = (phase.frameKinds[kind] || 0) + 1; if (!production) phase.notifications += subscribers; const cost = phase.functionCosts['GuestClient.applyFrameForTest'] ||= { calls: 0, ms: 0 }; cost.calls++; cost.ms += ms; },
    cost(name, ms) { const cost = phase.functionCosts[name] ||= { calls: 0, ms: 0 }; cost.calls++; cost.ms += ms; },
    notify(count) { phase.notifications += count; phase.subscriberCounts.push(count); },
  };
  let rendererId = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(renderer) { const id = ++rendererId; this.renderers.set(id, renderer); rendererEvidence.push({ version: renderer.version, bundleType: renderer.bundleType, packageName: renderer.rendererPackageName }); return id; },
    onCommitFiberRoot(_id, root) { phase.commits++; rootModes.add(root.current.mode); if (!production) phase.reactMs += root.current.actualDuration || 0; },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
  };
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) new PerformanceObserver(list => {
    for (const item of list.getEntries()) if (item.startTime >= phase.startedAt) phase.longTasks.push({ start: item.startTime - phase.startedAt, duration: item.duration });
  }).observe({ type: 'longtask', buffered: false });
  const frame = now => { if (previousFrame !== undefined) phase.frames.push(now - previousFrame); previousFrame = now; requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
})();
