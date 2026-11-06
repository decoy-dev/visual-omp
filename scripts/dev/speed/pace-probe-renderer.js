// Served only by the probe's private Vite plugin; never imported by the app.
import { controllerFor, useApp } from '/src/state/app.ts';
const scope = window;
let session;
let start = 0;
let lastFrame = 0;
let lastLength = 0;
let lastChange = 0;
let active = false;
let rows = [];
let frames = [];
let changes = [];
let collab = [];
let current = null;
const tailRange = document.createRange();
function lastText(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent.trim() ? node : null;
  for (let child = node.lastChild; child; child = child.previousSibling) {
    const found = lastText(child);
    if (found) return found;
  }
  return null;
}
function countText() {
  // data-streaming is on the actual paced text block, not the hidden TSP document.
  const element = document.querySelector('[role="log"] [data-streaming]');
  if (!element) return { chars: lastLength, mounted: false, inViewport: false };
  const chars = element.textContent.length;
  if (chars === lastLength) return { chars, mounted: true, inViewport: current?.inViewport ?? false };
  const tail = lastText(element);
  if (!tail) return { chars, mounted: true, inViewport: false };
  const end = tail.textContent.trimEnd().length;
  tailRange.setStart(tail, end - 1);
  tailRange.setEnd(tail, end);
  const rect = tailRange.getBoundingClientRect();
  const logRect = element.closest('[role="log"]').getBoundingClientRect();
  return { chars, mounted: true, inViewport: rect.bottom > Math.max(logRect.top, 0) && rect.top < Math.min(logRect.bottom, innerHeight) && rect.width > 0 && rect.height > 0 };
}
function tick(now) {
  if (active) {
    const sample = countText();
    frames.push({ at: now - start, ms: now - lastFrame });
    if (sample.chars !== lastLength) {
      changes.push({ at: now - start, gapMs: lastChange ? now - lastChange : null, delta: sample.chars - lastLength, chars: sample.chars, inViewport: sample.inViewport });
      lastChange = now;
      lastLength = sample.chars;
    }
    current = { at: now - start, ...sample, visibility: document.visibilityState };
    const second = Math.floor((now - start) / 1000);
    rows[second] = { ...current, second };
    lastFrame = now;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
scope.__pace = {
  collab(frame) { if (active) collab.push({ at: performance.now() - start, kind: frame.t === 'event' ? frame.event.type : frame.t === 'bus' ? frame.channel : frame.t }); },
  async attach(host) {
    session = controllerFor('speed-heavy');
    if (!session) throw Error('Isolated probe tab is missing');
    session.attach(host);
    useApp.getState().activateTab('speed-heavy');
  },
  state() { const view = session?.getSnapshot(); return { mode: view?.mode, guest: view?.guest?.phase, working: view?.guest?.working, hasGuest: !!session?.guestClient() }; },
  reset() { rows = []; frames = []; changes = []; collab = []; current = null; start = lastFrame = performance.now(); lastLength = lastChange = 0; active = true; },
  read() { return { wallMs: performance.now() - start, rows, frames, changes, collab, current }; },
  stop() { active = false; },
};
