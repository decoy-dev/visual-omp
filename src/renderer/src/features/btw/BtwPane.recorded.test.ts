// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { BtwState, BtwTopic, BtwTurn } from "@shared/contracts/btw";
import { btwOverlayTopics, mergeBtwTopics, projectBtw, resolveBtwTopic } from "@shared/tsp/btw";
import type { SessionController, SessionView } from "../../state/session";
import { TooltipProvider } from "../../ui";
import { BtwPane } from "./BtwPane";
import { PresentationVisibility, presentationClaims } from "../../state/tsp/presentation-claims";
import { FixtureDocuments } from "../tsp/testing/documents";
import messagesRaw from "../../../../main/omp/tsp/fixtures/18.15.0/btw-open-main-abort.messages.jsonl?raw";
import recorded from "../../../../main/omp/tsp/fixtures/18.15.0/btw-open-main-abort.btw.json";
import "../../i18n";

vi.mock("../session-tools/typed", () => ({ sendSlashCommand: vi.fn() }));
vi.mock("../session-tools/drive", () => ({ reportFailure: vi.fn() }));
vi.mock("../panes/common", async original => ({ ...await original<object>(), usePaneVisible: () => true }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLElement | undefined;
const originalVomp = window.vomp;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; container?.remove(); container = undefined; window.vomp = originalVomp; });

it("renders each recorded streaming frame and sidecar handoff without losing the claimed answer", async () => {
	const messages: { verb: string; body: unknown }[] = messagesRaw.trim().split("\n").map(line => JSON.parse(line));
	const documents = new FixtureDocuments();
	const listeners = new Set<(state: BtwState) => void>();
	let files: BtwTopic[] = [];
	let revision = 0;
	let state: BtwState;
	const update = () => {
		const protocol = documents.snapshot();
		const projection = projectBtw(protocol.surfaces);
		const selectedTopic = projection?.turns.length ? resolveBtwTopic(projection, files) ?? { id: "live:1" } : null;
		state = { hostId: "pane-recorded", generation: 1, epoch: protocol.epoch, revision: ++revision,
			topics: mergeBtwTopics(files, projection, { id: "live:1" }),
			overlay: projection ? { epoch: protocol.epoch, surfaceId: projection.surfaceId, nodeId: projection.nodeId, selectedTopic,
				topics: btwOverlayTopics(projection, files, selectedTopic), actions: Object.keys(projection.actions), followUp: !!projection.field,
				draft: projection.field?.text ?? null, supported: projection.supported, notice: projection.notice } : null };
		for (const listener of listeners) listener(state);
		return projection;
	};
	documents.receive({ verb: messages[0]!.verb, body: JSON.stringify(messages[0]!.body) }); update();
	window.vomp = { platform: "darwin", invoke: async (channel: string) => channel === "btw:list" ? state : undefined,
		on: (channel: string, listener: (state: BtwState) => void) => { if (channel === "btw:changed") listeners.add(listener); return () => listeners.delete(listener); } } as unknown as typeof window.vomp;
	const view = { mode: "live", readOnly: false, host: { hostId: "pane-recorded", generation: 1, tspEpoch: 1, phase: "live", transport: "tsp" } } as unknown as SessionView;
	const controller = { tabId: "pane-recorded", getSnapshot: () => view, subscribe: () => () => {} } as unknown as SessionController;
	container = document.createElement("div"); document.body.append(container); root = createRoot(container);
	const render = async (visible = true) => { await act(async () => root!.render(createElement(TooltipProvider, null, createElement(PresentationVisibility, { visible }, createElement(BtwPane, { session: controller, projectPath: null }))))); };
	await render();
	let streamingFrames = 0;
	let completedRecord: { answer: string; status: string } | undefined;
	for (let index = 1; index < messages.length; index++) {
		await act(async () => { const message = messages[index]!; documents.receive({ verb: message.verb, body: JSON.stringify(message.body) }); update(); });
		const projection = projectBtw(documents.snapshot().surfaces);
		if (projection?.turns[0]?.status === "running") {
			streamingFrames++;
			expect(container.textContent).toContain("Answering");
			if (projection.turns[0].answer) expect(container.textContent).toContain(projection.turns[0].answer.trim());
			expect(presentationClaims.getSnapshot()).toContainEqual({ hostId: "pane-recorded", epoch: 1, surfaceId: projection.surfaceId, nodeId: projection.nodeId });
		}
		for (const stage of recorded.stages.filter(stage => stage.afterMessage === index + 1)) {
			await act(async () => {
				files = stage.files.filter(file => file.path.endsWith(".json")).map(file => {
					const record = JSON.parse(file.text) as BtwTurn & { id: string; followUps?: BtwTurn[] };
					return { id: record.id, title: record.question, live: false, turns: [record, ...(record.followUps ?? [])] };
				});
				update();
			});
			if (stage.stage === "after-main-abort-side-running") {
				expect(container.textContent).toContain("Side answer continues");
				expect([...container.querySelectorAll("button")].some(button => button.textContent?.trim() === "Stop side answer")).toBe(true);
				expect(container.textContent).not.toContain("Complete");
			}
			if (stage.stage === "after-main-abort-side-complete") {
				completedRecord = JSON.parse(stage.files.find(file => file.path.endsWith(".json"))!.text);
				expect(projection?.turns[0]?.answer).toBe(completedRecord!.answer);
				expect(container.textContent).toContain(completedRecord!.answer);
				expect(container.textContent).toContain("Complete");
				expect([...container.querySelectorAll("button")].some(button => button.textContent?.trim() === "Stop side answer")).toBe(false);
				await render(false); expect(presentationClaims.getSnapshot()).toEqual([]);
				await render(true); expect(presentationClaims.getSnapshot()).toHaveLength(1);
			}
		}
	}
	expect(streamingFrames).toBeGreaterThan(1);
	expect(completedRecord?.status).toBe("complete");
	expect(container.textContent).toContain(completedRecord!.answer);
	expect(presentationClaims.getSnapshot()).toEqual([]);
});
