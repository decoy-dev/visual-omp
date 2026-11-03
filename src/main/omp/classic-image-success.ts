import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { deflateSync } from "node:zlib";
import { spawn, type IPty } from "node-pty";
import type { EditorDraftResult } from "@shared/contracts/composer";
import { attachClassicImages, classicImageFailure } from "./classic-image-paste";
import { createNativeBridge, type NativeBridge } from "./native-bridge";
import { TuiDebugClient } from "./tui-debug";
import { sanitizeFixtureBytes } from "./tsp/sanitize-fixture";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4ioAAAAASUVORK5CYII=", "base64");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pngBlack = (() => {
	const chunk = (kind: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(kind), data]);
		let crc = 0xffffffff;
		for (const byte of body) {
			crc ^= byte;
			for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
		const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
		return Buffer.concat([length, body, checksum]);
	};
	const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
	return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0]))), chunk("IEND", Buffer.alloc(0))]);
})();
export interface ClassicSuccessCase {
	name: string;
	paths: string;
	prompt: string;
	editorReads: EditorDraftResult[];
	failures: Array<string | null>;
	operations: Array<{ kind: "paste" | "acknowledged" | "prompt" | "enter"; text?: string }>;
	acknowledged: EditorDraftResult;
	submitted: EditorDraftResult;
	cleared: EditorDraftResult;
	providerIndex: number;
	helperAccepted?: true;
}
export interface ClassicSuccessCapture {
	version: string;
	theme: unknown;
	cases: ClassicSuccessCase[];
	requests: Array<{ messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }> }>;
}

/** Standalone production helper, bridge extension and debug client, with only a loopback model. */
export async function captureClassicImageSuccess(bin: string, expectedVersion: string, sourceRoot: string, destination?: string): Promise<ClassicSuccessCapture> {
	const root = await mkdtemp("/tmp/vomp-tsp-record-");
	const home = join(root, "home"), agent = join(root, "agent");
	await Promise.all([mkdir(home), mkdir(agent)]);
	const env = { PATH: process.env.PATH!, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), PI_CODING_AGENT_DIR: agent, PI_CONFIG_DIR: agent, TMPDIR: root, TERM: "xterm-256color", COLORTERM: "truecolor", PI_TUI_NATIVE: "0", OMP_SKIP_SETUP: "1" };
	let bridge: NativeBridge | undefined;
	let debug: TuiDebugClient | undefined;
	let child: IPty | undefined;
	let exited = false;
	const raw: Buffer[] = [];
	const requests: ClassicSuccessCapture["requests"] = [];
	const provider = createServer(async (request, response) => {
		try {
			if (request.url !== "/v1/chat/completions" || request.method !== "POST") { response.writeHead(404).end(); return; }
			const parts: Buffer[] = [];
			for await (const part of request) parts.push(Buffer.from(part));
			requests.push(JSON.parse(Buffer.concat(parts).toString("utf8")));
			const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: `classic-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(chunk({ role: "assistant", content: "Classic image fixture received." }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
		} catch (error) { response.writeHead(500).end(String(error)); }
	});
	const until = async (predicate: () => boolean | Promise<boolean>, label: string) => {
		const deadline = Date.now() + 20_000;
		while (!await predicate()) { if (exited || Date.now() >= deadline) throw new Error(label); await sleep(40); }
	};
	try {
		const version = execFileSync(bin, ["--version"], { env, encoding: "utf8" }).trim();
		if (version !== `omp/${expectedVersion}`) throw new Error(`Expected omp/${expectedVersion}; received ${version}`);
		const sourceVersion = JSON.parse(await readFile(join(sourceRoot, "packages/coding-agent/package.json"), "utf8")).version;
		if (sourceVersion !== expectedVersion) throw new Error(`Source version ${sourceVersion} does not match ${expectedVersion}`);
		const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim();
		const sourceFiles = await Promise.all([
			["packages/coding-agent/src/modes/controllers/input-controller.ts", "#insertPendingImage: pendingImages.push, chipLabel, insertAtom"],
			["packages/tui/src/prompt/composer-attachments.ts", "activeChipIcon and chipLabel"],
			["packages/tui/src/components/editor.ts", "insertAtom inserts label plus trailing space"],
			["packages/tui/src/theme/symbols.ts", "chip.image presets"],
		].map(async ([path, evidence]) => ({ path, evidence, sha256: hash(await readFile(join(sourceRoot, path!))) })));
		const listening = Promise.withResolvers<void>();
		provider.once("error", listening.reject);
		provider.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = provider.address();
		if (!address || typeof address === "string") throw new Error("Missing loopback provider port");
		await writeFile(join(agent, "models.yml"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-fixture-only", api: "openai-completions", models: [{ id: "fixture-model", name: "Classic image fixture", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] } } }));
		await writeFile(join(agent, "config.yml"), JSON.stringify({ setupVersion: 999, startup: { setupWizard: false, checkUpdate: false, changelogMode: "hidden", quiet: true }, marketplace: { autoUpdate: "off" }, worktree: { onStart: "off", onExit: "keep" }, autocomplete: { enabled: false }, composer: { predictions: false }, recap: { enabled: false }, memory: { enabled: false }, idle: { enabled: false }, modelRoles: { default: "fixture/fixture-model", smol: "fixture/fixture-model" } }));
		const paths = [join(root, "Screen Shot.png"), join(root, "other.png")];
		await Promise.all(paths.map((path, index) => writeFile(path, index === 0 ? png : pngBlack)));
		bridge = await createNativeBridge("classic-image-success", root);
		const socket = join(root, "debug.sock");
		debug = new TuiDebugClient(socket);
		child = spawn(bin, ["--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--session-dir", join(root, "sessions"), "--model", "fixture/fixture-model", "--thinking", "off", "-e", bridge.extensionPath], { cols: 110, rows: 32, cwd: root, name: "xterm-256color", encoding: null, env: { ...env, VOMP_NATIVE_BRIDGE: bridge.url, OMP_TUI_DEBUG: socket } });
		child.onExit(() => { exited = true; });
		child.onData(data => {
			const bytes = typeof data === "string" ? Buffer.from(data) : data;
			raw.push(bytes);
			if (bytes.includes(Buffer.from("\x1b[c"))) child!.write("\x1b[?62;22c");
			if (bytes.includes(Buffer.from("\x1b[6n"))) child!.write("\x1b[1;1R");
		});
		await until(() => !!bridge!.snapshot.location?.sessionId, "Native extension did not publish its session");
		await until(async () => { try { return (await debug!.info()).focused !== null; } catch { return false; } }, "Classic editor did not become ready");
		const sessionId = bridge.snapshot.location!.sessionId;
		const readEditor = () => bridge!.editorDraft({ operation: "peek", sessionId });
		if ((await readEditor()).text !== "") throw new Error("Expected an empty isolated editor");
		const cases: ClassicSuccessCase[] = [];
		for (const [name, count] of [["single", 1], ["multiple", 2]] as const) {
			const item: ClassicSuccessCase = { name, paths: paths.slice(0, count).map(path => path.replace(/ /g, "\\ ")).join(" "), prompt: `Describe the ${name} classic image fixture.`, editorReads: [], failures: [], operations: [], acknowledged: { text: null, cleared: false }, submitted: { text: null, cleared: false }, cleared: { text: null, cleared: false }, providerIndex: requests.length };
			await attachClassicImages(item.paths, {
				assertCurrent: () => { if (exited || bridge!.snapshot.location?.sessionId !== sessionId) throw new Error("The isolated session changed"); },
				readEditor: async () => { const result = await readEditor(); item.editorReads.push(result); return result; },
				restoreEditor: (expected, restoreText) => bridge!.editorDraft({ operation: "restore", sessionId, expected, restoreText }),
				failureText: async () => { const result = classicImageFailure(await debug!.values()); item.failures.push(result); return result; },
				paste: text => { item.operations.push({ kind: "paste", text }); child!.write(`\x1b[200~${text}\x1b[201~`); },
				wait: () => sleep(40),
			});
			item.helperAccepted = true;
			item.acknowledged = await readEditor();
			item.operations.push({ kind: "acknowledged" });
			item.operations.push({ kind: "prompt", text: item.prompt });
			child.write(`\x1b[200~${item.prompt}\x1b[201~`);
			await until(async () => { item.submitted = await readEditor(); return item.submitted.text === item.acknowledged.text + item.prompt; }, "Prompt did not preserve acknowledged tokens");
			item.operations.push({ kind: "enter" });
			child.write("\r");
			await until(() => requests.length === item.providerIndex + 1, "Loopback provider did not receive the classic send");
			await until(async () => { item.cleared = await readEditor(); return item.cleared.text === "" && item.cleared.imageChips === 0; }, "Editor did not clear after classic send");
			await until(async () => (await debug!.screen()).some(line => line.includes("Classic image fixture received.")), "Loopback response did not paint");
			const user = requests[item.providerIndex]!.messages.filter(message => message.role === "user").at(-1);
			const images = Array.isArray(user?.content) ? user.content.filter(part => part.type === "image_url") : [];
			if (images.length !== count || images.some(part => !part.image_url?.url.startsWith("data:image/"))) throw new Error(`Provider did not receive all ${count} fixture images`);
			if (count === 2 && images[0]!.image_url!.url === images[1]!.image_url!.url) throw new Error("Provider received duplicate payloads for the distinct fixture images");
			cases.push(item);
		}
		const capture: ClassicSuccessCapture = { version: expectedVersion, theme: bridge.snapshot.theme, cases, requests };
		bridge.requestShutdown();
		await until(() => exited, "SDK shutdown did not finish");
		if (destination) {
			await mkdir(destination, { recursive: true });
			const artifacts: Record<string, Buffer> = {
				"classic-image-success.json": sanitizeFixtureBytes(Buffer.from(JSON.stringify(capture, null, 2) + "\n")),
				"classic-image-success.raw.bin": sanitizeFixtureBytes(Buffer.concat(raw)),
			};
			await Promise.all(Object.entries(artifacts).map(([name, bytes]) => writeFile(join(destination, name), bytes)));
			await writeFile(join(destination, "classic-image-success.integrity.json"), JSON.stringify({ version: expectedVersion, sourceCommit, sourceFiles, executableSha256: hash(await readFile(bin)), inputImages: [png, pngBlack].map(bytes => ({ bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString("base64") })), isolation: "Scratch HOME/config/cache/session, allowlisted environment, scripted loopback provider, no inherited credentials or context", classicEnvironment: { PI_TUI_NATIVE: "0", TERM_PROGRAM: null }, pathSanitizer: "tsp/sanitize-fixture.ts", shutdown: "NativeBridge.requestShutdown SDK path", artifacts: Object.fromEntries(Object.entries(artifacts).map(([name, bytes]) => [name, { bytes: bytes.length, carriageReturns: bytes.filter(byte => byte === 13).length, sha256: hash(bytes) }])) }, null, 2) + "\n");
		}
		return capture;
	} finally {
		if (!exited) child?.kill();
		debug?.close();
		await bridge?.close();
		provider.closeAllConnections();
		if (provider.listening) {
			const closed = Promise.withResolvers<void>();
			provider.close(() => closed.resolve());
			await closed.promise;
		}
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
}
