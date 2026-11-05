import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";

interface Command { id: number; method: string; params?: { expression?: string } }
async function inspector(type: string, respond: (command: Command) => object) {
	const calls: Command[] = [];
	const server = createServer((_request, response) => {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing inspector address");
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify([{ id: type, type, url: "file:///fixture/index.html", webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/inspector` }]));
	});
	const sockets = new WebSocketServer({ server });
	sockets.on("connection", socket => socket.on("message", data => {
		const command = JSON.parse(String(data)) as Command;
		calls.push(command);
		socket.send(JSON.stringify({ id: command.id, ...respond(command) }));
	}));
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing inspector address");
	return {
		port: address.port,
		calls,
		async close() {
			for (const socket of sockets.clients) socket.terminate();
			const socketsClosed = Promise.withResolvers<void>();
			sockets.close(() => socketsClosed.resolve());
			await socketsClosed.promise;
			const serverClosed = Promise.withResolvers<void>();
			server.close(() => serverClosed.resolve());
			await serverClosed.promise;
		},
	};
}
const exec = promisify(execFile);
const script = fileURLToPath(new URL("./measure-stream.mjs", import.meta.url));

describe("stream measurement ownership boundary", () => {
	it.each([false, true])("rejects a renderer from another process before mutation or Stop, raise=%s", async raise => {
		const root = await mkdtemp(join(tmpdir(), "vomp-inspector-ownership-"));
		await writeFile(join(root, "fixture.json"), JSON.stringify({ root, baseUrl: "http://127.0.0.1:1/v1" }));
		const main = await inspector("node", command => {
			const expression = command.params?.expression ?? "";
			const value = expression.includes("process.pid")
				? { pid: process.pid, agentDir: join(root, "home", ".omp", "agent"), profile: join(root, "app-profile") }
				: { windowId: 1, visible: true, minimized: false };
			return { result: { result: { value } } };
		});
		const renderer = await inspector("page", () => ({ result: { result: { value: "different-process-challenge" } } }));
		try {
			const args = [script, "--root", root, "--port", String(renderer.port), "--main-port", String(main.port), "--output", join(root, "report.json"), ...(raise ? ["--raise"] : [])];
			const result = await exec(process.execPath, args).then(
				value => ({ ...value, code: 0 }),
				(error: { stdout: string; stderr: string; code: number }) => error,
			);
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("renderer inspector does not belong to the verified fixture process");
			expect(main.calls.some(call => call.params?.expression?.includes("webContents.executeJavaScript"))).toBe(true);
			expect(renderer.calls.map(call => [call.method, call.params?.expression])).toEqual([["Runtime.evaluate", "window.__vompStreamHarness"]]);
			expect(main.calls.some(call => /w\.(show|restore|focus)\(/.test(call.params?.expression ?? ""))).toBe(false);
			expect(JSON.parse(await readFile(join(root, "report.json"), "utf8")).samples).toEqual([]);
		} finally {
			await renderer.close();
			await main.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not stop a pre-existing turn when a verified connection fails before sending a prompt", async () => {
		const root = await mkdtemp(join(tmpdir(), "vomp-inspector-cleanup-"));
		await writeFile(join(root, "fixture.json"), JSON.stringify({ root, baseUrl: "http://127.0.0.1:1/v1" }));
		let challenge = "";
		const main = await inspector("node", command => {
			const expression = command.params?.expression ?? "";
			if (expression.includes("process.pid")) return { result: { result: { value: { pid: process.pid, agentDir: join(root, "home", ".omp", "agent"), profile: join(root, "app-profile") } } } };
			challenge = expression.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/)?.[0] ?? "";
			return { result: { result: { value: { windowId: 1, visible: true, minimized: false } } } };
		});
		const renderer = await inspector("page", command => command.method === "Runtime.evaluate"
			? { result: { result: { value: challenge } } }
			: { error: { message: "fixture inspector failed before prompt" } });
		try {
			const result = await exec(process.execPath, [script, "--root", root, "--port", String(renderer.port), "--main-port", String(main.port), "--output", join(root, "report.json")]).then(
				value => ({ ...value, code: 0 }),
				(error: { stdout: string; stderr: string; code: number }) => error,
			);
			expect(result.stderr).toContain("fixture inspector failed before prompt");
			expect(renderer.calls.map(call => call.method)).toEqual(["Runtime.evaluate", "Performance.enable"]);
			expect(renderer.calls.some(call => call.params?.expression?.includes("Stop reply"))).toBe(false);
		} finally {
			await renderer.close();
			await main.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
