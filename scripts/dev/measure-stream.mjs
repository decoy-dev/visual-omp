// Drives an already-running, isolated Electron build. Does not launch Electron.
import WebSocket from "ws";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { requireFixture } from "../live-preview-fixture/environment.mjs";

const args = process.argv.slice(2);
const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const root = value("--root");
const port = Number(value("--port"));
const mainPort = Number(value("--main-port"));
const seconds = Number(value("--seconds", 30));
const prompt = value("--prompt", "stress text");
const output = value("--output");
const raise = args.includes("--raise");
if (!root || !Number.isInteger(port) || port <= 0 || !Number.isInteger(mainPort) || mainPort <= 0 || !Number.isFinite(seconds) || seconds <= 0 || !output) {
  throw new Error("Usage: node scripts/dev/measure-stream.mjs --root <fixture-root> --port <renderer-CDP-port> --main-port <Node-inspector-port> --output <json> [--seconds 30] [--prompt 'stress text'] [--classic] [--raise]");
}
await requireFixture(root);
const exec = promisify(execFile);
async function connect(port, select) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(select);
  if (!target?.webSocketDebuggerUrl) throw new Error(`No matching inspector target on port ${port}.`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let sequence = 0;
  const pending = new Map();
  socket.on("message", data => {
    const message = JSON.parse(String(data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  socket.on("close", () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Inspector disconnected.")); }
    pending.clear();
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out.`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const waitForEvent = method => {
    const { promise, resolve, reject } = Promise.withResolvers();
    const cleanup = () => { clearTimeout(timer); socket.off("message", listener); socket.off("close", closed); };
    const listener = data => {
      if (JSON.parse(String(data)).method !== method) return;
      cleanup();
      resolve();
    };
    const closed = () => { cleanup(); reject(new Error(`Inspector disconnected before ${method}.`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`${method} timed out.`)); }, 30000);
    socket.on("message", listener);
    socket.once("close", closed);
    return promise;
  };
  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  return { target, send, evaluate, waitForEvent, close: () => socket.close() };
}
const main = await connect(mainPort, target => target.type === "node");
let renderer;
let restore;
let rendererVerified = false;
let startedTurn = false;
let challenge;
const report = { startedAt: new Date().toISOString(), root: resolve(root), seconds, prompt, classic: args.includes("--classic"), raise, phases: [], samples: [] };
try {
  // Fail closed before changing preferences, sending a prompt, or hiding any window.
  const identity = await main.evaluate(`({ pid: process.pid, agentDir: process.env.PI_CODING_AGENT_DIR, profile: process.env.VOMP_DEV_PROFILE })`);
  if (identity.agentDir !== join(resolve(root), "home", ".omp", "agent") || identity.profile !== join(resolve(root), "app-profile")) {
    throw new Error("The inspected Electron process does not use this fixture's isolated environment.");
  }
  report.mainPid = identity.pid;
  renderer = await connect(port, target => target.type === "page" && !target.url.startsWith("devtools:"));
  const electron = `process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron')`;
  challenge = randomUUID();
  const writeChallenge = `window.__vompStreamHarness = ${JSON.stringify(challenge)}`;
  const windowState = await main.evaluate(`(async () => { const windows = ${electron}.BrowserWindow.getAllWindows().filter(w => w.webContents.getURL() === ${JSON.stringify(renderer.target.url)}); if (windows.length !== 1) throw new Error('Expected one fixture window matching the renderer'); const w = windows[0]; await w.webContents.executeJavaScript(${JSON.stringify(writeChallenge)}); return { windowId: w.id, visible: w.isVisible(), minimized: w.isMinimized() }; })()`);
  if (await renderer.evaluate("window.__vompStreamHarness") !== challenge) throw new Error("The renderer inspector does not belong to the verified fixture process.");
  rendererVerified = true;
  const windowExpression = `${electron}.BrowserWindow.fromId(${windowState.windowId})`;
  if (raise) restore = async () => main.evaluate(`(() => { const w = ${windowExpression}; if (w) { ${windowState.visible ? "w.show();" : "w.hide();"} ${windowState.minimized ? "w.minimize();" : ""} } })()`);
  await renderer.send("Performance.enable");
  const until = async (expression, label) => {
    const deadline = Date.now() + 30000;
    while (!await renderer.evaluate(expression)) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
      await sleep(100);
    }
  };
  await renderer.evaluate(`window.vomp.invoke('app:prefs:set', { setupCompleted: true, tourCompleted: true, sendCrashReports: false, classicPresentation: ${args.includes("--classic")} })`);
  await renderer.send("Page.enable");
  const loaded = renderer.waitForEvent("Page.loadEventFired");
  await Promise.all([renderer.send("Page.reload"), loaded]);
  // Navigation clears the challenge. Re-bind this CDP target before sending input.
  rendererVerified = false;
  await main.evaluate(`(${windowExpression}).webContents.executeJavaScript(${JSON.stringify(writeChallenge)})`);
  if (await renderer.evaluate("window.__vompStreamHarness") !== challenge) throw new Error("The reloaded renderer inspector does not belong to the fixture process.");
  rendererVerified = true;
  if (raise) await main.evaluate(`(() => { const w = ${windowExpression}; w.show(); w.restore(); w.focus(); })()`);
  await until(`document.visibilityState === 'visible'`, "visible renderer (keep the fixture window unoccluded)");
  const visible = `el => !!el?.isConnected && !el.closest('[inert], [hidden], [aria-hidden="true"]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible'`;
  const composerExpression = `[...document.querySelectorAll('textarea:not([disabled])')].find(el => (${visible})(el) && !el.value)`;
  await until(`!!(${composerExpression})`, "visible, empty composer");
  await renderer.evaluate(`(() => { if (document.querySelector('button[aria-label="Stop reply"]')) throw new Error('The fixture composer already has a running reply'); })()`);
  await renderer.evaluate(`(() => { const field = ${composerExpression}; if (!field) throw new Error('The composer is no longer ready'); window.__vompStreamComposer = field.closest('[data-tour="composer"]'); if (!window.__vompStreamComposer) throw new Error('The fixture composer has no send boundary'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(prompt)}); field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await until(`!!window.__vompStreamComposer?.querySelector('button[aria-label="Send message"]:not([disabled])')`, "enabled Send message button");
  await renderer.evaluate(`window.__vompStreamComposer.querySelector('button[aria-label="Send message"]:not([disabled])').click()`);
  startedTurn = true;
  await until(`(() => { const stop = [...document.querySelectorAll('[data-chat-column] button[aria-label="Stop reply"]')].find(${visible}); if (!stop) return false; window.__vompStreamChat = stop.closest('[data-chat-column]'); return true; })()`, "running stream in a visible chat");
  const logExpression = `window.__vompStreamChat?.querySelector('[role="log"]')`;
  await until(`(${visible})(${logExpression})`, "mounted visible transcript log");
  // stream-provider emits six random fixture words followed by counter 0, or the first tool round.
  const replyMarker = /stress tools/i.test(prompt) ? /Round 1: listing numbers\./
    : /stress text/i.test(prompt) ? /\b(?:(?:the|quick|brown|fox|jumps|over|lazy|dog|while|omp|keeps|streaming|a|long|answer|with|code|and|prose)\s+){6}0\b/
      : /Done\./;
  await until(`(() => { const log = ${logExpression}; return (${visible})(log) && [...log.querySelectorAll('.tr-md')].some(el => (${visible})(el) && ${replyMarker}.test(el.textContent ?? '')); })()`, "rendered fixture assistant reply");
  const mainCpu = async () => {
    if (process.platform === "win32") {
      const { stdout } = await exec("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${identity.pid}).TotalProcessorTime.TotalSeconds`]);
      return Number(stdout.trim().replace(",", "."));
    }
    const { stdout } = await exec("ps", ["-p", String(identity.pid), "-o", "time="]);
    // ps cumulative CPU: [[days-]hours:]minutes:seconds.hundredths.
    const parts = stdout.trim().split(/[-:]/).map(Number);
    if (!parts.length || parts.some(part => !Number.isFinite(part))) throw new Error(`Cannot parse ps CPU time: ${stdout}`);
    return parts.reverse().reduce((total, part, index) => total + part * [1, 60, 3600, 86400][index], 0);
  };
  const sample = async phase => {
    const metrics = Object.fromEntries((await renderer.send("Performance.getMetrics")).metrics.map(metric => [metric.name, metric.value]));
    const state = await renderer.evaluate(`({ visibility: document.visibilityState, stopButtonShown: !!document.querySelector('button[aria-label="Stop reply"]') })`);
    const result = { phase, elapsedMs: Date.now() - started, taskSeconds: metrics.TaskDuration, scriptSeconds: metrics.ScriptDuration, jsHeapBytes: metrics.JSHeapUsedSize, mainCpuSeconds: await mainCpu(), ...state };
    if (![result.taskSeconds, result.scriptSeconds, result.jsHeapBytes, result.mainCpuSeconds].every(Number.isFinite)) throw new Error("The inspector did not return the required CPU and heap metrics.");
    if (state.visibility !== phase) throw new Error(`Expected ${phase}, observed ${state.visibility}.`);
    report.samples.push(result);
    return result;
  };
  const started = Date.now();
  for (const phase of ["visible", "hidden"]) {
    if (phase === "hidden") await main.evaluate(`(() => { const w = ${windowExpression}; w.hide(); })()`);
    await until(`document.visibilityState === ${JSON.stringify(phase)}`, `${phase} renderer`);
    const first = await sample(phase);
    const deadline = Date.now() + seconds * 1000;
    let last = first;
    while (Date.now() < deadline) {
      await sleep(Math.min(1000, deadline - Date.now()));
      last = await sample(phase);
    }
    const wallSeconds = (last.elapsedMs - first.elapsedMs) / 1000;
    report.phases.push({ phase, wallSeconds, rendererTaskCpuPercent: 100 * (last.taskSeconds - first.taskSeconds) / wallSeconds, rendererScriptCpuPercent: 100 * (last.scriptSeconds - first.scriptSeconds) / wallSeconds, mainCpuPercent: 100 * (last.mainCpuSeconds - first.mainCpuSeconds) / wallSeconds, startHeapBytes: first.jsHeapBytes, endHeapBytes: last.jsHeapBytes });
  }
  console.log(JSON.stringify(report.phases, null, 2));
} finally {
  // Restoring a window may raise it, so only do that with explicit --raise permission.
  if (restore) await restore().catch(error => console.error(`Window restore failed: ${error.message}`));
  if (renderer) {
    if (rendererVerified && startedTurn) await renderer.evaluate(`(() => { if (window.__vompStreamHarness === ${JSON.stringify(challenge)}) document.querySelector('button[aria-label="Stop reply"]')?.click(); })()`).catch(() => {});
    renderer.close();
  }
  main.close();
  await writeFile(resolve(output), JSON.stringify(report, null, 2) + "\n");
}
