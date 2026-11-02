import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { WebSocket } from "ws";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TspSession } from "../session";
import { hookQuestions } from "@shared/tsp/question-match";
import { openOverlay, walkNodes } from "@shared/tsp/view-state";
import { plain } from "../../../../renderer/src/features/tsp/labels";
import type { TspHostSnapshot } from "@shared/tsp-host";

const root = resolve(import.meta.dirname, "../../../../..");
const chrome = process.env.CHROME_BIN ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
const fixtures = resolve(root, "src/main/omp/tsp/fixtures/18.14.0");
const CdpMessage = z.object({ id: z.number().optional(), result: z.unknown().optional(), error: z.object({ message: z.string() }).optional() });
interface AxTree { nodes: { role?: { value: string }; name?: { value: string }; properties?: { name: string; value: { value: unknown } }[] }[] }
interface Evaluation { result: { value: unknown }; exceptionDetails?: { text: string; exception?: { description: string } } }

/** Small CDP client so this gate uses the already-installed Chrome without another browser package. */
class ChromePage {
	#id = 0;
	#pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
	constructor(private socket: WebSocket) {
		socket.on("message", raw => {
			try {
				const message = CdpMessage.parse(JSON.parse(String(raw)));
				const pending = message.id === undefined ? undefined : this.#pending.get(message.id);
				if (!pending) return;
				clearTimeout(pending.timer);
				this.#pending.delete(message.id!);
				if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
			} catch (error) { this.#fail(error instanceof Error ? error : new Error(String(error))); }
		});
		socket.on("close", () => this.#fail(new Error("Chrome CDP connection closed.")));
		socket.on("error", error => this.#fail(error));
	}
	#fail(error: Error): void {
		for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
		this.#pending.clear();
	}
	send<T = unknown>(method: string, params: object = {}): Promise<T> {
		if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Chrome CDP connection is not open."));
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const id = ++this.#id;
		const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`Chrome CDP ${method} timed out.`)); }, 5_000);
		this.#pending.set(id, { resolve, reject, timer });
		this.socket.send(JSON.stringify({ id, method, params }), error => { if (error) this.#fail(error); });
		// Each call supplies the response shape from Chrome's documented DevTools method.
		return promise as Promise<T>;
	}
	async evaluate<T = unknown>(expression: string): Promise<T> {
		const result = await this.send<Evaluation>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
		return result.result.value as T;
	}
	async until(expression: string): Promise<void> {
		const deadline = Date.now() + 20_000;
		// Chrome runs out of process; fake timers cannot drive its render or focus lifecycle.
		while (!await this.evaluate(expression)) { if (Date.now() > deadline) throw new Error(`Chrome timed out: ${expression}`); await delay(25); }
	}
	close() { this.#fail(new Error("Chrome CDP client closed.")); this.socket.close(); }
}

async function stopChrome(child: ChildProcess | undefined): Promise<void> {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit").then(() => true);
	child.kill();
	if (await Promise.race([exited, delay(2_000, false)])) return;
	child.kill("SIGKILL");
	if (!await Promise.race([exited, delay(2_000, false)])) throw new Error("Chrome did not stop after SIGKILL.");
}

async function recorded(name: string, idle = false): Promise<TspHostSnapshot> {
	const session = new TspSession({ cols: 100, dark: false, reduceMotion: true, write: () => {}, onError: error => { throw error; } });
	for (const line of (await readFile(join(fixtures, `${name}.messages.jsonl`), "utf8")).trim().split("\n")) {
		const message = z.object({ verb: z.string(), body: z.unknown() }).parse(JSON.parse(line));
		session.receive({ verb: message.verb, params: {}, body: JSON.stringify(message.body) });
		const snapshot = session.snapshot();
		const nodes = snapshot.surfaces.flatMap(surface => [...walkNodes(surface.document)]);
		const shown = idle ? nodes.some(node => node.k === "editor" && node.p?.sendable)
			: name === "settings-screen" ? nodes.some(node => node.k === "prefs")
			: name === "usage" ? nodes.some(node => JSON.stringify(node.p ?? {}).includes("No usage data available."))
			: !!openOverlay(snapshot.surfaces);
		if (message.verb !== "f" || !shown) continue;
		await session.drain();
		return { ...snapshot, hostId: "gate", generation: 1, revision: 1, lifecycle: "live", documentGeneration: 1, failure: null, availability: { available: false, reason: "Menu open" }, questionMatches: hookQuestions(snapshot.surfaces, 1).map(hook => ({ surfaceId: hook.surfaceId, nodeId: hook.nodeId, status: "unmatched" })), surfaces: snapshot.surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) };
	}
	throw new Error(`No recorded screen in ${name}`);
}

describe.skipIf(process.env.TSP_UI_GATE !== "1")("recorded omp screen in headless Chrome", () => {
	let vite: ViteDevServer;
	let child: ChildProcess;
	let profile: string;
	let page: ChromePage;
	let shots: string;
	beforeAll(async () => {
		if (!existsSync(chrome)) throw new Error(`Chrome is required for TSP_UI_GATE=1. Set CHROME_BIN to its executable: ${chrome}`);
		shots = process.env.TSP_GATE_SHOTS ?? await mkdtemp(join(tmpdir(), "visual-omp-tsp-gate-shots-"));
		profile = await mkdtemp(join(tmpdir(), "vomp-chrome-gate-"));
		await mkdir(shots, { recursive: true });
		vite = await createServer({ configFile: false, root, cacheDir: join(profile, "vite-cache"), plugins: [react(), tailwindcss()], resolve: { alias: { "@shared": resolve(root, "src/shared"), "@": resolve(root, "src/renderer/src"), "@oh-my-pi/pi-wire": resolve(root, "src/renderer/src/collab/wire/index.ts"), "@oh-my-pi/pi-utils/marked": "marked", "@oh-my-pi/pi-utils/math-delimiters": resolve(root, "src/renderer/src/collab/math-delimiters.ts") } }, server: { host: "127.0.0.1", port: 0, hmr: false, fs: { allow: [root, realpathSync(resolve(root, "node_modules"))] } } });
		await vite.listen();
		child = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
		const started = Promise.withResolvers<string>();
		let output = "";
		// The deadline guards a real subprocess; fake timers cannot start Chrome.
		const timer = setTimeout(() => started.reject(new Error(`Chrome did not start: ${output}`)), 20_000);
		child.once("error", error => { clearTimeout(timer); started.reject(error); });
		child.stderr!.on("data", bytes => { output += String(bytes); const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); started.resolve(match[1]!); } });
		const endpoint = await started.promise;
		const base = new URL(endpoint);
		const target = z.object({ webSocketDebuggerUrl: z.string() }).parse(await fetch(`http://${base.host}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(5_000) }).then(response => response.json()));
		const socket = new WebSocket(target.webSocketDebuggerUrl, { handshakeTimeout: 5_000 }); await once(socket, "open");
		page = new ChromePage(socket);
		await page.send("Page.enable");
		await page.send("Emulation.setDeviceMetricsOverride", { width: 960, height: 620, deviceScaleFactor: 1, mobile: false });
		await page.send("Page.navigate", { url: `${vite.resolvedUrls!.local[0]}src/renderer/src/features/tsp/testing/gate.html` });
		await page.until("!!window.gate");
	}, 60_000);
	afterAll(async () => {
		try { page?.close(); await stopChrome(child); }
		finally {
			try { await vite?.close(); }
			finally { if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
		}
	});

	async function open(snapshot: TspHostSnapshot, theme = "light", scale = 100, reduced = true) {
		await page.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; document.documentElement.dataset.motion=${JSON.stringify(reduced ? "reduced" : "full")}; document.documentElement.style.fontSize=${JSON.stringify(`${scale}%`)}; window.gate.open(${JSON.stringify(snapshot)});`);
		await page.until("!!document.querySelector('.tsp-screen') && document.querySelector('.tsp-screen').contains(document.activeElement)");
		await page.evaluate("document.fonts.ready.then(() => true)");
		await page.until("(document.querySelector('.vo-sheet')?.getBoundingClientRect().bottom ?? Infinity) <= innerHeight");
		await page.until("!!document.querySelector('.vo-sheet') && document.querySelector('.vo-sheet').getAnimations().every(animation => animation.playState === 'finished')");
	}
	async function close() {
		await page.evaluate("document.querySelector('.vo-sheet button[aria-label=Close]').click()");
		await page.until("!document.querySelector('.vo-sheet') && document.activeElement?.getAttribute('aria-label') === 'Message to omp'");
	}

	it("exposes recorded lists and selection in Chrome's accessibility tree and returns focus to the composer", async () => {
		for (const name of ["model-picker", "hook-select", "tree-open"]) {
			await open(await recorded(name));
			const tree = await page.send<AxTree>("Accessibility.getFullAXTree");
			expect(tree.nodes.some(node => node.role?.value === "listbox")).toBe(true);
			expect(tree.nodes.filter(node => node.role?.value === "option").some(node => node.properties?.some(property => property.name === "selected" && property.value.value === true))).toBe(true);
			await page.evaluate("document.querySelector('[role=listbox]').focus()");
			await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "End", code: "End" });
			await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "End", code: "End" });
			await page.until("document.querySelector('[role=listbox]').getAttribute('aria-activedescendant') === [...document.querySelectorAll('[role=option][aria-disabled=false]')].at(-1)?.id");
			await close();
		}
		const hotkeys = await recorded("hotkeys");
		await open(hotkeys);
		const expectedHeads = hotkeys.surfaces.flatMap(surface => [...walkNodes(surface.document)]).filter(node => node.k === "overlay").map(node => plain(node.p?.head) || "omp screen");
		const headings = await page.evaluate<string[]>("[...document.querySelectorAll('[data-tsp-kind=overlay] > [role=dialog]')].map(node => node.getAttribute('aria-label'))");
		expect(headings.length).toBeGreaterThan(0);
		expect(headings).toEqual(expectedHeads);
		const tree = await page.send<AxTree>("Accessibility.getFullAXTree");
		for (const head of expectedHeads) expect(tree.nodes.some(node => node.role?.value === "dialog" && node.name?.value === head)).toBe(true);
		await close();
	}, 60_000);

	it("explains an idle recorded screen without losing its outline or focus target", async () => {
		await open(await recorded("model-picker", true));
		expect(await page.evaluate("document.querySelector('.tsp-screen [role=status]').textContent")).toContain("omp is not showing a menu.");
		expect(await page.evaluate("document.querySelector('.tsp-screen [role=status]').textContent")).toContain("Type a / command");
		expect(await page.evaluate("document.querySelector('.tsp-screen summary').textContent")).toBe("Show raw outline");
		expect(await page.evaluate("document.querySelector('.vo-sheet header').textContent")).not.toContain("Escape dismisses");
		expect(await page.evaluate("document.querySelector('.vo-sheet header').textContent")).toContain("View omp menus and settings for this chat.");
		const capture = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(shots, "idle-light-100.png"), Buffer.from(capture.data, "base64"));
		await close();
	});

	it.each(["light", "dark"])("fits recorded menus at minimum size with normal and enlarged text in %s, including reduced motion", async theme => {
		for (const scale of [100, 130]) for (const name of ["model-picker", "settings-screen", "hook-select", "jobs", "usage", "session", "hotkeys", "changelog", "tools", "tree-open"]) {
			const snapshot = await recorded(name);
			await open(snapshot, theme, scale, scale === 130);
			const overflow = await page.evaluate("({ body: document.body.scrollWidth > innerWidth, screen: document.querySelector('.tsp-screen').scrollWidth > document.querySelector('.tsp-screen').clientWidth + 1 })");
			expect(overflow, `${name} ${theme} ${scale}`).toEqual({ body: false, screen: false });
			expect(await page.evaluate("[...document.querySelectorAll('.vo-sheet header button')].every(button => { const b = button.getBoundingClientRect(); const s = document.querySelector('.vo-sheet').getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.left >= s.left && b.right <= s.right && b.top >= s.top && b.bottom <= s.bottom; })")).toBe(true);
			expect(await page.evaluate("[...document.querySelectorAll('[data-tsp-kind=picker] .sticky')].every(row => getComputedStyle(row).flexWrap === 'wrap')")).toBe(true);
			if (name === "changelog") {
				expect(await page.evaluate("(() => { const screen = document.querySelector('.tsp-screen'); screen.scrollTop = screen.scrollHeight; return screen.scrollTop > 0 && document.body.scrollTop === 0 && screen.scrollHeight > screen.clientHeight; })()")).toBe(true);
			}
			const expectedActions = [...new Set(snapshot.surfaces.flatMap(surface => [...walkNodes(surface.document)]).flatMap(node => node.k === "picker" ? node.p?.actions?.map(action => action.label) ?? [] : []))];
			const labels = await page.evaluate<string[]>("[...document.querySelectorAll('.tsp-screen button')].map(button => button.textContent.trim())");
			for (const label of expectedActions) expect(labels, `${name} expected action ${label}`).toContain(label);
			if (["model-picker", "hook-select", "tree-open"].includes(name)) expect(expectedActions.length).toBeGreaterThan(0);
			const buttons = await page.evaluate<number>("document.querySelector('.tsp-screen').querySelectorAll('button').length");
			for (let index = 0; index < buttons; index++) {
				const visible = await page.evaluate(`window.gate.buttonVisible(document.querySelector('.tsp-screen').querySelectorAll('button')[${index}])`);
				expect(visible, `${name} action ${index} ${theme} ${scale}`).toBe(true);
			}
			await page.evaluate("document.querySelector('.tsp-screen').scrollTop=0");
			if (name === "hook-select") {
				const long = await page.evaluate<{ text: string; title: string; wraps: boolean }>("(() => { const option = [...document.querySelectorAll('[role=option]')].find(node => node.textContent.includes('A long fixture option')); return { text: option.textContent, title: option.title, wraps: option.scrollWidth <= option.clientWidth + 1 }; })()");
				expect(long.text).toContain("text size is increased"); expect(long.wraps || long.title.includes("text size is increased")).toBe(true);
			}
			const capture = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
			await writeFile(join(shots, `${name}-${theme}-${scale}.png`), Buffer.from(capture.data, "base64"));
			await close();
		}
	}, 120_000);
});
