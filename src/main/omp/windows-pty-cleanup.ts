import type { Worker } from "node:worker_threads";
import type { IPty } from "node-pty";

interface ConoutConnection {
	_worker: Pick<Worker, "threadId" | "terminate">;
}
interface ConptyAgent {
	_useConpty: boolean;
	_inSocket: { destroy(): unknown };
	_outSocket: { destroy(): unknown };
	_conoutSocketWorker: ConoutConnection;
}
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

/** Call only after node-pty's onExit, when its final output has already been consumed. */
export async function releaseWindowsConpty(pty: IPty, platform: NodeJS.Platform = process.platform): Promise<void> {
	if (platform !== "win32") return;
	// node-pty 1.1.0 exposes no public worker-disposal API. Its bundled kill path waits for
	// another data event, and natural system-ConPTY exit leaves the worker undisposed too.
	// https://github.com/microsoft/node-pty/issues/887
	// Its input socket also survives natural system-ConPTY exit: https://github.com/microsoft/node-pty/issues/947.
	// Release the JS transport after onExit; NEVER call kill again, since native double-close
	// can corrupt the heap: https://github.com/microsoft/node-pty/issues/983.
	const internal = pty as IPty & { _agent?: unknown };
	const agent = internal._agent;
	if (!record(agent) || typeof agent._useConpty !== "boolean") throw new Error("node-pty Windows agent changed; review the 1.1.0 ConPTY cleanup adapter");
	if (!agent._useConpty) return;
	const connection = agent._conoutSocketWorker;
	if (!record(agent._inSocket) || typeof agent._inSocket.destroy !== "function"
		|| !record(agent._outSocket) || typeof agent._outSocket.destroy !== "function"
		|| !record(connection) || !record(connection._worker)
		|| typeof connection._worker.threadId !== "number" || typeof connection._worker.terminate !== "function") {
		throw new Error("node-pty ConPTY transport changed; review the 1.1.0 cleanup adapter");
	}
	// The guarded private shape above belongs to the pinned node-pty implementation.
	const conpty = agent as unknown as ConptyAgent;
	const worker = conpty._conoutSocketWorker._worker;
	conpty._inSocket.destroy();
	conpty._outSocket.destroy();
	// Node's public Worker.terminate promise resolves after the worker and its ports close.
	// Calling the connection's private dispose() instead drops that promise inside a timer.
	if (worker.threadId !== -1) await worker.terminate();
}
