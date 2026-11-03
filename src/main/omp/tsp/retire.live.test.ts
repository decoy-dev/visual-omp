import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TspNode } from "@shared/tsp";
import type { TspRendererEvent } from "@shared/tsp-host";
import { hookDialogTarget } from "@shared/tsp/dialogs";
import { planChoice, planReview } from "@shared/tsp/plan-review";
import { TSP_ACTIONS, TSP_ROLES } from "@shared/tsp/roles";
import { treeSelector } from "@shared/tsp/tree-navigation";
import { liveSurfaces, walkNodes } from "@shared/tsp/view-state";
import { scriptedProvider, type ScriptedProvider, type ScriptedReply } from "./testing/scripted-provider";

// Only environment/desktop integration is replaced. The PTY, relay, collab registry,
// native extension, TSP transport and guarded SessionHost input paths are production code.
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

type ProviderRequest = { model: string; messages: { role: string; content?: unknown; tool_calls?: { function: { name: string; arguments: string } }[] }[] };
const fixtures = resolve("src/main/omp/tsp/fixtures");

// This gate does not mount a renderer. ComposerPolling.test.ts and typed.test.ts
// independently cover absence of the renderer's classic 1000/450-ms screen polls.
describe.skipIf(!process.env.OMP_BIN || process.platform === "win32")("TSP painted-reader retirement with a production host", () => {
	it("keeps one host through message, command, hook, tree, model, thinking, plan and shutdown without screen reads", async () => {
		const root = await mkdtemp(join(tmpdir(), "vomp-tsp-retire-"));
		let host: SessionHost | undefined;
		let provider: ScriptedProvider | undefined;
		let guest: GuestClient | undefined;
		let unsubscribeGuest: (() => void) | undefined;
		try {
			const home = join(root, "home"), agent = join(root, "agent");
			await Promise.all([mkdir(home), mkdir(agent)]);
			isolated.bin = resolve(process.env.OMP_BIN!);
			isolated.agent = agent;
			isolated.env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), PI_CODING_AGENT_DIR: agent, PI_CONFIG_DIR: agent, TMPDIR: root, TERM: "xterm-256color", COLORTERM: "truecolor" };

			// Reuse the recorder's checked-in plan conversation, including both exact
			// write calls, rather than introduce another version of the plan workflow.
			const recordedPlan = JSON.parse(await readFile(join(fixtures, "18.15.0/plan-review-refine.provider.json"), "utf8")) as ProviderRequest[];
			const planCalls = recordedPlan.at(-1)!.messages.flatMap(message => message.tool_calls ?? []);
			expect(planCalls).toHaveLength(2);
			const script: ScriptedReply[] = [
				{ text: "Fixture retirement answer." },
				...planCalls.map(call => ({ tool: { name: call.function.name, arguments: JSON.parse(call.function.arguments) as object } })),
				{ text: "Fixture refined plan includes the empty state." },
			];
			const models = ["large", "small"].map(size => ({ id: `fixture-${size}`, name: `Fixture ${size}`, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: size === "large" ? 128000 : 32000, maxTokens: 4096 }));
			provider = await scriptedProvider(script, agent, models);
			await writeFile(join(agent, "config.yml"), JSON.stringify({ setupVersion: 999, startup: { setupWizard: false, checkUpdate: false, changelogMode: "hidden", quiet: true }, marketplace: { autoUpdate: "off" }, worktree: { onStart: "off", onExit: "keep" }, autocomplete: { enabled: false }, composer: { predictions: false }, recap: { enabled: false }, memory: { enabled: false }, idle: { enabled: false }, branchSummary: { enabled: false }, tools: { approvalMode: "yolo" }, modelRoles: { default: "fixture/fixture-large", smol: "fixture/fixture-small", plan: "fixture/fixture-small" } }));
			const seed = await readFile(join(fixtures, "extension/tree-session.jsonl"), "utf8");
			const sessionFile = join(root, "tree-session.jsonl");
			await writeFile(sessionFile, seed.replaceAll("/tmp/vomp-fixture", root));
			vi.stubEnv("VOMP_TSP", "1");
			const current = host = new SessionHost({ cwd: root, resumeFile: sessionFile, extraArgs: ["--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--extension", join(fixtures, "extension/vomp-fixture.mjs"), "--model", "fixture/fixture-large", "--thinking", "off", "--tools", "write,read"] });
			const waitFor = async (label: string, predicate: () => boolean) => {
				await vi.waitFor(() => {
					expect(current.state.phase, `${label}: ${current.state.error ?? current.state.exitReason ?? "unexpected exit"}`).not.toBe("exited");
					expect(current.tspSnapshot()?.failure, label).toBeNull();
					expect(predicate(), label).toBe(true);
				}, { timeout: 20_000, interval: 30 });
			};
			const find = (predicate: (node: TspNode) => boolean) => {
				for (const surface of liveSurfaces(current.tspSnapshot()?.surfaces ?? [])) for (const node of walkNodes(surface.document)) if (predicate(node)) return { surface, node };
				return undefined;
			};
			const send = (event: TspRendererEvent) => current.tspEvent(current.state.generation, event, current.tspSnapshot()!.epoch);
			const noReads = (step: string) => expect(current.screenReadAttempts(), step).toEqual([]);
			const requestCount = (count: number, step: string) => {
				const calls = (provider!.requests as ProviderRequest[]).map(request => ({
					model: request.model, tail: JSON.stringify(request.messages.at(-1)).slice(-1500),
					system: JSON.stringify(request.messages.find(message => message.role === "system")?.content).slice(-1500),
				}));
				expect(calls.length, `${step}: ${JSON.stringify(calls)}`).toBe(count);
			};
			const ready = () => current.tspSnapshot()?.availability.available === true;
			const toast = (text: string) => !!find(node => node.k === "toast" && (node.p?.text ?? "").includes(text));
			const transcript = (text: string) => guest!.getSnapshot().entries.some(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some(part => part.type === "text" && part.text.includes(text)));
			let questionRevision = 0;
			const mirrorQuestions = () => {
				const snapshot = current.tspSnapshot(), replica = guest?.getSnapshot();
				if (snapshot && replica) current.tspQuestions({ hostId: current.id, generation: current.state.generation, epoch: snapshot.epoch, connection: replica.uiConnection ?? 0, revision: ++questionRevision, connected: replica.phase === "live", requests: [...(replica.pendingUiRequests ?? [])] });
			};
			const connectGuest = async () => {
				await waitFor("collab link", () => current.state.phase === "live" && !!current.state.link);
				if (!guest || guestLink !== current.state.link) {
					unsubscribeGuest?.(); guest?.close();
					guestLink = current.state.link!;
					guest = new GuestClient(guestLink, "Retirement gate");
					unsubscribeGuest = guest.subscribe(mirrorQuestions);
					guest.connect();
				}
				await waitFor("collab transcript", () => guest!.getSnapshot().phase === "live");
				mirrorQuestions();
			};
			let guestLink = "";

			await current.start();
			await waitFor("startup composer", ready);
			await connectGuest();
			const identity = { id: current.id, pid: current.state.pid };
			expect(current.state.transport).toBe("tsp");
			expect(guest!.getSnapshot().entries.some(entry => entry.id === "00000006")).toBe(true);
			noReads("startup");

			await current.submit("Fixture retirement prompt");
			await waitFor("assistant answer", () => transcript("Fixture retirement answer.") && !guest!.getSnapshot().working && ready());
			expect((provider.requests as ProviderRequest[])[0]!.messages.at(-1)!.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("Fixture retirement prompt") })]));
			noReads("message");
			requestCount(1, "message provider calls");

			// /rename also asks the smol model for an icon, even with --no-title.
			// Use the recorded, model-free command to keep plan replies isolated.
			await current.submit("/hotkeys");
			await waitFor("keyboard shortcuts", () => !!find(node => node.p?.role === "omp.overlay.hotkeys"));
			const hotkeys = find(node => node.p?.role === "omp.overlay.hotkeys")!;
			expect(hotkeys.node.k === "overlay" && hotkeys.node.p?.head).toBe("Keyboard shortcuts");
			expect([...walkNodes(hotkeys.node)].some(node => node.k === "table" && node.p?.role === "omp.hotkeys.table")).toBe(true);
			expect(ready()).toBe(false);
			await current.keys("escape", current.state.generation, current.tspSnapshot()!.epoch);
			await waitFor("closed shortcuts", () => !find(node => node.p?.role === "omp.overlay.hotkeys") && ready());
			noReads("slash command");
			requestCount(1, "hotkeys provider calls");

			await current.submit("/vomp-fixture-input");
			await waitFor("hook input", () => hookDialogTarget(current.tspSnapshot()!.surfaces)?.dialog.body.kind === "input");
			mirrorQuestions();
			const hook = hookDialogTarget(current.tspSnapshot()!.surfaces)!;
			expect(hook.dialog.title).toBe("Enter a fixture value");
			if (hook.dialog.body.kind === "select") throw new Error("Expected fixture text input");
			await current.tspAnswer(current.state.generation, { kind: "text", sf: hook.surface.open.id, id: hook.node.id, target: hook.dialog.body.target, len: hook.dialog.body.value.length, text: "Retirement hook answer café" }, current.tspSnapshot()!.epoch);
			await waitFor("hook result", () => toast('Fixture input answer: "Retirement hook answer café"') && !hookDialogTarget(current.tspSnapshot()!.surfaces) && ready());
			noReads("hook answer");
			requestCount(1, "hook provider calls");

			await current.submit("/tree");
			await waitFor("session tree", () => !!treeSelector(current.tspSnapshot()!.surfaces));
			const tree = treeSelector(current.tspSnapshot()!.surfaces)!;
			await current.tspTreeActivate(current.state.generation, current.tspSnapshot()!.epoch, tree.surface.open.id, tree.node.id, "00000003");
			await waitFor("restored branch draft", () => ready() && !treeSelector(current.tspSnapshot()!.surfaces) && current.composerFacts().text === "Add a branch for the alternate fixture answer.");
			await connectGuest();
			requestCount(1, "tree provider calls");
			await current.withEditorInput(input => input.edit(0, current.composerFacts().text.length, "", 0));
			await waitFor("cleared restored draft", () => current.composerFacts().text === "");
			noReads("tree navigation");

			await waitFor("model action", () => !!find(node => node.p?.role === TSP_ROLES.composerModel && node.p?.actions?.click === TSP_ACTIONS.model));
			const model = find(node => node.p?.role === TSP_ROLES.composerModel && node.p?.actions?.click === TSP_ACTIONS.model)!;
			await send({ ev: "action", sf: model.surface.open.id, id: model.node.id, act: TSP_ACTIONS.model });
			await waitFor("model picker", () => !!find(node => node.k === "picker" && !!node.p?.items?.some(item => item.id === "fixture/fixture-small")));
			const picker = find(node => node.k === "picker" && !!node.p?.items?.some(item => item.id === "fixture/fixture-small"))!;
			await send({ ev: "activate", sf: picker.surface.open.id, id: picker.node.id, item: "fixture/fixture-small" });
			await waitFor("changed model identity", () => ready() && guest!.getSnapshot().state?.model?.id === "fixture-small");
			noReads("model change");
			// Exercise Auto and then a fixed level. Leaving Auto selected would run
			// omp's thinking judge on the plan prompt and consume a plan tool reply.
			for (const expectedLevel of ["auto", "minimal"]) {
				await waitFor("thinking action", () => !!find(node => node.p?.actions?.click === TSP_ACTIONS.thinkingCycle));
				const thinking = find(node => node.p?.actions?.click === TSP_ACTIONS.thinkingCycle)!;
				await send({ ev: "action", sf: thinking.surface.open.id, id: thinking.node.id, act: TSP_ACTIONS.thinkingCycle });
				await waitFor(`thinking level ${expectedLevel}`, () => {
					const editor = find(node => node.p?.role === TSP_ROLES.editor);
					const node = editor && [...walkNodes(editor.node)].find(node => node.k === "effort");
					const replica = guest!.getSnapshot();
					// The document preserves Auto while collab state reports its resolved effort.
					return node?.k === "effort" && node.p?.level === expectedLevel
						&& (expectedLevel === "auto" ? replica.autoThinking === true : replica.autoThinking === false && replica.state?.thinkingLevel === expectedLevel);
				});
			}
			noReads("thinking change");

			await current.submit("/plan Draft a fixture plan");
			await waitFor("plan review", () => {
				if (planReview(current.tspSnapshot()!.surfaces)) return true;
				const calls = (provider!.requests as ProviderRequest[]).map(request => ({ model: request.model, tail: request.messages.at(-1) }));
				const notices = [...liveSurfaces(current.tspSnapshot()!.surfaces)].flatMap(surface => [...walkNodes(surface.document)]).filter(node => node.k === "toast" || node.p?.role === TSP_ROLES.noticeError);
				expect(false, JSON.stringify({ calls, notices })).toBe(true);
				return false;
			});
			const review = planReview(current.tspSnapshot()!.surfaces)!;
			expect(review.body).toContain("Cover the consumer-visible result.");
			expect(ready()).toBe(false);
			await send(planChoice(review, "refine"));
			await waitFor("plan refinement composer", () => !planReview(current.tspSnapshot()!.surfaces) && ready());
			await current.submit("Refine the plan: include the empty state.");
			await waitFor("refined plan answer", () => transcript("Fixture refined plan includes the empty state.") && !guest!.getSnapshot().working && ready());
			requestCount(4, "plan provider calls");
			const finalRequest = (provider.requests as ProviderRequest[]).at(-1)!;
			expect(finalRequest.model).toBe("fixture-small");
			expect(finalRequest.messages.at(-1)!.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: "Refine the plan: include the empty state." })]));
			noReads("plan review and refinement");
			expect({ id: current.id, pid: current.state.pid }).toEqual(identity);

			await current.stop();
			expect(current.state).toMatchObject({ phase: "exited", exitCode: 0, error: null, restoreAvailable: false });
			noReads("shutdown");
		} finally {
			unsubscribeGuest?.(); guest?.close();
			try { if (host && host.state.phase !== "exited") await host.stop(); }
			finally {
				provider?.stop();
				try { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
				finally { vi.unstubAllEnvs(); isolated.env = {}; isolated.bin = ""; isolated.agent = ""; }
			}
		}
	}, 180_000);
});
