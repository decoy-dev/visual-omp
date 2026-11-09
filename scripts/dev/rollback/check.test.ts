import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { installerName } from "../../../src/main/services/updates";
import type { Platform } from "../../../src/shared/ipc";

const fixture = vi.hoisted(() => ({ root: "", handlers: new Map<string, (...args: unknown[]) => unknown>(), events: [] as { channel: string; value: unknown }[], opened: [] as string[], revealed: [] as string[] }));
vi.mock("electron", () => ({
	app: { isPackaged: false, getVersion: () => "0.7.12", getPath: () => fixture.root, on: vi.fn(), quit: vi.fn() },
	shell: {
		openPath: async (path: string) => { fixture.opened.push(path); return ""; },
		showItemInFolder: (path: string) => { fixture.revealed.push(path); },
	},
}));
vi.mock("../../../src/main/ipc", () => ({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => fixture.handlers.set(channel, handler), broadcast: (channel: string, value: unknown) => fixture.events.push({ channel, value: structuredClone(value) }) }));
vi.mock("../../../src/main/env", () => ({ userEnv: async () => ({}) }));
vi.mock("../../../src/main/attention", () => ({ tagScoopShortcut: vi.fn() }));
vi.mock("../../../src/main/omp/cli", () => ({ runOmp: vi.fn() }));
vi.mock("../../../src/main/omp/locate", () => ({ ompPath: vi.fn(), ompStatus: async () => ({ found: true, supported: true, version: "18.18.3", path: "/fixture/omp" }) }));
vi.mock("../../../src/main/omp/refused", () => ({ ompStartError: vi.fn() }));

it.skipIf(!process.env.VOMP_ROLLBACK_CHECK_DIR)("checks rollback through headless Chrome and the local development feed", async () => {
	fixture.root = await mkdtemp(join(tmpdir(), "vomp-rollback-check-"));
	const output = resolve(process.env.VOMP_ROLLBACK_CHECK_DIR!);
	await mkdir(output, { recursive: true });
	const feedPath = join(fixture.root, "feed.json");
	const bytes = Buffer.from("Local rollback installer fixture. This file must never be executed.\n");
	const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
	const fetchNetwork = globalThis.fetch;
	let origin = "";
	let checksumFailure = false;
	const server = createServer(async (request, response) => {
		response.setHeader("Access-Control-Allow-Origin", "*");
		response.setHeader("Access-Control-Allow-Headers", "Content-Type");
		if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
		try {
			if (request.url === "/installer") { response.end(checksumFailure ? Buffer.alloc(bytes.length) : bytes); return; }
			if (request.url?.startsWith("/events?")) {
				const from = Number(new URL(request.url, origin).searchParams.get("from"));
				response.end(JSON.stringify({ events: fixture.events.slice(from), next: fixture.events.length })); return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
			// Preferences capture app.getPath at module load, after this test creates its scratch root.
			const { getPrefs, setPrefs, flushPrefs } = await import("../../../src/main/prefs");
			let value: unknown;
			if (request.url === "/fixture") {
				checksumFailure = input.failure === "checksum";
				fixture.events.length = 0; fixture.opened.length = 0; fixture.revealed.length = 0;
				const releases = ["0.7.12", "0.7.11", "0.7.10"].map(version => ({
					tag_name: `v${version}`, name: `v${version}`, html_url: `${origin}/releases/v${version}`,
					body: `## Fixed\n\n- This local fixture checks rollback to v${version}.`, draft: false, prerelease: false,
					assets: [{ name: installerName(version, process.platform as Platform, process.arch), browser_download_url: `${origin}/installer`, size: bytes.length, ...(input.failure === "digest" ? {} : { digest }) }],
				}));
				await writeFile(feedPath, JSON.stringify({ method: input.method, scoopGlobal: input.global ?? false, scoopRetainedVersions: input.retained ? ["0.7.11"] : [], releases }));
				setPrefs({ appUpdateSkipThrough: input.previousSkip ?? null }); await flushPrefs();
				await writeFile(join(fixture.root, "update-pending.json"), JSON.stringify({ method: input.method, from: "0.7.11", to: "0.7.12", at: Date.now() }));
				value = { root: fixture.root };
			} else if (request.url === "/snapshot") {
				const persisted = JSON.parse(await readFile(join(fixture.root, "preferences.json"), "utf8"));
				const download = fixture.events.filter(event => event.channel === "updates:app:download").at(-1)?.value;
				const boundaryHistory = fixture.events.filter(event => event.channel === "app:prefs").map(event => {
					const value = event.value;
					return value && typeof value === "object" && "appUpdateSkipThrough" in value ? value.appUpdateSkipThrough : null;
				});
				value = { boundary: getPrefs().appUpdateSkipThrough, persistedBoundary: persisted.appUpdateSkipThrough, boundaryHistory, opened: fixture.opened, revealed: fixture.revealed, download };
			} else if (request.url === "/invoke") {
				if (!input.channel.startsWith("updates:app:")) throw new Error("Only app update handlers are exposed by this fixture.");
				const handler = fixture.handlers.get(input.channel);
				if (!handler) throw new Error(`No fixture handler: ${input.channel}`);
				value = await handler(...input.args);
			} else throw new Error("Unknown fixture route");
			response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ value }));
		} catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: String(error) })); }
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("The fixture server has no TCP address.");
	origin = `http://127.0.0.1:${address.port}`;
	vi.stubEnv("VOMP_UPDATE_FEED", feedPath);
	// Fail closed on network access outside the single fixture server.
	vi.stubGlobal("fetch", (url: URL | string, init?: RequestInit) => {
		if (new URL(String(url)).origin !== origin) throw new Error(`External network refused: ${url}`);
		return fetchNetwork(url, init);
	});
	try {
		// Update modules capture both the scratch profile and VOMP_UPDATE_FEED during initialization.
		vi.useFakeTimers();
		(await import("../../../src/main/features/updates")).register();
		vi.clearAllTimers(); vi.useRealTimers();
		const child = spawn(process.execPath, [join(import.meta.dirname, "capture.mjs"), "--backend", origin, "--output", output], { stdio: ["ignore", "pipe", "pipe"] });
		let log = ""; child.stdout.on("data", chunk => { log += chunk; }); child.stderr.on("data", chunk => { log += chunk; });
		const [code] = await once(child, "exit");
		await writeFile(join(output, "capture.log"), log);
		expect(code, log).toBe(0);
		const evidence = JSON.parse(await readFile(join(output, "evidence.json"), "utf8"));
		expect(evidence.screenshots).toHaveLength(24);
		expect(evidence.flows.map((flow: { result: string }) => flow.result)).toEqual(["passed", "passed", "passed", "passed"]);
		for (const screenshot of evidence.screenshots) await access(screenshot);
	} finally {
		vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
		const closed = Promise.withResolvers<void>();
		server.close(error => error ? closed.reject(error) : closed.resolve());
		await closed.promise;
	}
}, 180_000);
