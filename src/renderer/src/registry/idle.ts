/**
 * Idle-time loading of split chunks (lazy views, KaTeX). Startup work settles first; then queued loads run
 * one per idle period, so a surface opened later is normally loaded already. No imports, so any module
 * can queue a load while the module graph is still evaluating.
 */

type Loader = () => Promise<unknown>;

/** Startup work (first paint, restoring chats) settles before idle loading begins. */
const IDLE_START_MS = 1500;
const queue: Loader[] = [];
let scheduled = false;
let ready = false;
let running = false;

function pump(): void {
	if (!ready || running) return;
	const next = queue.shift();
	if (!next) return;
	running = true;
	const run = () => {
		void next()
			.catch(() => undefined)
			.finally(() => {
				running = false;
				pump();
			});
	};
	if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 3000 });
	else setTimeout(run, 0);
}

/** Loads `load` in an idle period after startup; queued loads run one at a time, in order. */
export function preloadWhenIdle(load: Loader): void {
	if (!scheduled) {
		scheduled = true;
		setTimeout(() => {
			ready = true;
			pump();
		}, IDLE_START_MS);
	}
	queue.push(load);
	pump();
}
