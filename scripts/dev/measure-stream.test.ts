import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";
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
		if (command.method === "Page.reload") socket.send(JSON.stringify({ method: "Page.loadEventFired" }));
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

async function readinessProbe(prompt: string, marker: string, timeoutAt?: "log" | "reply", home = false) {
	const root = await mkdtemp(join(tmpdir(), "vomp-stream-readiness-"));
	await writeFile(join(root, "fixture.json"), JSON.stringify({ root, baseUrl: "http://127.0.0.1:1/v1" }));
	const dom = new Window();
	const document = dom.document;
	const composerMarkup = '<div data-tour="composer"><textarea></textarea><button aria-label="Send message"></button></div>';
	const loading = '<div data-transcript-frame="loading"></div>';
	document.body.innerHTML = `<div inert data-chat-column><textarea></textarea><div role="log"><div class="tr-md"></div></div></div>${home ? `<div id="home">${composerMarkup}</div>` : `<div data-chat-column id="chat">${composerMarkup}${loading}</div>`}<div data-chat-column><div role="log"><div class="tr-md"></div></div></div>`;
	for (const element of document.querySelectorAll(".tr-md")) element.textContent = marker;
	let chat = document.querySelector("#chat")!;
	const start = document.querySelector(home ? "#home" : "#chat")!;
	start.querySelector("button")!.addEventListener("click", () => {
		if (home) {
			// Sending from Home replaces its composer with a newly mounted chat column.
			chat = document.createElement("div");
			chat.id = "chat";
			chat.setAttribute("data-chat-column", "");
			chat.innerHTML = composerMarkup + loading;
			start.replaceWith(chat);
		}
		chat.querySelector("button")!.setAttribute("aria-label", "Stop reply");
		chat.querySelector("textarea")!.value = marker;
	});
	Object.defineProperty(document, "visibilityState", { value: "visible" });
	// The DOM fixture has no layout engine. Explicitly model absent layout separately from visibility.
	const originalRects = Object.getOwnPropertyDescriptor(dom.HTMLElement.prototype, "getClientRects");
	Object.defineProperty(dom.HTMLElement.prototype, "getClientRects", {
		configurable: true,
		value(this: HTMLElement) { return this.isConnected && !this.closest("[data-no-layout]") ? [{}] : []; },
	});
	const context = {
		window: Object.assign(dom, { vomp: { invoke: () => undefined }, __vompStreamHarness: "" }),
		document,
		HTMLTextAreaElement: dom.HTMLTextAreaElement,
		Event: dom.Event,
		// happy-dom omits the browser's default visibility value when no stylesheet declares it.
		getComputedStyle: (element: Parameters<typeof dom.getComputedStyle>[0]) => ({ visibility: dom.getComputedStyle(element).visibility || "visible" }),
	};
	let logPolls = 0;
	let replyPolls = 0;
	let ready = false;
	let sampled = false;
	const main = await inspector("node", command => {
		const expression = command.params?.expression ?? "";
		if (expression.includes("process.pid")) return { result: { result: { value: { pid: process.pid, agentDir: join(root, "home", ".omp", "agent"), profile: join(root, "app-profile") } } } };
		const challenge = expression.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/)?.[0];
		if (challenge) context.window.__vompStreamHarness = challenge;
		return { result: { result: { value: { windowId: 1, visible: true, minimized: false } } } };
	});
	const renderer = await inspector("page", command => {
		if (command.method === "Performance.getMetrics") {
			sampled = true;
			return { error: { message: ready ? "sampling reached after readiness" : "sampling started before readiness" } };
		}
		if (command.method !== "Runtime.evaluate") return { result: {} };
		const expression = command.params?.expression ?? "";
		if (expression.startsWith("(el =>") && expression.includes('[role="log"]')) {
			logPolls++;
			if (!timeoutAt || timeoutAt === "reply") {
				if (logPolls === 2) chat.insertAdjacentHTML("beforeend", '<div role="log" hidden></div>');
				if (logPolls === 3) chat.querySelector('[role="log"]')!.removeAttribute("hidden");
			}
		}
		if (expression.includes("log.querySelectorAll('.tr-md')")) {
			replyPolls++;
			const log = chat.querySelector('[role="log"]')!;
			// Composer text, user text, another column, and non-rendered replies must all fail.
			log.innerHTML = "<p></p>";
			log.querySelector("p")!.textContent = marker;
			if (replyPolls >= 2 && timeoutAt !== "reply") {
				const wrapper = document.createElement("div");
				wrapper.innerHTML = '<div class="tr-md"></div>';
				wrapper.querySelector(".tr-md")!.textContent = replyPolls === 7 ? marker.slice(0, -1) : marker;
				if (replyPolls === 2) wrapper.hidden = true;
				if (replyPolls === 3) wrapper.setAttribute("inert", "");
				if (replyPolls === 4) wrapper.setAttribute("aria-hidden", "true");
				if (replyPolls === 5) wrapper.style.visibility = "hidden";
				if (replyPolls === 6) wrapper.setAttribute("data-no-layout", "");
				log.append(wrapper);
				ready = replyPolls >= 8;
			}
		}
		try {
			const value = runInNewContext(expression, context);
			return { result: { result: { value } } };
		} catch (error) {
			return { result: { exceptionDetails: { text: String(error) } } };
		}
	});
	try {
		const clock = join(root, "clock.mjs");
		if (timeoutAt) await writeFile(clock, "const now = Date.now; let tick = 0; Date.now = () => now() + tick++ * 10000;\n");
		const result = await exec(process.execPath, [
			...(timeoutAt ? ["--import", pathToFileURL(clock).href] : []),
			script, "--root", root, "--port", String(renderer.port), "--main-port", String(main.port),
			"--prompt", prompt, "--output", join(root, "report.json"),
		]).then(
			value => ({ ...value, code: 0 }),
			(error: { stdout: string; stderr: string; code: number }) => error,
		);
		return { result, logPolls, replyPolls, sampled, report: JSON.parse(await readFile(join(root, "report.json"), "utf8")) };
	} finally {
		await renderer.close();
		await main.close();
		if (originalRects) Object.defineProperty(dom.HTMLElement.prototype, "getClientRects", originalRects);
		else Reflect.deleteProperty(dom.HTMLElement.prototype, "getClientRects");
		await dom.happyDOM.close();
		await rm(root, { recursive: true, force: true });
	}
}

describe("stream measurement transcript readiness", () => {
	it.each([
		["stress text", "the quick brown fox jumps over 0"],
		["stress tools", "Round 1: listing numbers."],
		["finish", "Done."],
	])("waits for the visible chat log and rendered fixture assistant output for %s", async (prompt, marker) => {
		const { result, logPolls, replyPolls, sampled, report } = await readinessProbe(prompt, marker);
		expect(result.stderr).toContain("sampling reached after readiness");
		expect(logPolls).toBe(3);
		expect(replyPolls).toBe(8);
		expect(sampled).toBe(true);
		expect(report.samples).toEqual([]);
	});

	it("follows the Home composer into its newly created visible chat", async () => {
		const { result, logPolls, replyPolls, sampled } = await readinessProbe("stress text", "the quick brown fox jumps over 0", undefined, true);
		expect(result.stderr).toContain("sampling reached after readiness");
		expect(logPolls).toBe(3);
		expect(replyPolls).toBe(8);
		expect(sampled).toBe(true);
	});

	it.each(["log", "reply"] as const)("fails without sampling when the visible transcript %s never becomes ready", async timeoutAt => {
		const { result, sampled, report } = await readinessProbe("stress text", "the quick brown fox jumps over 0", timeoutAt);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain(`Timed out waiting for ${timeoutAt === "log" ? "mounted visible transcript log" : "rendered fixture assistant reply"}.`);
		expect(sampled).toBe(false);
		expect(report.samples).toEqual([]);
	});
});
