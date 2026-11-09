import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const argument = name => process.argv[process.argv.indexOf(name) + 1];
const backend = argument('--backend');
assert.match(backend, /^http:\/\/127\.0\.0\.1:\d+$/);
const output = resolve(argument('--output'));
const checkout = resolve(import.meta.dirname, '../../..');
const profile = await mkdtemp(join(tmpdir(), 'vomp-rollback-chrome-'));
const evidence = { startedAt: new Date().toISOString(), screenshots: [], flows: [], errors: [], limits: ['Headless Chrome with fixture Electron IPC. The main update handlers, local feed, filesystem downloads, SHA-256 verification and preference writes are production code.', 'Finder and Explorer reveal are recorded at the Electron shell boundary. No installer or package-manager command runs. Scoop UI uses fixture Windows platform data on macOS; native Windows acceptance remains required.'] };
let vite, chrome, socket;
async function post(route, input = {}) {
  const result = await fetch(backend + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }).then(response => response.json());
  if (result.error) throw Error(result.error);
  return result.value;
}
try {
  vite = await createServer({ configFile: false, root: join(checkout, 'src/renderer'), cacheDir: join(profile, 'vite-cache'), plugins: [react(), tailwindcss()], resolve: { alias: { '@shared': join(checkout, 'src/shared'), '@': join(checkout, 'src/renderer/src'), '@oh-my-pi/pi-wire': join(checkout, 'src/renderer/src/collab/wire/index.ts'), '@oh-my-pi/pi-utils/marked': 'marked', '@oh-my-pi/pi-utils/math-delimiters': join(checkout, 'src/renderer/src/collab/math-delimiters.ts') } }, server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [checkout, await realpath(join(checkout, 'node_modules'))] } } });
  await vite.listen();
  chrome = spawn(process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const ready = Promise.withResolvers();
  let chromeLog = '';
  chrome.once('error', ready.reject);
  chrome.stderr.on('data', bytes => { chromeLog += bytes; const match = chromeLog.match(/DevTools listening on (ws:\/\/\S+)/); if (match) ready.resolve(new URL(match[1])); });
  const deadline = setTimeout(() => ready.reject(Error('Chrome startup timed out')), 20000);
  const endpoint = await ready.promise.finally(() => clearTimeout(deadline));
  const target = await fetch(`http://${endpoint.host}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, 'open');
  let sequence = 0;
  const pending = new Map();
  socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    if (message.method === 'Runtime.exceptionThrown') evidence.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
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
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async expression => {
    const timeout = Date.now() + 30000;
    while (!await evaluate(expression)) {
      if (evidence.errors.length) throw Error(evidence.errors.at(-1));
      if (Date.now() > timeout) {
        evidence.dom = await evaluate('document.body.innerText');
        evidence.unhandled = await evaluate('[...window.__speedUnhandled]');
        evidence.updateState = await evaluate(`import('/src/features/onboarding/updates.tsx').then(m => m.useUpdates.getState())`);
        await writeFile(join(output, 'failure.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
        throw Error(`Timed out: ${expression}`);
      }
      await sleep(50);
    }
  };
  const button = label => `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)} && b.getClientRects().length)`;
  const click = async label => { await until(`!!(${button(label)})`); await evaluate(`(${button(label)}).click()`); };
  const capture = async name => {
    await evaluate('document.fonts.ready'); await sleep(180);
    const path = join(output, name + '.png');
    await writeFile(path, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    evidence.screenshots.push(path);
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const basePreload = await readFile(join(checkout, 'scripts/dev/speed/preload.js'), 'utf8');
  let preloadId;
  async function load(method, theme, extra = {}) {
    const { root } = await post('/fixture', { method, ...extra });
    if (preloadId) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: preloadId });
    const source = `window.__speedScenario=${JSON.stringify({ root, projectPath: root, tabs: [], entries: [], light: [] })};\n${basePreload}\n(() => {
      const backend = ${JSON.stringify(backend)};
      const theme = ${JSON.stringify(theme)};
      const listeners = new Map();
      const invoke = window.vomp.invoke;
      window.vomp.platform = ${JSON.stringify(method === 'scoop' ? 'win32' : 'darwin')};
      window.vomp.on = (channel, callback) => { const set = listeners.get(channel) || new Set(); listeners.set(channel, set); set.add(callback); return () => set.delete(callback); };
      let cursor = 0;
      setInterval(async () => {
        const result = await fetch(backend + '/events?from=' + cursor).then(r => r.json()); cursor = result.next;
        for (const event of result.events) {
          if (!event.channel.startsWith('updates:app')) continue;
          for (const callback of listeners.get(event.channel) || []) callback(event.value);
        }
      }, 40);
      window.vomp.invoke = async (channel, ...args) => {
        if (channel.startsWith('updates:app:')) {
          const result = await fetch(backend + '/invoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, args }) }).then(r => r.json());
          if (result.error) throw Error(result.error); return result.value;
        }
        if (channel === 'updates:omp:check') return { currentVersion: '18.18.3', latestVersion: '18.18.3', updateAvailable: false, channel: 'stable', checkedAt: Date.now(), fromCache: false, error: null };
        if (channel === 'updates:omp:installed') return null;
        if (channel === 'updates:app:operation') return null;
        if (channel === 'sessions:projects' || channel === 'sessions:recent' || channel === 'sessions:list') return [];
        if (channel === 'app:info') return { version: '0.7.12', platform: window.vomp.platform, homePath: ${JSON.stringify(root)}, defaultChatFolder: ${JSON.stringify(root)}, isDev: true };
        if (channel === 'omp:status') return { found: true, supported: true, version: '18.18.3', path: '/fixture/omp' };
        if (channel === 'app:prefs:get') { const prefs = await invoke(channel); return { ...prefs, theme, reducedMotion: 'on' }; }
        return invoke(channel, ...args);
      };
      localStorage.clear();
    })();`;
    preloadId = (await send('Page.addScriptToEvaluateOnNewDocument', { source })).identifier;
    await send('Page.navigate', { url: vite.resolvedUrls.local[0] });
    await until(`document.documentElement.dataset.theme === ${JSON.stringify(theme)} && !!document.querySelector('[data-setup-shell]')`);
    await evaluate(`(async () => { const { openSettings } = await import('/src/state/navigation.ts'); openSettings('about'); })()`);
    await until(`!!(${button('Roll back…')}) && !(${button('Roll back…')}).disabled`);
  }
  for (const method of ['dmg', 'brew', 'scoop']) for (const theme of ['light', 'dark']) {
    await load(method, theme);
    await until(`!!(${button('Roll back to v0.7.11')})`);
    await capture(`${method}-${theme}-after-update`);
    await click('Roll back to v0.7.11');
    await until(`document.querySelector('#release-notes-version')?.textContent.includes('0.7.11')`);
    await capture(`${method}-${theme}-past-versions`);
    await click('Close');
    await until(`!document.querySelector('[role="dialog"]')`);
    await capture(`${method}-${theme}-about`);
    await click('Roll back…');
    await until(`document.querySelector('#release-notes-version')?.textContent.includes('0.7.11')`);
    if (method === 'dmg') continue;
    await click('Download v0.7.11 installer');
    await until(`document.querySelector('[role="dialog"]')?.textContent.includes('Install visual-omp v0.7.11?')`);
    assert.equal(await evaluate(`document.activeElement?.textContent`), 'Cancel');
    await click('Download v0.7.11 installer');
    await until(`document.querySelector('[role="dialog"]')?.textContent.includes('verified')`);
    const state = await post('/snapshot');
    assert.equal(state.boundary, '0.7.12'); assert.equal(state.persistedBoundary, '0.7.12');
    assert.equal(state.opened.length, 0); assert.equal(state.revealed.length, 1); assert.equal(state.download.state, 'done');
    await capture(`${method}-${theme}-downloaded`);
  }
  for (const theme of ['light', 'dark']) {
    await load('scoop', theme, { global: true, retained: true });
    await click('Roll back…');
    await until(`document.querySelector('[role="dialog"]')?.textContent.includes('scoop reset visual-omp@0.7.11 --global')`);
    await capture(`scoop-global-retained-${theme}-past-versions`);
  }
  // The same main-process handlers serve these checks. Renderer code cannot provide a download URL.
  for (const scenario of [
    { name: 'brew-success', method: 'brew', previousSkip: null },
    { name: 'scoop-existing-boundary', method: 'scoop', previousSkip: '0.8.0' },
    { name: 'missing-published-digest', method: 'brew', previousSkip: '0.8.0', failure: 'digest' },
    { name: 'checksum-restores-boundary', method: 'brew', previousSkip: null, failure: 'checksum' },
  ]) {
    await post('/fixture', scenario);
    let rejected = '';
    try { await post('/invoke', { channel: 'updates:app:download', args: ['0.7.11', true] }); } catch (error) { rejected = String(error); }
    if (scenario.failure === 'digest') assert.match(rejected, /published SHA-256/);
    else {
      assert.equal(rejected, '');
      const timeout = Date.now() + 10000;
      while (!['done', 'failed'].includes((await post('/snapshot')).download?.state)) {
        assert.ok(Date.now() < timeout, 'Main must publish a terminal download state.');
        await sleep(30);
      }
    }
    const state = await post('/snapshot');
    const boundary = scenario.failure ? scenario.previousSkip : scenario.previousSkip ?? '0.7.12';
    assert.equal(state.boundary, boundary); assert.equal(state.persistedBoundary, boundary); assert.deepEqual(state.opened, []);
    if (scenario.failure) assert.deepEqual(state.revealed, []);
    else {
      assert.equal(state.revealed.length, 1);
      assert.equal(await readFile(state.revealed[0], 'utf8'), 'Local rollback installer fixture. This file must never be executed.\n');
      await assert.rejects(post('/invoke', { channel: 'updates:app:runInstaller', args: [] }), /manual installation/);
    }
    if (scenario.failure === 'checksum') {
      assert.match(state.download.error, /checksum did not match/);
      assert.ok(state.boundaryHistory.includes('0.7.12'));
      assert.equal(state.boundaryHistory.at(-1), null);
    }
    evidence.flows.push({ ...scenario, result: 'passed', state, rejected });
  }
  assert.deepEqual(evidence.errors, []);
  console.log(`Saved ${evidence.screenshots.length} screenshots and ${evidence.flows.length} passing flows.`);
} catch (error) {
  evidence.failure = String(error); throw error;
} finally {
  await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
  socket?.close();
  if (chrome && chrome.exitCode === null) { chrome.kill(); await once(chrome, 'exit'); }
  await vite?.close(); await rm(profile, { recursive: true, force: true });
}
