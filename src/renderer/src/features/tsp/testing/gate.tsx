import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { TspHostSnapshot } from "@shared/tsp-host";
import type { SessionController, SessionView } from "../../../state/session";
import { useApp } from "../../../state/app";
import { registerComposerEditor } from "../../../chat/composer/drafts";
import { TerminalSheet } from "../../palette/TerminalSheet";
import { MotionProvider } from "../../../ui/motion";
import { TooltipProvider } from "../../../ui/Tooltip";
import "../../../i18n";
import "../../../theme/tokens.css";
import "../../../theme/base.css";
import "../../../ui/ui.css";
import "../../../ui/rich-content.css";
import "../../../chat/transcript/transcript.css";
import "../../../tool-render/tool-render.css";
import "../../../tool-render/structured.css";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";

// Only the preload and session source are replaced. Sheet, focus handling, renderers and CSS are production code.
interface CapturedCall { channel: string; args: unknown[] }
interface Gate {
	calls: CapturedCall[];
	view(): SessionView;
	open(snapshot: TspHostSnapshot): void;
	update(snapshot: TspHostSnapshot): void;
	invoke(channel: string, args: unknown[]): TspHostSnapshot | undefined;
	buttonVisible(button: HTMLButtonElement): boolean;
}
const state = window as unknown as { gateSnapshot: TspHostSnapshot; gateListeners: Set<(snapshot: TspHostSnapshot) => void>; gate: Gate };
let view = { mode: "live", readOnly: false, host: { hostId: "gate", generation: 1, phase: "live", transport: "tsp", cols: 80, rows: 24 } } as unknown as SessionView;
const sessionListeners = new Set<() => void>();
const controller = { getSnapshot: () => view, subscribe: (listener: () => void) => { sessionListeners.add(listener); return () => sessionListeners.delete(listener); }, ensureLive: async () => {}, restart: async () => {} } as unknown as SessionController;
function buttonVisible(button: HTMLButtonElement): boolean {
	button.scrollIntoView({ block: "nearest", inline: "nearest" });
	const box = button.getBoundingClientRect();
	if (box.width <= 0 || box.height <= 0 || box.left < 0 || box.right > innerWidth || box.top < 0 || box.bottom > innerHeight) return false;
	for (let ancestor: HTMLElement | null = button; ancestor; ancestor = ancestor.parentElement) {
		const style = getComputedStyle(ancestor);
		if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
		const clip = ancestor.getBoundingClientRect();
		const left = clip.left + ancestor.clientLeft;
		const top = clip.top + ancestor.clientTop;
		if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && (box.left < left - 1 || box.right > left + ancestor.clientWidth + 1)) return false;
		if (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (box.top < top - 1 || box.bottom > top + ancestor.clientHeight + 1)) return false;
	}
	const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
	return target === button || (target !== null && button.contains(target));
}
function Harness() {
	const open = useApp(app => app.terminalTabId === "gate");
	const composer = useRef<HTMLTextAreaElement>(null);
	useEffect(() => registerComposerEditor("gate", { focus: () => composer.current?.focus(), insertAtCaret: () => {} }), []);
	useEffect(() => {
		const calls: CapturedCall[] = [];
		const update = (snapshot: TspHostSnapshot) => {
			state.gateSnapshot = snapshot;
			view = { ...view, mode: snapshot.generation === 0 ? "starting" : "live", host: { ...view.host!, generation: snapshot.generation, phase: snapshot.generation === 0 ? "connecting" : "live", link: null } };
			for (const listener of sessionListeners) listener();
			for (const listener of state.gateListeners) listener(snapshot);
		};
		state.gate = {
			calls, buttonVisible, update, view: () => view,
			open(snapshot) { calls.length = 0; update(snapshot); useApp.setState({ terminalTabId: "gate" }); },
			invoke(channel, args) {
				if (["host:tsp-event", "host:tsp-answer", "host:keys"].includes(channel)) calls.push({ channel, args });
				return channel === "host:tsp-snapshot" ? state.gateSnapshot : undefined;
			},
		};
	}, []);
	return <MotionProvider><TooltipProvider><main className="h-full bg-page p-4 text-fg"><label>Message to omp<textarea ref={composer} aria-label="Message to omp" /></label>{open && <TerminalSheet tabId="gate" controller={controller} />}</main></TooltipProvider></MotionProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
