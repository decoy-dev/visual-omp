// Renderer fixture evidence only. No Electron, omp process, provider or model call runs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createServer } from "vite";
import WebSocket from "ws";

const checkout = resolve(import.meta.dirname, "../..");
const output = resolve(process.argv.includes("--output") ? process.argv[process.argv.indexOf("--output") + 1] : join(homedir(), "vomp-checks/large-handoff/renderer"));
const profile = await mkdtemp(join(tmpdir(), "vomp-handoff-renderer-"));
await mkdir(output, { recursive: true });
const evidence = { mode: "Headless Chrome renderer fixture", startedAt: new Date().toISOString(), command: "node scripts/dev/large-handoff-evidence.mjs", screenshots: [], errors: [], limits: ["Actual App, dialog, handoff row, composer, transcript and draft store. Electron IPC is fixture-backed.", "Handoff completion and controller send use a deterministic renderer fixture seam. Success displays its recorded message through the production saved-transcript reader. No claim about main-process RPC, model quality or native host delivery.", "Timeout is an IPC rejection fixture, without waiting for a production timeout."] };
let vite, chrome, socket;
const pending = new Map();
try {
  vite = await createServer({ configFile: false, root: join(checkout, "src/renderer"), cacheDir: join(profile, "vite-cache"), plugins: [react(), tailwindcss()], resolve: { dedupe: ["react", "react-dom"], alias: { "@shared": join(checkout, "src/shared"), "@": join(checkout, "src/renderer/src"), "@oh-my-pi/pi-wire": join(checkout, "src/renderer/src/collab/wire/index.ts"), "@oh-my-pi/pi-utils/marked": "marked", "@oh-my-pi/pi-utils/math-delimiters": join(checkout, "src/renderer/src/collab/math-delimiters.ts") } }, server: { host: "127.0.0.1", port: 0, hmr: false, fs: { allow: [checkout, await realpath(join(checkout, "node_modules"))] } } });
  await vite.listen();
  chrome = spawn(process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const ready = Promise.withResolvers(); let log = "";
  chrome.once("error", ready.reject);
  chrome.stderr.on("data", bytes => { log += bytes; const match = log.match(/DevTools listening on (ws:\/\/\S+)/); if (match) ready.resolve(new URL(match[1])); });
  const deadline = setTimeout(() => ready.reject(Error(`Chrome startup timed out: ${log}`)), 20000);
  const endpoint = await ready.promise.finally(() => clearTimeout(deadline));
  const target = await fetch(`http://${endpoint.host}/json/new?about:blank`, { method: "PUT" }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, "open");
  let sequence = 0;
  socket.on("message", raw => {
    const message = JSON.parse(String(raw));
    if (message.method === "Runtime.exceptionThrown") evidence.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    const request = pending.get(message.id); if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(Error(JSON.stringify(message.error))); else request.resolve(message.result);
  });
  const send = (method, params = {}) => {
    const request = Promise.withResolvers(); const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); request.reject(Error(`${method} timed out`)); }, 30000);
    pending.set(id, { ...request, timer }); socket.send(JSON.stringify({ id, method, params })); return request.promise;
  };
  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async expression => {
    const deadline = Date.now() + 30000;
    while (!await evaluate(expression)) {
      if (evidence.errors.length) throw Error(evidence.errors.at(-1));
      if (Date.now() > deadline) throw Error(`Timed out: ${expression}\n${await evaluate("document.body.innerText")}`);
      await sleep(50);
    }
  };
  const click = async label => {
    const expression = `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)} && button.getClientRects().length)`;
    await until(`!!(${expression})`); await evaluate(`(${expression}).click()`);
  };
  const capture = async name => {
    await evaluate("document.fonts.ready"); await sleep(250);
    const path = join(output, `${name}.png`);
    await writeFile(path, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    evidence.screenshots.push({ path, text: await evaluate("document.body.innerText"), theme: await evaluate("document.documentElement.dataset.theme") });
  };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const basePreload = await readFile(join(checkout, "scripts/dev/speed/preload.js"), "utf8");
  let preloadId;
  async function load(theme, withMessage = true) {
    if (preloadId) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: preloadId });
    const data = { root: "/renderer-fixture", projectPath: "/projects/design", tabs: [{ id: "speed-light", title: "Large design chat", sessionFile: "/sessions/source.jsonl", projectPath: "/projects/design" }], header: { type: "session", version: 3, id: "source", timestamp: "2026-11-09T17:00:00.000Z", cwd: "/projects/design", title: "Large design chat" }, entries: [], light: [] };
    const source = `localStorage.clear(); window.__speedScenario = ${JSON.stringify(data)};\n${basePreload}\n(() => {
      const original = window.vomp.invoke; window.__handoffCalls = []; window.__sent = []; window.__handoffPending = null;
      window.vomp.invoke = async (channel, ...args) => {
        if (channel === 'sessions:handoff') { window.__handoffCalls.push(args); const task = Promise.withResolvers(); window.__handoffPending = task; return task.promise; }
        if (channel === 'sessions:cancelHandoff') return window.__holdCleanup ? new Promise(resolve => { window.__finishCleanup = resolve; }) : undefined;
        if (channel === 'fs:readImage') return null;
        if (channel === 'host:start') return new Promise(() => {});
        if (channel === 'project:paths') return args[0];
        if (channel === 'sessions:projects') return [{path:'/projects/design',name:'Renderer fixture',count:2}];
        if (channel === 'app:info') return {...await original(channel,...args),version:'0.7.11'};
        if (channel === 'sessions:read' && args[0] === '/sessions/sent.jsonl') return [{...${JSON.stringify(data.header)},id:'replacement',title:'New chat with handoff'}, ...window.__sent.map((message, index) => ({type:'message', id:'sent-'+index, parentId:null, timestamp:'2026-11-09T17:01:00.000Z', message:{role:'user', content:[{type:'text',text:message.text}],timestamp:1794243660000}}))].map(row => JSON.stringify(row)).join('\\n')+'\\n';
        const value = await original(channel, ...args);
        if (channel === 'app:prefs:get') return { ...value, theme: ${JSON.stringify(theme)}, reducedMotion: 'on' };
        return value;
      };
      window.__fixtureMessage = ${JSON.stringify(withMessage ? { text: withMessage === "image" ? "" : "Continue the implementation and keep the existing keyboard behavior.", images: [{ path: "/projects/design/reference.png", name: "reference.png" }] } : undefined) ?? "undefined"};
    })();`;
    ({ identifier: preloadId } = await send("Page.addScriptToEvaluateOnNewDocument", { source }));
    await send("Page.navigate", { url: vite.resolvedUrls.local[0] });
    await until("!!document.querySelector('[data-setup-shell]') && !!document.querySelector('[data-tour=sidebar]')");
    await evaluate(`(async () => {
      const {useApp,controllerFor} = await import('/src/state/app.ts');
      const {useComposerDrafts} = await import('/src/chat/composer/drafts.ts');
      const {askLargeResume} = await import('/src/features/session-tools/largeResume.tsx');
      window.__app = useApp; window.__drafts = useComposerDrafts; window.__controllerFor = controllerFor;
      useApp.setState({view:'chat',activeTabId:'speed-light'});
      if(window.__fixtureMessage) { useComposerDrafts.getState().setDraft('speed-light', window.__fixtureMessage.text); useComposerDrafts.getState().addAttachments('speed-light', window.__fixtureMessage.images); }
      window.__request = {tabId:'speed-light',projectPath:'/projects/design',file:'/sessions/source.jsonl',bytes:70531373,signal:new AbortController().signal,...(window.__fixtureMessage?{message:window.__fixtureMessage}:{})};
      window.__answer = askLargeResume(window.__request);
    })()`);
    await until("!!document.querySelector('[role=dialog]') && !!document.querySelector('input[type=checkbox]')");
    assert.equal(await evaluate("!!document.querySelector('input[type=checkbox]').checked"), true);
    assert.equal(await evaluate("document.body.innerText.includes('Bring a handoff and my message to the new chat')"), !!withMessage);
  }
  async function start() {
    // Leave newChat, drafts and all rendered components intact. Only the fixture delivery boundary is replaced.
    await evaluate(`(() => { const original=window.__app.getState().newChat; window.__app.setState({newChat:async (...args)=>{const id=await original(...args); const controller=window.__controllerFor(id); controller.sendWithOwnership=async(text,images)=>{window.__sent.push({text,images});return {kind:'submitted'};}; return id;}}); })()`);
    await click("Start new chat");
    await until("window.__handoffCalls.length === 1 && document.body.innerText.includes('Writing a handoff')");
  }
  for (const theme of ["light", "dark"]) {
    await load(theme, false); await capture(`${theme}-dialog-without-message`);
    await load(theme, "image"); await capture(`${theme}-dialog-image-only`);
    await load(theme, true); await capture(`${theme}-dialog-with-message`);
    await evaluate("document.querySelector('input[type=checkbox]').click()");
    await until("document.body.innerText.includes('without this conversation')"); await capture(`${theme}-dialog-unchecked`);
    await load(theme, true); await start(); await capture(`${theme}-writing`);
    await click("Cancel"); await until("document.body.innerText.includes('The handoff was cancelled')"); await capture(`${theme}-cancelled`);
    await evaluate("window.__holdCleanup = true");
    await click("Try again"); await until("document.body.innerText.includes('Stopping the previous handoff')"); await capture(`${theme}-stopping`);
    await evaluate("window.__holdCleanup = false; window.__finishCleanup()");
    await until("window.__handoffCalls.length === 2");
    await evaluate("window.__handoffPending.reject(new Error('The handoff could not be written because the source file is unavailable.'))");
    await until("document.body.innerText.includes('source file is unavailable')"); await capture(`${theme}-failed`);
    await click("Try again"); await until("window.__handoffCalls.length === 3");
    await evaluate("window.__handoffPending.reject(new Error('The handoff timed out after 120 seconds. Your message is still a draft.'))");
    await until("document.body.innerText.includes('timed out after 120 seconds')"); await capture(`${theme}-timeout`);
    await click("Try again"); await until("window.__handoffCalls.length === 4");
    await evaluate("window.__handoffPending.resolve({file:'/projects/design/handoff notes/context.md'})");
    await until("window.__sent.length === 1");
    assert.equal(await evaluate("window.__sent[0].text"), '@"/projects/design/handoff notes/context.md"\n\nContinue the implementation and keep the existing keyboard behavior.');
    await evaluate(`window.__app.getState().openSession({file:'/sessions/sent.jsonl',cwd:'/projects/design',title:'New chat with handoff',timestamp:'2026-11-09T17:01:00.000Z',messageCount:1})`);
    await until("document.body.innerText.includes('Continue the implementation and keep the existing keyboard behavior.') && !document.body.innerText.includes('Writing a handoff')");
    await capture(`${theme}-success-new-chat`);
  }
  assert.deepEqual(evidence.errors, []);
  console.log(`Captured ${evidence.screenshots.length} renderer fixture screenshots to ${output}`);
} catch (error) {
  evidence.failure = String(error); throw error;
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  socket?.close();
  if (chrome && chrome.exitCode === null) { chrome.kill(); await once(chrome, "exit"); }
  await vite?.close();
  await rm(profile, { recursive: true, force: true });
  evidence.cleanedUp = true;
  await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
}
