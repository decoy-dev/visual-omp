import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdtemp, rm, realpath } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { prepareScenario, checkout } from './scenario.mjs';
import { requireFixture } from '../../live-preview-fixture/environment.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const headless = args.includes('--headless');
const production = args.includes('--production');
if (production && !headless) throw new Error('--production requires --headless; Electron paths remain development-only.');
if (args.includes('--source-root') && !production) throw new Error('--source-root requires --production.');
const sourceRoot = resolve(value('--source-root', checkout));
const seconds = Number(value('--seconds', 30));
const output = resolve(value('--output', '/tmp/vomp-speed-result.json'));
if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--seconds must be positive.');
let chrome, vite, page, main, profile;
const report = { startedAt: new Date().toISOString(), mode: production ? 'headless Chrome production measurement renderer' : headless ? 'headless Chrome development renderer' : 'Electron development renderer', seconds, phases: [], errors: [], notes: ['Deterministic GuestClient.applyFrameForTest replay, actual controller/store/components.', 'Host, encryption and IPC CPU are excluded. Helper transcript transport is an in-memory incremental byte slice.', production ? 'Ordinary production React without StrictMode; no component Profiler or subscriber transform. CDP sampler, commit hook and replay frame timing remain measurement overhead.' : 'Development React, StrictMode and opt-in profiling add overhead; do not treat as production latency.'] };

async function connect(url) {
  const socket = new WebSocket(url);
  await once(socket, 'open');
  let sequence = 0;
  const pending = new Map();
  socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    if (message.method === 'Runtime.exceptionThrown') report.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
  });
  socket.on('close', () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Inspector disconnected')); } pending.clear(); });
  const send = (method, params = {}) => {
    const { promise, resolve, reject } = Promise.withResolvers();
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 60000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    return promise;
  };
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async expression => {
    const deadline = Date.now() + 60000;
    while (!await evaluate(expression)) { if (report.errors.length) throw new Error(report.errors.at(-1)); if (Date.now() > deadline) throw new Error(`Timed out: ${expression}`); await sleep(100); }
  };
  return { send, evaluate, until, close: () => socket.close() };
}
async function target(port, type) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
  const match = targets.find(target => target.type === type && !target.url.startsWith('devtools:'));
  if (!match?.webSocketDebuggerUrl) throw new Error(`No ${type} inspector on ${port}`);
  return match;
}
function summarize(raw, before, after) {
  const wallSeconds = raw.wallMs / 1000;
  const sorted = raw.frames.toSorted((a, b) => a - b);
  const summary = { ...raw, frameCount: sorted.length, frameP50Ms: sorted[Math.floor(sorted.length * .5)] ?? null, frameP95Ms: sorted[Math.floor(sorted.length * .95)] ?? null, frameMaxMs: sorted.at(-1) ?? null, framesOver50Ms: sorted.filter(ms => ms > 50).length, mainThreadBusyPercent: 100 * (after.TaskDuration - before.TaskDuration) / wallSeconds, scriptMsPerSecond: 1000 * (after.ScriptDuration - before.ScriptDuration) / wallSeconds, layoutMsPerSecond: 1000 * (after.LayoutDuration - before.LayoutDuration) / wallSeconds, styleMsPerSecond: 1000 * (after.RecalcStyleDuration - before.RecalcStyleDuration) / wallSeconds, commitsPerSecond: raw.commits / wallSeconds, longTaskCount: raw.longTasks.length, longTaskMs: raw.longTasks.reduce((sum, task) => sum + task.duration, 0) };
  if (!production) {
    const components = Object.entries(raw.components).map(([name, data]) => ({ name, ...data, actualMsPerSecond: data.actualMs / wallSeconds })).sort((a, b) => b.actualMs - a.actualMs);
    Object.assign(summary, { componentRendersPerUpdate: raw.updates ? components.reduce((sum, component) => sum + component.renders, 0) / raw.updates : null, notificationsPerUpdate: raw.updates ? raw.notifications / raw.updates : null, subscriberMax: Math.max(0, ...raw.subscriberCounts), topComponents: components.slice(0, 25) });
  }
  return summary;
}
const metrics = async () => Object.fromEntries((await page.send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]));
async function phase(label, action, duration = 0, cpuProfile = false) {
  await page.evaluate(`window.__vompSpeed.reset(${JSON.stringify(label)})`);
  const before = await metrics();
  if (cpuProfile) await page.send('Profiler.start');
  const started = Date.now();
  await action();
  if (duration) await sleep(duration);
  const after = await metrics();
  const raw = await page.evaluate('window.__vompSpeed.read()');
  if (raw.visibility !== 'visible') throw new Error(`The ${label} capture became hidden. Keep the fixture window visible.`);
  if (cpuProfile) {
    const { profile } = await page.send('Profiler.stop');
    const profilePath = output.replace(/\.json$/, '') + `-${label}.cpuprofile`;
    await writeFile(profilePath, JSON.stringify(profile));
    const costs = new Map();
    const nodes = new Map(profile.nodes.map(node => [node.id, node]));
    for (const [index, id] of (profile.samples ?? []).entries()) {
      const frame = nodes.get(id)?.callFrame;
      if (!frame) continue;
      const key = JSON.stringify(frame);
      costs.set(key, (costs.get(key) ?? 0) + (profile.timeDeltas?.[index] ?? 1000) / 1000);
    }
    report.profiles ||= [];
    report.profiles.push({ phase: label, file: profilePath, topFunctions: [...costs].map(([key, selfMs]) => ({ ...JSON.parse(key), selfMs, msPerSecond: selfMs / ((Date.now() - started) / 1000) })).sort((a, b) => b.selfMs - a.selfMs).slice(0, 80) });
  }
  const summary = summarize(raw, before, after);
  report.phases.push(summary);
  console.log(`${label}: busy ${summary.mainThreadBusyPercent.toFixed(1)}%, p95 ${summary.frameP95Ms?.toFixed(1)} ms, ${summary.commitsPerSecond.toFixed(1)} commits/s, ${summary.longTaskCount} long tasks`);
}
try {
  let data;
  let url;
  if (headless) {
    data = await prepareScenario();
    if (production) {
      const { productionRenderer } = await import('./production.mjs');
      const workspace = await mkdtemp(join(tmpdir(), 'vomp-speed-production-'));
      vite = await productionRenderer({ sourceRoot, checkout, workspace });
      report.productionBuild = vite.evidence;
      url = vite.url;
    } else {
      const { createServer } = await import('vite');
      const { default: react } = await import('@vitejs/plugin-react');
      const { default: tailwindcss } = await import('@tailwindcss/vite');
      const { speedProbe } = await import('./plugin.ts');
      profile = await mkdtemp(join(tmpdir(), 'vomp-speed-chrome-'));
      vite = await createServer({ configFile: false, root: join(checkout, 'src/renderer'), cacheDir: join(profile, 'vite-cache'), plugins: [speedProbe(), react(), tailwindcss()], resolve: { alias: { '@shared': join(checkout, 'src/shared'), '@': join(checkout, 'src/renderer/src'), '@oh-my-pi/pi-wire': join(checkout, 'src/renderer/src/collab/wire/index.ts'), '@oh-my-pi/pi-utils/marked': 'marked', '@oh-my-pi/pi-utils/math-delimiters': join(checkout, 'src/renderer/src/collab/math-delimiters.ts') } }, server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [checkout, await realpath(join(checkout, 'node_modules'))] } } });
      await vite.listen(); url = vite.resolvedUrls.local[0];
    }
    profile ||= await mkdtemp(join(tmpdir(), 'vomp-speed-chrome-'));
    const binary = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    chrome = spawn(binary, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const ready = Promise.withResolvers();
    let text = '';
    const timer = setTimeout(() => ready.reject(new Error(`Chrome did not start: ${text}`)), 20000);
    chrome.once('error', ready.reject);
    chrome.stderr.on('data', bytes => { text += bytes; const match = text.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); ready.resolve(new URL(match[1])); } });
    const endpoint = await ready.promise;
    const newTarget = await fetch(`http://${endpoint.host}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
    page = await connect(newTarget.webSocketDebuggerUrl);
    const preload = await readFile(new URL('./preload.js', import.meta.url), 'utf8');
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__speedScenario=${JSON.stringify(data)};\n${preload}` });
  } else {
    const root = resolve(value('--root', ''));
    if (!args.includes('--root') || !args.includes('--port') || !args.includes('--main-port')) throw new Error('Electron: --root <prepared root> --port <CDP> --main-port <Node inspector> required.');
    await requireFixture(root);
    data = JSON.parse(await readFile(join(root, 'speed-scenario.json'), 'utf8'));
    main = await connect((await target(Number(value('--main-port')), 'node')).webSocketDebuggerUrl);
    const identity = await main.evaluate('({agentDir: process.env.PI_CODING_AGENT_DIR, profile: process.env.VOMP_DEV_PROFILE, speed: process.env.VOMP_SPEED})');
    if (identity.agentDir !== join(root, 'home/.omp/agent') || identity.profile !== join(root, 'app-profile') || identity.speed !== '1') throw new Error('Inspector is not the explicitly opted-in isolated speed fixture.');
    const selected = await target(Number(value('--port')), 'page');
    if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+/.test(selected.url)) throw new Error('A Vite development renderer is required.');
    page = await connect(selected.webSocketDebuggerUrl); url = selected.url;
    const electron = `process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron')`;
    const challenge = `speed-${Date.now()}-${Math.random()}`;
    await main.evaluate(`(async()=>{ const windows=${electron}.BrowserWindow.getAllWindows().filter(w=>w.webContents.getURL()===${JSON.stringify(url)}); if(windows.length!==1)throw Error('Expected one matching fixture window'); await windows[0].webContents.executeJavaScript(${JSON.stringify(`window.__speedIdentity=${JSON.stringify(challenge)}`)}); })()`);
    if (await page.evaluate('window.__speedIdentity') !== challenge) throw new Error('Renderer does not belong to verified fixture process.');
  }
  report.root = data.root;
  report.scenario = { entries: data.entries.length, helperEntries: 350, helpers: data.helpers.length, provenance: data.provenance, streamIntervalMs: data.streamIntervalMs, helperIntervalMs: data.helperIntervalMs, appendIntervalMs: data.appendIntervalMs };
  report.notes.push('The worker offers text for the requested seconds, then stops text while helpers keep updating. Streaming wallMs includes draining queued updates. Delivery lag distinguishes renderer backlog from a slower producer.');
  report.browser = await page.send('Browser.getVersion');
  await page.send('Runtime.enable'); await page.send('Page.enable'); await page.send('Performance.enable'); await page.send('Profiler.enable'); await page.send('Profiler.setSamplingInterval', { interval: 1000 });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__speedProduction=${production};\n` + await readFile(new URL('./probe.js', import.meta.url), 'utf8') });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.send('Page.navigate', { url });
  await page.until("!!document.querySelector('[role=log]')");
  if (production) {
    await page.until('typeof window.__vompSpeedInstall === "function"');
    await page.evaluate(`window.__vompSpeedInstall(${JSON.stringify(data)})`);
    report.reactEvidence = await page.evaluate('window.__vompSpeed.reactEvidence()');
    if (!report.reactEvidence.renderers.length || report.reactEvidence.renderers.some(renderer => renderer.bundleType !== 0) || !report.reactEvidence.rootModes.length || report.reactEvidence.strictMode) throw new Error('Expected ordinary production React with committed non-StrictMode roots.');
  } else {
    const moduleUrl = '/src/dev/speedReplay.ts';
    await page.evaluate(`import(${JSON.stringify(moduleUrl)}).then(module => module.install(${JSON.stringify(data)}))`);
  }
  await page.until("window.__vompSpeedReplay?.state().helperCount === 4");
  if (await page.evaluate('document.visibilityState') !== 'visible') throw new Error('Keep the fixture window visible and unoccluded during capture.');
  await phase('open-heavy', async () => {
    const timing = await page.evaluate(`(async()=>{ const start=performance.now(); await window.__vompSpeedReplay.open('speed-heavy'); const log=document.querySelector('[role=log]'); if(!log?.textContent.includes('Batch')) throw Error('Heavy transcript is not painted'); return { firstTranscriptPaintMs:performance.now()-start, mountedRows:log.children.length, scrollHeight:log.scrollHeight }; })()`);
    report.open = timing;
  }, 500);
  await phase('streaming', async () => {
    await page.evaluate(`window.__vompSpeedReplay.start(${seconds})`);
    await sleep(seconds * 1000);
    await page.until('window.__vompSpeedReplay.state().sourceEnded');
    report.streamEndState = await page.evaluate('window.__vompSpeedReplay.state()');
  }, 0, true);
  await phase('scrolling', async () => {
    for (let step = 0; step < 100; step++) {
      const point = await page.evaluate(`(()=>{const log=document.querySelector('[role=log]');const box=log.getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2};})()`);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: step < 70 ? -650 : 650 });
      await sleep(50);
    }
  }, 0, true);
  await phase('switch-chat', async () => {
    report.switch = await page.evaluate(`(async()=>{let start=performance.now();await window.__vompSpeedReplay.open('speed-light');const lightMs=performance.now()-start;start=performance.now();await window.__vompSpeedReplay.open('speed-heavy');return {lightMs,heavyMs:performance.now()-start};})()`);
  }, 500);
  await phase('tasks', () => page.evaluate('window.__vompSpeedReplay.tasks()'), 10000, true);
  report.finalState = await page.evaluate('window.__vompSpeedReplay.state()');
  report.tasksEvidence = await page.evaluate(`({ text: document.querySelector('[data-tour="dock"]')?.textContent, helperRows: [...(document.querySelector('[data-tour="dock"]')?.querySelectorAll('li') ?? [])].filter(row => row.textContent.includes('SpeedHelper')).length })`);
  if (report.tasksEvidence.helperRows !== 4) throw new Error('Tasks did not render all four helpers.');
  report.screenshot = output.replace(/\.json$/, '') + '.png';
  await writeFile(report.screenshot, Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  report.unhandledHeadlessChannels = headless ? await page.evaluate('[...window.__speedUnhandled]') : undefined;
  const streaming = report.phases.find(phase => phase.label === 'streaming');
  if (!streaming?.updates || !streaming.commits || (!production && (!streaming.subscriberMax || !streaming.topComponents.some(component => component.name === 'TranscriptBody')))) throw new Error(production ? 'Production capture lacks collab updates or React commits.' : 'Capture lacks collab updates, subscriber instrumentation or React Profiler commits. Start the fixture with VOMP_SPEED=1.');
  if (production) report.reactEvidence = await page.evaluate('window.__vompSpeed.reactEvidence()');
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
  if (page) report.failureContext = await page.evaluate('({ text: document.body.innerText.slice(0, 5000), unhandled: [...(window.__speedUnhandled ?? [])] })').catch(() => null);
  console.error(error.stack);
} finally {
  if (page) await Promise.race([page.evaluate('window.__vompSpeedReplay?.stop()').catch(() => {}), sleep(2000)]);
  page?.close(); main?.close();
  if (chrome && chrome.exitCode === null) { const exit = once(chrome, 'exit'); chrome.kill(); if (!await Promise.race([exit.then(() => true), sleep(3000, false)])) { chrome.kill('SIGKILL'); await exit; } }
  await vite?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  const summary = [report.mode, `Scenario: ${report.root}`, report.failure ? `FAILED: ${report.failure}` : `First transcript paint: ${report.open.firstTranscriptPaintMs.toFixed(1)} ms`, ...report.phases.map(phase => `${phase.label}: ${phase.mainThreadBusyPercent.toFixed(1)}% busy, p95 ${phase.frameP95Ms?.toFixed(1)} ms, ${phase.commitsPerSecond.toFixed(1)} commits/s, ${phase.longTaskCount} long tasks${production ? '' : `, ${phase.notificationsPerUpdate?.toFixed(1)} notifications/update`}`), `JSON: ${output}`].join('\n') + '\n';
  const captureWindow = report.phases.filter(phase => phase.label === 'streaming').map(phase => `Offered text burst: ${seconds}s; capture including backlog drain: ${(phase.wallMs / 1000).toFixed(1)}s; delivered text updates: ${phase.frameKinds.message_update ?? 0}`).join('\n') + '\n';
  const costs = production ? 'Component render counts/durations and subscriber metrics: absent (ordinary production React, no transforms).\n' : report.phases.filter(phase => phase.label === 'streaming' || phase.label === 'tasks').flatMap(phase => [`${phase.label} profiled subtrees (inclusive, overlapping):`, ...phase.topComponents.slice(0, 5).map(component => `  ${component.name}: ${component.actualMsPerSecond.toFixed(1)} ms/s, ${component.renders} renders, ${component.commits} commits`)]).join('\n') + '\n';
  await writeFile(output.replace(/\.json$/, '') + '.txt', summary + captureWindow + costs);
  console.log(summary + captureWindow + costs);
}
// Vite's native development tooling can retain background handles after close().
// All owned browsers, sockets and servers have been closed before this CLI exits.
process.exit(process.exitCode ?? 0);
