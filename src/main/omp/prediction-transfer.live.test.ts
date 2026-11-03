import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

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
import { paintedPrediction, PredictionTransfers } from "./prediction-transfer";
import { walkNodes } from "@shared/tsp/view-state";

const choices = ["Run the fixture tests", "Review the fixture changes", "Explain the fixture design", "Check the fixture types"];

// Explicit opt-in: the alternatives setting was introduced after the supported 18.15 minimum.
describe.skipIf(!process.env.OMP_BIN || !process.env.VOMP_PREDICTION_ALTERNATIVES_LIVE || process.platform === "win32")("live omp prediction alternatives with the application overlay", () => {
	it.each(["classic", "tsp"] as const)("transfers the exact first prediction twice without opening a stuck alternatives popup (%s)", async transport => {
		const root = await mkdtemp(join(tmpdir(), "vomp-predictions-live-"));
		const previousEnv = isolated.env, previousBin = isolated.bin;
		let hostToStop: SessionHost | undefined;
		let provider: Server | undefined;
		try {
			const home = join(root, "home"), agent = join(root, "agent");
			await Promise.all([mkdir(home), mkdir(agent)]);
			isolated.bin = resolve(process.env.OMP_BIN!);
			isolated.env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), PI_CODING_AGENT_DIR: agent, PI_CONFIG_DIR: agent, TMPDIR: root, TERM: "xterm-256color", COLORTERM: "truecolor" };
			let requests = 0;
			const server = provider = createServer(async (request, response) => {
				for await (const _ of request) { /* Drain the request before replying. */ }
				const text = ++requests === 1 ? "Fixture prediction answer." : choices.join("\n");
				const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: `fixture-${requests}`, object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
			});
			const listening = Promise.withResolvers<void>();
			server.once("error", listening.reject);
			server.listen(0, "127.0.0.1", listening.resolve);
			await listening.promise;
			server.off("error", listening.reject);
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Missing fixture provider port");
			await writeFile(join(agent, "models.yml"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-fixture-only", api: "openai-completions", models: [{ id: "fixture-model", name: "Fixture model", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] } } }));
			await writeFile(join(agent, "config.yml"), JSON.stringify({ setupVersion: 999, composer: { predictions: true, predictionAlternatives: true }, autocomplete: { enabled: false }, recap: { enabled: false }, memory: { enabled: false }, idle: { enabled: false }, worktree: { onExit: "keep" }, modelRoles: { default: "fixture/fixture-model", smol: "fixture/fixture-model" } }));
			vi.stubEnv("VOMP_TSP", transport === "tsp" ? "1" : "");
			const host = hostToStop = new SessionHost({ cwd: root, extraArgs: ["--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--model", "fixture/fixture-model", "--thinking", "off"] });
			const transfers = new PredictionTransfers(() => host, nativeBridge, () => {});
			await host.start();
			await vi.waitFor(() => expect(host.state.phase, host.state.error ?? "host startup").toBe("live"), { timeout: 20_000 });
			await vi.waitFor(async () => expect((await nativeBridge(host.id).editorDraft({ operation: "peek", sessionId: host.state.sessionId! })).text).toBe(""), { timeout: 15_000 });
			await host.submit("Fixture prediction prompt");
			await vi.waitFor(async () => expect(await paintedPrediction(host)).toBe(choices[0]), { timeout: 20_000 });
			for (let attempt = 0; attempt < 2; attempt++) {
				const capture = await transfers.take({ hostId: host.id, generation: host.state.generation, tabId: "tab", nativeDraft: "", expectedGhost: choices[0]! });
				expect(capture).toMatchObject({ text: choices[0], blocked: false, error: null });
				expect((await nativeBridge(host.id).editorDraft({ operation: "peek", sessionId: host.state.sessionId! })).text).toBe("");
				if (transport === "tsp") {
					expect(host.composerFacts()).toMatchObject({ text: "", blockedBy: null });
					expect(host.tspSnapshot()!.surfaces.flatMap(surface => [...walkNodes(surface.document)]).some(node => node.p?.role === "omp.autocomplete")).toBe(false);
				} else expect((await host.tuiFocus())?.overlays).toBe(0);
				transfers.acknowledge(capture!.id);
				await vi.waitFor(async () => expect(await transfers.offer(host.id)).toBe(choices[0]), { timeout: 5000 });
			}
			expect(requests).toBe(2);
			const generation = host.state.generation;
			const epoch = host.tspSnapshot()?.epoch;
			// The transfer clears the inserted text before a second Tab. Exercise omp's own
			// second-Tab popup separately so its semantic representation remains documented.
			await host.keys("tab", generation, epoch);
			await vi.waitFor(async () => expect((await nativeBridge(host.id).editorDraft({ operation: "peek", sessionId: host.state.sessionId! })).text).toBe(choices[0]), { timeout: 5000 });
			expect(await transfers.offer(host.id)).toBeNull();
			await host.keys("tab", generation, epoch);
			if (transport === "tsp") {
				await vi.waitFor(() => expect(host.tspSnapshot()!.surfaces.flatMap(surface => [...walkNodes(surface.document)]).some(node => node.p?.role === "omp.autocomplete")).toBe(true), { timeout: 5000 });
				const nodes = host.tspSnapshot()!.surfaces.flatMap(surface => [...walkNodes(surface.document)]);
				const popup = nodes.find(node => node.p?.role === "omp.autocomplete")!;
				expect([...walkNodes(popup)].filter(node => node.k === "item").map(node => {
					const label = node.p?.label;
					return typeof label === "string" ? label : label?.map(span => span.t).join("");
				})).toEqual(choices);
			}
			await host.keys(transport === "tsp" ? "\u001b[B\r" : "down enter", generation, epoch);
			await vi.waitFor(async () => expect((await nativeBridge(host.id).editorDraft({ operation: "peek", sessionId: host.state.sessionId! })).text).toBe(choices[1]), { timeout: 5000 });
			expect(await nativeBridge(host.id).editorDraft({ operation: "take", sessionId: host.state.sessionId!, expected: choices[1] })).toMatchObject({ text: choices[1], cleared: true });
			await vi.waitFor(async () => expect(await transfers.offer(host.id)).toBe(choices[0]), { timeout: 5000 });
			if (transport === "tsp") {
				await host.withEditorInput(input => input.edit(0, 0, "Review", 6));
				await vi.waitFor(() => expect(host.composerFacts()).toMatchObject({ text: "Review", ghost: " the fixture changes" }), { timeout: 5000 });
				expect(await transfers.offer(host.id)).toBeNull();
				expect(await nativeBridge(host.id).editorDraft({ operation: "take", sessionId: host.state.sessionId!, expected: "Review" })).toMatchObject({ cleared: true });
			}
		} finally {
			try { await hostToStop?.stop(); }
			finally {
				try {
					if (provider) {
						provider.closeAllConnections();
						if (provider.listening) {
							const closed = Promise.withResolvers<void>();
							provider.close(() => closed.resolve());
							await closed.promise;
						}
					}
				} finally {
					try { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
					finally {
						vi.unstubAllEnvs();
						isolated.env = previousEnv;
						isolated.bin = previousBin;
					}
				}
			}
		}
	}, 90_000);
});
