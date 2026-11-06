import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startFixture } from "../../../../scripts/live-preview-fixture/server.mjs";
import { fixtureEnvironment } from "../../../../scripts/live-preview-fixture/environment.mjs";

const isolated = vi.hoisted(() => ({ env: {} as NodeJS.ProcessEnv, bin: "", agent: "" }));
vi.mock("../../env", () => ({ userEnv: async () => isolated.env, ptyEnv: (env: NodeJS.ProcessEnv) => env }));
vi.mock("../../ipc", () => ({ broadcast: vi.fn() }));
vi.mock("../../prefs", () => ({ getPrefs: () => ({ theme: "light", reducedMotion: "on" }) }));
vi.mock("../locate", () => ({ ompPath: async () => isolated.bin }));
vi.mock("../refused", () => ({ ompStartError: (error: unknown) => error }));
vi.mock("../paths", () => ({ agentDir: () => isolated.agent, sessionsDir: () => join(isolated.agent, "sessions") }));
vi.mock("../sessions", () => ({ findSessionFile: async () => null, onSessionsChanged: vi.fn() }));
vi.mock("electron", () => ({ BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }, dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) }, nativeTheme: { on: vi.fn(), removeListener: vi.fn(), shouldUseDarkColors: false }, systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: true }) } }));

import { SessionHost } from "../host";
import { GuestClient } from "../../../renderer/src/collab/lib/client";

describe.skipIf(!process.env.OMP_BIN || process.env.VOMP_TIMESTAMPS_LIVE !== "1" || process.platform === "win32")("recorded transcript timestamps with isolated omp", () => {
	it("retains each response's own clock through three tool rounds over two minutes", async () => {
		const root = await mkdtemp(join(tmpdir(), "vomp-timestamps-"));
		const fixture = await startFixture({ root, port: 0 });
		let host: SessionHost | undefined;
		let guest: GuestClient | undefined;
		let unsubscribe: (() => void) | undefined;
		try {
			isolated.bin = resolve(process.env.OMP_BIN!);
			isolated.env = fixtureEnvironment(root);
			isolated.agent = isolated.env.PI_CODING_AGENT_DIR!;
			vi.stubEnv("VOMP_TSP", "1");
			const evidence = process.env.VOMP_TIMESTAMP_EVIDENCE;
			if (evidence) await mkdir(evidence, { recursive: true });
			const current = host = new SessionHost({ cwd: join(root, "work"), extraArgs: ["--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--tools", "bash", "--model", "fixture/preview", "--thinking", "off"] });
			const until = async (predicate: () => boolean, timeout = 30_000) => vi.waitFor(() => {
				expect(current.state.phase, current.state.error ?? "host exited").not.toBe("exited");
				expect(predicate()).toBe(true);
			}, { timeout, interval: 50 });
			await current.start();
			await until(() => current.state.phase === "live" && !!current.state.link && current.tspSnapshot()?.availability.available === true);
			guest = new GuestClient(current.state.link!, "Timestamp fixture");
			const replica = guest;
			const observations: object[] = [];
			unsubscribe = guest.subscribe(() => {
				const snapshot = replica.getSnapshot();
				const observation = { at: Date.now(), entries: snapshot.entries, stream: snapshot.stream, active: [...snapshot.activeTools], working: snapshot.working };
				observations.push(observation);
				if (evidence) writeFileSync(join(evidence, "current.json"), JSON.stringify(observation));
			});
			guest.connect();
			await until(() => replica.getSnapshot().phase === "live");
			const started = Date.now();
			await current.submit("fixture timestamps");
			await until(() => replica.getSnapshot().entries.some(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some(block => block.type === "text" && block.text === "The three timestamp rounds finished.")), 180_000);
			const ended = Date.now();
			const entries = replica.getSnapshot().entries;
			const responses = entries.flatMap(entry => entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []);
			expect(responses).toHaveLength(4);
			expect(ended - started).toBeGreaterThan(130_000);
			for (const response of responses) {
				expect(response.timestamp).toBeGreaterThanOrEqual(started);
				expect(response.timestamp).toBeLessThanOrEqual(ended);
			}
			expect(responses[2]!.timestamp - responses[0]!.timestamp).toBeGreaterThan(85_000);
			expect(ended - responses[3]!.timestamp).toBeLessThan(5_000);
			expect(current.state.transport).toBe("tsp");
			expect(current.screenReadAttempts()).toEqual([]);
			if (evidence) {
				await writeFile(join(evidence, "observations.json"), JSON.stringify({ root, started, ended, observations }));
				await writeFile(join(evidence, "session.jsonl"), await readFile(current.state.sessionFile!, "utf8"));
			}
		} finally {
			unsubscribe?.(); guest?.close();
			await host?.stop();
			await fixture.close();
			vi.unstubAllEnvs();
			await rm(root, { recursive: true, force: true });
		}
	}, 220_000);
});
