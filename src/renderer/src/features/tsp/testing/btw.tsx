import { ChatCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BtwState, BtwTurn } from "@shared/contracts/btw";
import type { TspNode } from "@shared/tsp";
import { btwOverlayTopics, mergeBtwTopics, projectBtw, resolveBtwTopic } from "@shared/tsp/btw";
import { BtwPaneContent } from "../../btw/BtwPane";
import { MotionProvider } from "../../../ui/motion";
import { TooltipProvider } from "../../../ui/Tooltip";
import recorded from "../../../../../main/omp/tsp/fixtures/18.15.0/btw-follow-up.btw.json";
import "../../../i18n";
import "../../../theme/tokens.css";
import "../../../theme/base.css";
import "../../../ui/ui.css";
import "../../../ui/rich-content.css";
import "../../../chat/transcript/transcript.css";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";

interface Harness { render(state: BtwState): void; state: BtwState; calls: { channel: string; args: unknown[] }[]; invoke(channel: string, args: unknown[]): unknown }
const target = window as unknown as { btwHarness: Harness };
const stage = recorded.stages.at(-1)!;
const overlay = projectBtw([{ open: { id: "s:1", mode: "inline" }, closed: false, suspended: false, focus: null, sequence: 1, settled: [], document: { id: "s:1", k: "col", c: [{ id: "layer", k: "col", c: [stage.overlay as TspNode] }] } }])!;
const files = stage.files.filter(file => file.path.endsWith(".json")).map(file => {
	const record = JSON.parse(file.text) as BtwTurn & { id: string; followUps?: BtwTurn[] };
	return { id: record.id, title: record.question, turns: [record, ...(record.followUps ?? [])], live: false };
});
const selectedTopic = resolveBtwTopic(overlay, files) ?? { id: "live:1" };
const initial: BtwState = { hostId: "fixture", epoch: 1, generation: 1, revision: 1, topics: mergeBtwTopics(files, overlay, selectedTopic), overlay: { epoch: 1, surfaceId: overlay.surfaceId, nodeId: overlay.nodeId, selectedTopic, topics: btwOverlayTopics(overlay, files, selectedTopic), actions: Object.keys(overlay.actions), followUp: !!overlay.field, draft: overlay.field?.text ?? null, supported: overlay.supported, notice: overlay.notice } };
function Harness() {
	const [state, setState] = useState(initial);
	useEffect(() => {
		target.btwHarness = { render: setState, state, calls: [], invoke(channel, args) { this.calls.push({ channel, args }); return channel === "btw:list" ? this.state : undefined; } };
	}, []);
	return <MotionProvider><TooltipProvider><main className="flex h-full min-h-0 gap-3 bg-canvas p-3 text-fg">
		<div className="flex min-w-0 flex-1 flex-col rounded-lg bg-sheet p-6">
			<h1 className="text-lg font-semibold">Recorded TSP chat</h1>
			<p className="mt-3 max-w-sm text-md text-fg-muted">The side question and its follow-up are read from the omp 18.15.0 recording.</p>
			<p className="mt-auto text-sm text-fg-muted">Side answers are separate.</p>
		</div>
		<aside aria-label="Side panel" className="flex min-h-0 w-[420px] shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-panel">
			<header className="flex min-h-12 items-center gap-2 border-b border-border px-3 text-md font-medium"><ChatCircle className="size-4" />Side questions</header>
			<BtwPaneContent state={state} error={null} hostId="fixture" />
		</aside>
	</main></TooltipProvider></MotionProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
