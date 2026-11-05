import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { requireFixture } from "./environment.mjs";

export class InspectorConnection {
  constructor(socket) {
    this.socket = socket;
    this.next = 0;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else for (const listener of this.listeners) listener(message);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Inspector disconnected.")); }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`Cannot connect to ${url}`)), { once: true });
    });
    return new InspectorConnection(socket);
  }
  call(method, params = {}, sessionId, timeout = 2000) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeout} ms.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(expression, sessionId, contextId, timeout = 2000) {
    const result = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) }, sessionId, timeout);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.socket.close(); }
}

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}
async function until(probe, timeout = 120000) {
  const end = performance.now() + timeout;
  do {
    const result = await probe();
    if (result) return result;
    await sleep(100);
  } while (performance.now() < end);
  throw new Error(`Expected state did not appear within ${timeout} ms.`);
}
function flatten(tree) { return [tree.frame, ...(tree.childFrames ?? []).flatMap(flatten)]; }

export function isolationVerdict(report) {
  return report.environment?.packaged === true && report.frame?.osProcessId > 0 && report.appFrame?.osProcessId > 0
    && report.frame.osProcessId !== report.appFrame.osProcessId
    && report.document?.origin === "null" && report.document?.sandbox === "allow-scripts"
    && report.document?.networkOff === true && report.busyStarted === true
    && report.echo?.durationMs >= 10000 && report.echo?.samples.length >= 40
    && report.echo.samples.every(sample => sample.ok && sample.insertTextToValueMs <= 100)
    && report.stageClose?.passed === true && report.idle?.passed === true && !report.error;
}

/** No OS focus, window activation, Page.bringToFront or Electron focus calls are used. */
export async function collectIsolationEvidence(output, fixtureRoot) {
  const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), platform: process.platform,
    rule: "Distinct OS process IDs, every composer echo within 100 ms for 10 seconds, stage close and busy PID idle on both packaged platforms.",
    metrics: { beforeLoad: [], afterLoad: [], busy: [], afterClose: [] }, recovery: [] };
  let main, cdp, appSession, previewSession, previewContext, busy = false, rendererVerified = false;
  const appEval = expression => {
    if (!rendererVerified) throw new Error("Renderer ownership has not been verified.");
    return cdp.evaluate(expression, appSession);
  };
  const mainEval = expression => main.evaluate(expression);
  const metrics = () => mainEval("__isolationElectron.app.getAppMetrics()");
  const closeStage = async () => {
    const clicked = await appEval(`(() => { const slot = document.querySelector('[data-live-subject]'); if (!slot) return true; const section = slot.closest('section'); const close = section?.querySelector('button'); if (!close) return false; close.click(); return true; })()`);
    if (!clicked) throw new Error("The Outputs stage close button is unavailable.");
    await until(async () => !await appEval("Boolean(document.querySelector('[data-live-subject] iframe'))"), 2000);
  };
  try {
    if (typeof fixtureRoot !== "string" || !fixtureRoot) throw new Error("An explicit fixture root is required.");
    const expected = await requireFixture(fixtureRoot);
    report.fixtureRoot = resolve(fixtureRoot);
    const expectedFixture = join(report.fixtureRoot, "work", "isolation.html");
    const expectedProfile = await realpath(expected.VOMP_DEV_PROFILE);
    const expectedAgent = await realpath(expected.PI_CODING_AGENT_DIR);
    const mainTargets = await json("http://127.0.0.1:9229/json/list");
    if (mainTargets.length !== 1) throw new Error("Expected one main-process inspector on loopback port 9229.");
    main = await InspectorConnection.connect(mainTargets[0].webSocketDebuggerUrl);
    const launch = await mainEval("({ pid: process.pid, profile: process.env.VOMP_DEV_PROFILE, agentDir: process.env.PI_CODING_AGENT_DIR, fixtureFile: process.env.VOMP_PREVIEW_ISOLATION_FILE })");
    if (launch.profile !== expected.VOMP_DEV_PROFILE || launch.agentDir !== expected.PI_CODING_AGENT_DIR || launch.fixtureFile !== expectedFixture
      || await realpath(launch.profile) !== expectedProfile || await realpath(launch.agentDir) !== expectedAgent
      || await realpath(dirname(launch.fixtureFile)) !== await realpath(join(report.fixtureRoot, "work"))) {
      throw new Error("The main inspector does not belong to the requested fixture environment.");
    }
    await mainEval("globalThis.__isolationElectron = (typeof require === 'function' ? require('electron') : process.mainModule.require('electron')); true");
    report.environment = await mainEval(`(() => { const e = __isolationElectron; const windows = e.BrowserWindow.getAllWindows(); if (windows.length !== 1) throw Error('Expected one fixture app window.'); globalThis.__isolationContents = windows[0].webContents; return { packaged: e.app.isPackaged, version: e.app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, arch: process.arch, platform: process.platform, switchEnabled: process.env.VOMP_PREVIEW_ISOLATION_TEST === '1', fixtureFile: process.env.VOMP_PREVIEW_ISOLATION_FILE, userData: e.app.getPath('userData'), url: __isolationContents.getURL() }; })()`);
    if (!report.environment.switchEnabled || !report.environment.packaged) throw new Error("A2 shipping evidence requires a packaged app with the main-process test switch enabled.");
    if (report.environment.platform !== process.platform) throw new Error("Run Node inside the same VM or host as the app.");
    if (await realpath(report.environment.userData) !== expectedProfile) throw new Error("The inspected app does not use the fixture's scratch profile.");
    Object.assign(report.environment, launch);
    const version = await json("http://127.0.0.1:9333/json/version");
    cdp = await InspectorConnection.connect(version.webSocketDebuggerUrl);
    const targets = (await cdp.call("Target.getTargets")).targetInfos.filter(target => target.type === "page" && target.url === report.environment.url);
    if (targets.length !== 1) throw new Error("Expected one renderer CDP target matching the fixture app window.");
    appSession = (await cdp.call("Target.attachToTarget", { targetId: targets[0].targetId, flatten: true })).sessionId;
    await cdp.call("Runtime.enable", {}, appSession);
    const challenge = randomUUID();
    await mainEval(`__isolationContents.executeJavaScript(${JSON.stringify(`window.__vompIsolationChallenge = ${JSON.stringify(challenge)}`)})`);
    if (await cdp.evaluate("window.__vompIsolationChallenge", appSession) !== challenge) throw new Error("The renderer inspector does not belong to the verified fixture process.");
    rendererVerified = true;
    const existing = await appEval("Boolean(document.querySelector('[data-live-subject] iframe'))");
    if (existing) throw new Error("Close existing Outputs stages before starting evidence collection, then use a fresh chat.");
    report.environment.rendererVisibility = await appEval("document.visibilityState");
    if (report.environment.rendererVisibility !== "visible") throw new Error("Keep the scratch app visible, without minimizing or fully covering it. The collector never activates windows.");
    report.metrics.beforeLoad = await metrics();
    console.log("Armed. In the scratch app chat, send fixture isolation and choose Watch to open Outputs. Do not click Start busy loop. Collection starts when the saved page loads.");
    let stableUrl, stableSince = performance.now();
    const document = await until(async () => {
      const frame = await appEval(`(() => { const frame = [...document.querySelectorAll('[data-live-subject] iframe')].find(frame => frame.getAttribute('sandbox') === 'allow-scripts' && frame.getAttribute('aria-hidden') === 'false'); if (!frame) return null; return { url: frame.src, sandbox: frame.getAttribute('sandbox') }; })()`);
      if (!frame) { stableUrl = undefined; return null; }
      if (frame.url !== stableUrl) { stableUrl = frame.url; stableSince = performance.now(); }
      return performance.now() - stableSince >= 1000 ? frame : null;
    });
    report.metrics.afterLoad = await metrics();
    const identity = await mainEval(`(() => { const frame = __isolationContents.mainFrame.framesInSubtree.find(frame => frame.url === ${JSON.stringify(document.url)}); if (!frame) throw Error('Preview webFrameMain is missing.'); const describe = frame => ({ url: frame.url, osProcessId: frame.osProcessId, processId: frame.processId, routingId: frame.routingId, frameTreeNodeId: frame.frameTreeNodeId }); return { frame: describe(frame), appFrame: describe(__isolationContents.mainFrame) }; })()`);
    Object.assign(report, identity);
    const frameTargets = (await cdp.call("Target.getTargets")).targetInfos.filter(target => target.type === "iframe" && target.url === document.url);
    if (frameTargets.length > 1) throw new Error("More than one CDP iframe target matches the saved fixture.");
    previewSession = frameTargets.length ? (await cdp.call("Target.attachToTarget", { targetId: frameTargets[0].targetId, flatten: true })).sessionId : appSession;
    await cdp.call("Page.enable", {}, previewSession);
    await cdp.call("Runtime.enable", {}, previewSession);
    const tree = await cdp.call("Page.getFrameTree", {}, previewSession);
    const frame = flatten(tree.frameTree).find(frame => frame.url === document.url);
    if (!frame) throw new Error("The preview frame is missing from its CDP frame tree.");
    previewContext = (await cdp.call("Page.createIsolatedWorld", { frameId: frame.id, worldName: "vomp-isolation-evidence" }, previewSession)).executionContextId;
    report.document = { ...document, ...await cdp.evaluate(`({ origin: self.origin, ready: document.querySelector('#isolation-status')?.textContent, button: Boolean(document.querySelector('#isolation-busy')) })`, previewSession, previewContext) };
    report.document.csp = await mainEval(`(async () => { const response = await __isolationElectron.net.fetch(${JSON.stringify(document.url)}); await response.arrayBuffer(); return response.headers.get('content-security-policy'); })()`);
    report.document.networkOff = report.document.csp?.includes("connect-src 'none'") && !/https?:|wss?:/.test(report.document.csp);
    if (report.document.origin !== "null" || !report.document.button || !report.document.ready?.startsWith("Ready.")) throw new Error("The saved fixture did not run with an opaque origin.");
    await appEval(`(() => { const inputs = [...document.querySelectorAll('textarea')].filter(input => !input.disabled && input.getClientRects().length); if (inputs.length !== 1) throw Error('Expected one visible composer textarea.'); const input = inputs[0]; if (input.value) throw Error('The composer must be empty before this test.'); globalThis.__isolationComposer = input; globalThis.__isolationEchoes = []; input.addEventListener('input', () => __isolationEchoes.push({ value: input.value, at: performance.now() })); input.focus({ preventScroll: true }); return true; })()`);
    let startedResolve;
    const started = new Promise(resolve => { startedResolve = resolve; });
    cdp.listeners.add(message => {
      if (message.sessionId === previewSession && message.method === "Runtime.consoleAPICalled"
        && message.params.args?.some(arg => arg.value === "VOMP_ISOLATION_BUSY_STARTED")) { report.busyStarted = true; startedResolve(true); }
    });
    busy = true;
    await cdp.evaluate("document.querySelector('#isolation-busy').click(); true", previewSession, previewContext);
    await Promise.race([started, sleep(2000).then(() => { throw new Error("The busy loop did not report starting."); })]);
    const begin = performance.now();
    report.echo = { durationMs: 0, samples: [] };
    const sampleMetrics = (async () => {
      for (let index = 0; index < 10; index++) {
        await sleep(1000);
        const framePresent = await mainEval(`__isolationContents.mainFrame.framesInSubtree.some(frame => frame.frameTreeNodeId === ${report.frame.frameTreeNodeId} && frame.osProcessId === ${report.frame.osProcessId} && frame.url === ${JSON.stringify(document.url)})`);
        report.metrics.busy.push({ elapsedMs: performance.now() - begin, framePresent, metrics: await metrics() });
        if (!framePresent) throw new Error("The busy fixture frame was replaced before the 10-second collection finished.");
      }
    })().catch(error => { report.metricSamplingError = String(error); });
    while (performance.now() - begin < 10000) {
      const index = report.echo.samples.length;
      const text = String.fromCharCode(97 + index % 26);
      const start = performance.now();
      try {
        // DOM focus stays inside the renderer. It never activates or raises its OS window.
        await appEval("__isolationComposer.focus({ preventScroll: true }); true");
        const before = await appEval("__isolationComposer.value");
        const inserted = performance.now();
        await cdp.call("Input.insertText", { text }, appSession, 500);
        const state = await appEval("({ value: __isolationComposer.value, visibility: document.visibilityState })");
        const elapsed = performance.now() - inserted;
        report.echo.samples.push({ index, elapsedMs: inserted - begin, insertTextToValueMs: elapsed, visibility: state.visibility, ok: state.value === before + text && state.visibility === "visible" });
      } catch (error) { report.echo.samples.push({ index, elapsedMs: start - begin, insertTextToValueMs: null, ok: false, error: String(error) }); }
      await sleep(Math.max(0, 200 - (performance.now() - start)));
    }
    report.echo.durationMs = performance.now() - begin;
    await sampleMetrics;
    if (report.metricSamplingError) throw new Error(report.metricSamplingError);
    report.busyPeakPercentCPUUsage = Math.max(0, ...report.metrics.busy.flatMap(sample => sample.metrics.filter(metric => metric.pid === report.frame.osProcessId).map(metric => metric.cpu.percentCPUUsage)));
    const closeStart = performance.now();
    try { await closeStage(); report.stageClose = { passed: true, elapsedMs: performance.now() - closeStart }; }
    catch (error) { report.stageClose = { passed: false, elapsedMs: performance.now() - closeStart, error: String(error) }; }
    if (!report.stageClose.passed) {
      // A shared hung renderer cannot process Close. Recover only after recording that failure.
      await cdp.call("Runtime.terminateExecution", {}, previewSession);
      busy = false;
      report.recovery.push("Terminated the busy JavaScript execution after stage close failed.");
      await closeStage();
    }
    let idleSamples = 0;
    for (let index = 0; index < 10; index++) {
      await sleep(1000);
      const values = await metrics();
      const process = values.find(metric => metric.pid === report.frame.osProcessId);
      report.metrics.afterClose.push({ elapsedMs: performance.now() - closeStart, metrics: values });
      idleSamples = !process || process.cpu.percentCPUUsage <= 1 ? idleSamples + 1 : 0;
      if (idleSamples >= 3) break;
    }
    report.idle = { passed: idleSamples >= 3, osProcessId: report.frame.osProcessId, maxPercentCPUUsage: 1, consecutiveSamplesRequired: 3 };
    if (report.idle.passed) busy = false;
    report.echo.events = await appEval("__isolationEchoes");
  } catch (error) { report.error = String(error?.stack ?? error); }
  finally {
    if (rendererVerified && busy && cdp && previewSession) {
      try { await cdp.call("Runtime.terminateExecution", {}, previewSession); report.recovery.push("Terminated busy JavaScript during error cleanup."); await closeStage(); }
      catch (error) { report.recovery.push(`Cleanup failed: ${String(error)}. Quit the scratch app manually.`); }
    }
    report.platformPassed = isolationVerdict(report);
    report.decision = report.platformPassed ? "This platform passes. The other packaged platform must also pass before iframe scripts are allowed." : "This run does not authorize iframe scripts. Use the WebContentsView fallback unless both packaged platform runs pass.";
    cdp?.close(); main?.close();
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [fixtureRoot, ...args] = process.argv.slice(2);
  if (!fixtureRoot || (args.length && (args.length !== 2 || args[0] !== "--output"))) throw new Error("Usage: node isolation-evidence.mjs <fixture-root> [--output <path>]");
  const output = resolve(args[1] ?? fileURLToPath(new URL(`evidence/isolation/${process.platform}.json`, import.meta.url)));
  const report = await collectIsolationEvidence(output, fixtureRoot);
  console.log(`${report.platformPassed ? "Passed" : "Failed"}: ${output}`);
  if (!report.platformPassed) process.exitCode = 1;
}
