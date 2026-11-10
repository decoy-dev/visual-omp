import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn, type IPty } from "node-pty";
import { describe, expect, it } from "vitest";
import { initializeFixture } from "../../../../scripts/live-preview-fixture/environment.mjs";
import { TspSession } from "./session";
import { TspStream } from "./stream";
import { LoopbackRelay } from "../relay";
import { GuestClient } from "../../../renderer/src/collab/lib/client";

/** Headless PTY and production semantic editor, with an isolated HOME and loopback model only. */
describe.skipIf(!process.env.OMP_BIN)("live Continue editor shortcut", () => {
	it("interrupts and resumes, then resumes a stopped turn without appending a user message", async () => {
		const root = await mkdtemp(join(tmpdir(), "vomp-continue-live-"));
		const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
		let child: IPty | undefined;
		let exited = false;
		let protocolError: Error | undefined;
		const relay = new LoopbackRelay();
		let guest: GuestClient | undefined;
		const workingEdges: boolean[] = [];
		const provider = createServer(async (request, response) => {
			const parts: Buffer[] = [];
			for await (const part of request) parts.push(Buffer.from(part));
			requests.push(JSON.parse(Buffer.concat(parts).toString("utf8")));
			const chunk = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: `continue-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "preview", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(chunk({ role: "assistant", content: `Continue probe reply ${requests.length}.` }));
			if (requests.length >= 3) response.end(chunk({}, "stop") + "data: [DONE]\n\n");
		});
		const until = async (predicate: () => boolean | Promise<boolean>, label: string) => {
			const deadline = Date.now() + 20_000;
			while (!await predicate()) {
				if (protocolError) throw protocolError;
				if (exited || Date.now() > deadline) throw new Error(label);
				await sleep(40);
			}
		};
		try {
			const listening = Promise.withResolvers<void>();
			provider.once("error", listening.reject);
			provider.listen(0, "127.0.0.1", listening.resolve);
			await listening.promise;
			await relay.start();
			const address = provider.address();
			if (!address || typeof address === "string") throw new Error("Missing loopback port");
			const env = await initializeFixture(root, `http://127.0.0.1:${address.port}/v1`);
			const configPath = join(env.PI_CODING_AGENT_DIR, "config.yml");
			const config = JSON.parse(await readFile(configPath, "utf8"));
			await writeFile(configPath, JSON.stringify({ ...config, collab: { autoStart: "control", relayUrl: relay.url, displayName: "Continue probe" } }));
			const bin = process.env.OMP_BIN!;
			expect(execFileSync(bin, ["--version"], { env, encoding: "utf8" }).trim()).toBe("omp/18.18.6");
			const session = new TspSession({ cols: 110, dark: false, reduceMotion: true, write: data => child!.write(data), onError: error => { protocolError = error; } });
			const stream = new TspStream({ onMessage: message => session.receive(message), onData: data => {
				if (data.includes(Buffer.from("\x1b[c"))) session.terminalReply("\x1b[?62;22c");
				if (data.includes(Buffer.from("\x1b[6n"))) session.terminalReply("\x1b[1;1R");
			} });
			child = spawn(bin, ["--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--session-dir", join(root, "sessions"), "--model", "fixture/preview", "--thinking", "off"], { cwd: join(root, "work"), cols: 110, rows: 32, name: "xterm-256color", encoding: null, env: { ...env, TERM_PROGRAM: "tern" } });
			child.onData(data => stream.push(typeof data === "string" ? Buffer.from(data) : data));
			child.onExit(() => { exited = true; });
			await until(() => session.availability().available, "Editor did not become ready");
			let hosts: { instanceId: string }[] = [];
			await until(() => {
				hosts = JSON.parse(execFileSync(bin, ["collab", "list", "--json"], { env, encoding: "utf8" })).hosts;
				return hosts.length > 0;
			}, "Isolated collab host missing");
			const link = JSON.parse(execFileSync(bin, ["collab", "link", hosts[0]!.instanceId, "--json"], { env, encoding: "utf8" })).url;
			guest = new GuestClient(link, "Continue probe");
			guest.subscribe(() => {
				const working = guest!.getSnapshot().working;
				if (workingEdges.at(-1) !== working) workingEdges.push(working);
			});
			guest.connect();
			await until(() => guest!.getSnapshot().phase === "live", "Collab replica did not connect");
			const entries = async (): Promise<Array<{ type: string; message?: { role: string; content: unknown; stopReason?: string } }>> => {
				const files = await readdir(join(root, "sessions")).catch(() => []);
				const file = files.find(file => file.endsWith(".jsonl"));
				if (!file) return [];
				return (await readFile(join(root, "sessions", file), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
			};
			await session.submit("Continue the isolated probe task.");
			await until(() => requests.length === 1, "First model request missing");
			await until(() => !!guest!.getSnapshot().stream, "First assistant request did not reach collab");
			const originalTimestamp = guest.getSnapshot().stream!.timestamp;
			await session.submit(".");
			await until(() => requests.length === 2, "Running Continue did not start the next request");
			await until(() => (guest!.getSnapshot().stream?.timestamp ?? 0) > originalTimestamp, "Resumed assistant request did not advance its timestamp");
			const resumedTimestamp = guest.getSnapshot().stream!.timestamp;
			session.terminalReply("\x1b");
			await until(async () => (await entries()).filter(entry => entry.message?.stopReason === "aborted").length >= 2, "Stop did not finish the second request");
			await until(() => session.availability().available, "Stopped editor did not become ready");
			await until(() => !guest!.getSnapshot().working, "Stopped turn did not become idle in collab");
			await session.submit(".");
			await until(() => requests.length === 3, "Idle Continue did not resume the stopped turn");
			await until(async () => (await entries()).some(entry => entry.message?.stopReason === "stop"), "Continued reply did not finish");
			await until(() => !guest!.getSnapshot().working, "Continued turn did not become idle in collab");
			const saved = await entries();
			const users = saved.filter(entry => entry.message?.role === "user");
			expect(users).toHaveLength(1);
			expect(JSON.stringify(users[0]!.message!.content)).toContain("Continue the isolated probe task.");
			for (const request of requests) {
				const providerUsers = request.messages.filter(message => message.role === "user");
				// omp adds its hidden manual-continue directive to model context.
				// The shortcut itself must never become a literal user prompt.
				expect(providerUsers.some(message => message.content === "." || message.content === "c")).toBe(false);
			}
			const evidence = { version: "18.18.6", requests: requests.length, userMessages: users.length, assistantStops: saved.filter(entry => entry.message?.role === "assistant").map(entry => entry.message!.stopReason), workingEdges, originalTimestamp, resumedTimestamp, runningContinue: true, idleContinue: true, isolation: "Scratch HOME, agent, sessions and loopback provider" };
			if (process.env.VOMP_CONTINUE_EVIDENCE) await writeFile(process.env.VOMP_CONTINUE_EVIDENCE, JSON.stringify(evidence, null, 2) + "\n");
			console.log(JSON.stringify(evidence));
			await session.submit("/exit");
			await until(() => exited, "omp did not exit");
		} finally {
			guest?.close();
			relay.stop();
			if (!exited) child?.kill();
			provider.closeAllConnections();
			const closed = Promise.withResolvers<void>();
			provider.close(() => closed.resolve());
			await closed.promise;
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		}
	}, 90_000);
});
