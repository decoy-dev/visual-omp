import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const isolated = vi.hoisted(() => ({ env: {} as NodeJS.ProcessEnv, bin: "" }));
vi.mock("../env", () => ({ userEnv: async () => isolated.env, ptyEnv: (env: NodeJS.ProcessEnv) => env }));
vi.mock("../ipc", () => ({ broadcast: vi.fn() }));
vi.mock("../prefs", () => ({ getPrefs: () => ({ theme: "light", reducedMotion: "on" }) }));
vi.mock("./locate", () => ({ ompPath: async () => isolated.bin }));
vi.mock("./refused", () => ({ ompStartError: (error: unknown) => error }));
vi.mock("./sessions", () => ({ findSessionFile: async () => null, onSessionsChanged: vi.fn() }));
vi.mock("electron", () => ({ BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }, dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) }, nativeTheme: { on: vi.fn(), removeListener: vi.fn(), shouldUseDarkColors: false }, systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: true }) } }));

import { SessionHost } from "./host";
import { nativeBridge } from "./native-bridge";
import { paintedPrediction } from "./prediction-transfer";
import { setConfigPath } from "./config-file";

// Opt-in standalone engines only. HOME and every omp config directory are disposable.
describe.skipIf(!process.env.OMP_BIN || !process.env.VOMP_PREDICTIONS_LIVE || process.platform === "win32")("live hosted prediction settings", () => {
	let root: string;
	beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "vomp-prediction-default-live-")); });
	afterAll(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
	it.each(["classic", "tsp"] as const)("shows an explicitly enabled offer and cancels it when disabled through omp's config (%s)", async transport => {
		let host: SessionHost | undefined;
		let provider: Server | undefined;
		try {
			const home = join(root, "home"), agent = join(root, "agent");
			await Promise.all([mkdir(home, { recursive: true }), mkdir(agent, { recursive: true })]);
			isolated.bin = resolve(process.env.OMP_BIN!);
			isolated.env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), PI_CODING_AGENT_DIR: agent, PI_CONFIG_DIR: agent, TMPDIR: root, TERM: "xterm-256color", COLORTERM: "truecolor" };
			let requests = 0;
			provider = createServer(async (request, response) => {
				for await (const _ of request) { /* Drain the local fixture request. */ }
				const content = ++requests % 2 ? "The fixture reply is complete." : "Review the fixture changes";
				const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: `fixture-${requests}`, object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(chunk({ role: "assistant", content }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
			});
			const listening = Promise.withResolvers<void>();
			provider.once("error", listening.reject);
			provider.listen(0, "127.0.0.1", listening.resolve);
			await listening.promise;
			const address = provider.address();
			if (!address || typeof address === "string") throw new Error("Missing fixture provider port");
			await writeFile(join(agent, "models.yml"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-fixture-only", api: "openai-completions", models: [{ id: "fixture-model", name: "Fixture model", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] } } }));
			await writeFile(join(agent, "config.yml"), JSON.stringify({ setupVersion: 999, composer: { predictions: true }, autocomplete: { enabled: false }, recap: { enabled: false }, memory: { enabled: false }, idle: { enabled: false }, worktree: { onExit: "keep" }, modelRoles: { default: "fixture/fixture-model" } }));
			vi.stubEnv("VOMP_TSP", transport === "tsp" ? "1" : "0");
			const current = host = new SessionHost({ cwd: root, extraArgs: ["--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--model", "fixture/fixture-model", "--thinking", "off"] });
			await current.start();
			await vi.waitFor(() => expect(current.state.phase, current.state.error ?? "host startup").toBe("live"), { timeout: 20_000 });
			await vi.waitFor(async () => expect((await nativeBridge(current.id).editorDraft({ operation: "peek", sessionId: current.state.sessionId! })).text).toBe(""), { timeout: 15_000 });
			await current.submit("Fixture first prompt");
			await vi.waitFor(async () => expect(await paintedPrediction(current)).toBe("Review the fixture changes"), { timeout: 20_000 });
			expect(requests).toBe(2);
			await setConfigPath("global", root, ["composer", "predictions"], false);
			await vi.waitFor(async () => expect(await paintedPrediction(current)).toBeNull(), { timeout: 15_000 });
		} finally {
			try { await host?.stop(); }
			finally {
				provider?.closeAllConnections();
				if (provider?.listening) {
					const closed = Promise.withResolvers<void>();
					provider.close(() => closed.resolve());
					await closed.promise;
				}
				vi.unstubAllEnvs();
			}
		}
	}, 90_000);
});
