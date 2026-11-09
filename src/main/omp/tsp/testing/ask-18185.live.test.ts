import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startFixture } from "../../../../../scripts/live-preview-fixture/server.mjs";
import { fixtureEnvironment } from "../../../../../scripts/live-preview-fixture/environment.mjs";
import { askFormPresentation } from "@shared/tsp/roles";
import { walkNodes } from "@shared/tsp/view-state";
import type { CollabUiRequest, SessionEntry, ToolCallContent } from "@oh-my-pi/pi-wire";

// Replace only desktop integration and environment discovery. SessionHost owns the real
// PTY, loopback collab relay, native extension, TspSession and question arbitration.
const isolated = vi.hoisted(() => ({ env: {} as NodeJS.ProcessEnv, bin: "", agent: "" }));
vi.mock("../../../env", () => ({ userEnv: async () => isolated.env, ptyEnv: (env: NodeJS.ProcessEnv) => env }));
vi.mock("../../../ipc", () => ({ broadcast: vi.fn() }));
vi.mock("../../../prefs", () => ({ getPrefs: () => ({ theme: "light", reducedMotion: "on" }) }));
vi.mock("../../locate", () => ({ ompPath: async () => isolated.bin }));
vi.mock("../../refused", () => ({ ompStartError: (error: unknown) => error }));
vi.mock("../../paths", () => ({ agentDir: () => isolated.agent, sessionsDir: () => join(isolated.agent, "sessions") }));
vi.mock("../../sessions", () => ({ findSessionFile: async () => null, onSessionsChanged: vi.fn() }));
vi.mock("electron", () => ({ BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }, dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) }, nativeTheme: { on: vi.fn(), removeListener: vi.fn(), shouldUseDarkColors: false }, systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: true }) } }));

import { SessionHost } from "../../host";
import { GuestClient } from "../../../../renderer/src/collab/lib/client";

const enabled = process.env.TSP_ASK_18185_LIVE === "1";
const binary = process.env.OMP_BIN ?? "/tmp/omp-18.18.5-bin/omp-darwin-arm64";
const evidenceDirectory = process.env.TSP_ASK_EVIDENCE ?? join(homedir(), "vomp-checks/ask-18185/live");

describe.skipIf(!enabled || process.platform === "win32")("isolated real omp HTML ask compatibility", () => {
	it.each(["form", "colors"] as const)("saves exactly one fixture %s result through the sole guest answer path", async fixtureName => {
		if (!existsSync(binary)) throw new Error(`The live ask gate requires OMP_BIN or ${binary}`);
		const root = await mkdtemp(join(tmpdir(), `vomp-ask-18185-${fixtureName}-`));
		await mkdir(evidenceDirectory, { recursive: true });
		let fixture: { baseUrl: string; close(): Promise<void> } | undefined;
		let host: SessionHost | undefined;
		let guest: GuestClient | undefined;
		let unsubscribe: (() => void) | undefined;
		let failure: string | undefined;
		const requests: { id: number; fixture: string | undefined; afterTool: boolean; tools: string[] }[] = [];
		const answers: { reqId: number; title: string; value: string }[] = [];
		const samples: unknown[] = [];
		const documents: unknown[] = [];
		let lastDocument = "";
		let revision = 0;
		const capture = (phase: string) => {
			const snapshot = host?.tspSnapshot();
			const replica = guest?.getSnapshot();
			if (snapshot) {
				const serialized = JSON.stringify(snapshot.surfaces);
				if (serialized !== lastDocument) { documents.push({ phase, at: Date.now(), snapshot }); lastDocument = serialized; }
			}
			const forms = snapshot?.surfaces.flatMap(surface => [...walkNodes(surface.document)]).flatMap(node => {
				const form = askFormPresentation(node);
				return form ? [{ id: node.id, view: form.view, navigation: form.navigation }] : [];
			}) ?? [];
			samples.push({ phase, at: Date.now(), forms, questionMatches: snapshot?.questionMatches, uiRequest: replica?.uiRequest, pendingUiRequests: replica?.pendingUiRequests, activeTools: replica ? [...replica.activeTools.values()] : [], working: replica?.working });
		};
		const until = async (label: string, predicate: () => boolean) => {
			const deadline = Date.now() + 30_000;
			while (!predicate()) {
				if (host?.state.phase === "exited" || host?.tspSnapshot()?.failure) throw new Error(`${label}: ${JSON.stringify(host.state)}`);
				if (Date.now() > deadline) { capture(`timeout: ${label}`); throw new Error(`Timed out waiting for ${label}`); }
				await delay(20);
			}
		};
		try {
			fixture = await startFixture({ root, port: 0, durationMs: 0, onRequest: request => requests.push(request) });
			isolated.env = fixtureEnvironment(root);
			isolated.agent = isolated.env.PI_CODING_AGENT_DIR!;
			isolated.bin = resolve(binary);
			vi.stubGlobal("WebSocket", WebSocket);
			vi.stubEnv("VOMP_TSP", "1");
			host = new SessionHost({ cwd: join(root, "work"), extraArgs: ["--session-dir", join(root, "sessions"), "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--model", "fixture/preview", "--thinking", "off", "--tools", "ask"] });
			const nativeEvents = vi.spyOn(host, "tspEvent");
			const nativeAnswers = vi.spyOn(host, "tspAnswer");
			await host.start();
			await until("live TSP composer and local room", () => host!.state.phase === "live" && !!host!.state.link && host!.tspSnapshot()?.availability.available === true);
			expect(host.state.transport).toBe("tsp");
			guest = new GuestClient(host.state.link!, "HTML ask live compatibility gate");
			const mirror = () => {
				const snapshot = host!.tspSnapshot(), replica = guest!.getSnapshot();
				if (snapshot) host!.tspQuestions({ hostId: host!.id, generation: host!.state.generation, epoch: snapshot.epoch, connection: replica.uiConnection ?? 0, revision: ++revision, connected: replica.phase === "live", requests: [...(replica.pendingUiRequests ?? [])] });
				capture("guest publication");
			};
			unsubscribe = guest.subscribe(mirror);
			guest.connect();
			await until("live guest", () => guest!.getSnapshot().phase === "live");
			await host.submit(`fixture ${fixtureName}`);
			await until("first real guest form request and native form", () => !!guest!.getSnapshot().uiRequest && host!.tspSnapshot()!.surfaces.some(surface => [...walkNodes(surface.document)].some(node => askFormPresentation(node))));
			mirror();
			const seen = new Set<number>();
			const expectedCount = fixtureName === "form" ? 5 : 1;
			const valueFor = (request: CollabUiRequest): string => {
				if (fixtureName === "colors") return "#197f8680 (transparent teal)";
				if (request.kind === "editor") return "Isolated live fixture headline";
				if (request.title === "Release channel") return "Beta";
				if (request.title === "Platforms to check") return request.checkedIndices?.includes(2) ? "Next →" : "Linux";
				if (request.title === "Review depth") return "Full";
				throw new Error(`Unexpected fixture request: ${JSON.stringify(request)}`);
			};
			for (let index = 0; index < expectedCount; index++) {
				await until(`guest field ${index + 1}`, () => !!guest!.getSnapshot().uiRequest && !seen.has(guest!.getSnapshot().uiRequest!.reqId));
				const request = guest.getSnapshot().uiRequest!;
				seen.add(request.reqId);
				mirror();
				capture("before guest answer");
				const nativeForms = host.tspSnapshot()!.surfaces.flatMap(surface => [...walkNodes(surface.document)]).flatMap(node => {
					const form = askFormPresentation(node);
					return form ? [form] : [];
				});
				expect(nativeForms).toHaveLength(1);
				expect(nativeForms[0]!.view).toBe("fields");
				if (fixtureName === "form") expect(nativeForms[0]!.navigation?.active).toBe("t0");
				const value = valueFor(request);
				answers.push({ reqId: request.reqId, title: request.title, value });
				// No native tab, Next, Review or Submit is driven here. Guest completion
				// cancels the paired local form through omp's own guest/native race.
				guest.sendUiResponse(request.reqId, value);
				capture("after guest answer");
			}
			await until("one collab result and physical native departure", () => {
				const replica = guest!.getSnapshot();
				const results = replica.entries.filter(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "ask");
				return results.length > 0 && (replica.pendingUiRequests?.length ?? 0) === 0 && !replica.working && host!.tspSnapshot()!.availability.available;
			});
			capture("completed");
			expect(nativeEvents).not.toHaveBeenCalled();
			expect(nativeAnswers).not.toHaveBeenCalled();
			expect(host.screenReadAttempts()).toEqual([]);
			const entries = guest.getSnapshot().entries;
			const calls = entries.flatMap(entry => entry.type === "message" && entry.message.role === "assistant" ? entry.message.content : []).filter((part): part is ToolCallContent => part.type === "toolCall" && part.name === "ask");
			expect(calls).toHaveLength(1);
			expect(calls[0]!.arguments).toHaveProperty("html");
			const results = entries.filter(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === calls[0]!.id);
			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ message: { isError: false, details: { answers: fixtureName === "form" ? [
				{ name: "channel", answer: "Beta" }, { name: "platforms", answer: "macOS, Windows, Linux" }, { name: "headline", answer: "Isolated live fixture headline" }, { name: "depth", answer: "Full" },
			] : [{ name: "color", answer: "#197f8680 (transparent teal)" }] } } });
			expect(requests.map(request => [request.fixture, request.afterTool])).toEqual([[fixtureName, false], [fixtureName, true]]);
			await host.stop();
			// Explicit CLI session-dir keeps saved evidence independent of omp's data-root layout.
			const sessionRoot = join(root, "sessions");
			const files = (await readdir(sessionRoot, { recursive: true })).filter(file => file.endsWith(".jsonl"));
			const saved: { file: string; text: string }[] = [];
			for (const file of files) saved.push({ file, text: await readFile(join(sessionRoot, file), "utf8") });
			const savedResults = saved.flatMap(file => file.text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as SessionEntry)).filter(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === calls[0]!.id);
			expect(savedResults).toHaveLength(1);
			await writeFile(join(evidenceDirectory, `${fixtureName}-saved-sessions.json`), JSON.stringify(saved, null, 2));
			await writeFile(join(evidenceDirectory, `${fixtureName}-guest-entries.json`), JSON.stringify(entries, null, 2));
		} catch (error) { failure = String(error); throw error; }
		finally {
			capture("final");
			unsubscribe?.(); guest?.close();
			try { if (host && host.state.phase !== "exited") await host.stop(); }
			finally {
				try {
					await writeFile(join(evidenceDirectory, `${fixtureName}-live-trace.json`), JSON.stringify({ binary: isolated.bin || binary, root, provider: fixture?.baseUrl, seam: "Real isolated SessionHost, TspSession, collab guest and startFixture provider. Guest.sendUiResponse is the sole live answer path. Chrome card interactions and no-auto-open policy are exercised separately in ui-gate.test.ts.", failure, requests, answers, samples, documents }, null, 2));
				} finally {
					await fixture?.close();
					vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
					isolated.env = {}; isolated.bin = ""; isolated.agent = "";
					await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
				}
			}
		}
	}, 120_000);
});
