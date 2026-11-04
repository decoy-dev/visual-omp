import { ChatCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BtwState, BtwTurn } from "@shared/contracts/btw";
import type { TspNode } from "@shared/tsp";
import { btwOverlayTopics, mergeBtwTopics, projectBtw, resolveBtwTopic } from "@shared/tsp/btw";
import { BottomDrawer, BtwPaneContent } from "../../btw/BtwPaneContent";
import { MotionProvider } from "../../../ui/motion";
import { Button } from "../../../ui/Button";
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
	const [open, setOpen] = useState(true);
	useEffect(() => {
		target.btwHarness = { render: setState, state, calls: [], invoke(channel, args) { this.calls.push({ channel, args }); return channel === "btw:list" ? this.state : undefined; } };
	}, []);
	return <MotionProvider><TooltipProvider><main className="flex h-full min-h-0 bg-canvas p-3 text-fg">
		<section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg bg-sheet">
			<header className="flex min-h-12 items-center gap-2 border-b border-border px-4 text-md font-medium"><ChatCircle className="size-4" />Recorded TSP chat</header>
			<div className="relative flex min-h-0 flex-1 flex-col">
				<div inert={open} aria-hidden={open || undefined} className="flex min-h-0 flex-1 flex-col">
					<div className="flex-1 overflow-y-auto px-6 py-5">
						<p className="mb-5 ml-auto max-w-md rounded-lg bg-inset px-4 py-3 text-md">Explain how the side-question history is stored.</p>
						<p className="max-w-xl text-md leading-relaxed">The side question and its follow-up are read from the omp 18.15.0 recording. The main conversation remains visible while the side answer is open.</p>
					</div>
					<div className="mx-auto mb-4 w-full max-w-[760px] px-4">
						<div className="rounded-xl border border-border bg-panel p-3">
							<textarea disabled={open} aria-label="Message omp" placeholder="Ask omp to change something…" className="min-h-14 w-full resize-none bg-transparent text-md text-fg-muted outline-none" />
							<div className="flex justify-end"><Button size="sm" variant="primary" disabled={open}>Send message</Button></div>
						</div>
						<p className="mt-2 text-sm text-fg-muted">Finish the side question to send a message.</p>
					</div>
				</div>
				<BottomDrawer open={open} onDismiss={() => setOpen(false)} label="Side question">
					<header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-4">
						<ChatCircle className="size-4 text-fg-muted" /><h2 className="min-w-0 flex-1 text-md font-medium">Side question</h2>
						<Button size="sm" variant="primary" onClick={() => setOpen(false)}>Done</Button>
					</header>
					<BtwPaneContent state={state} error={null} hostId="fixture" drawer />
				</BottomDrawer>
			</div>
		</section>
	</main></TooltipProvider></MotionProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
