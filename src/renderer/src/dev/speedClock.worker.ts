// Opt-in speed replay producer. It is outside the application's production import graph.
export {};
interface ClockOptions { streamMs: number; helperMs: number; appendMs: number; streamForMs: number }
const clock = self as unknown as { onmessage: ((event: MessageEvent<ClockOptions>) => void) | null; postMessage(value: unknown): void };
clock.onmessage = event => {
  let sequence = 0;
  const send = (kind: string) => clock.postMessage({ kind, sequence: ++sequence, sentAt: performance.timeOrigin + performance.now() });
  const stream = setInterval(() => send('stream'), event.data.streamMs);
  setTimeout(() => { clearInterval(stream); send('stream-source-end'); }, event.data.streamForMs);
  setInterval(() => send('helper'), event.data.helperMs);
  setInterval(() => send('append'), event.data.appendMs);
};
clock.postMessage({ kind: 'ready' });
