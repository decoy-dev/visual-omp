import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { hookDialogTarget } from "@shared/tsp/dialogs";
import { tspHostPatch, type TspHostPatch } from "@shared/tsp/patch";
import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { usePendingQuestion } from "../../../chat/transcript/QuestionCard";
import { ToolView } from "../../../tool-render/ToolView";
import type { ToolResultLike } from "../../../tool-render/types";
import type { GuestClient, GuestSnapshot } from "../../../collab/lib/client";
import { presentationClaims } from "../../../state/tsp/presentation-claims";
import { OmpDialogCard } from "../../session-tools/OmpDialogCard";
import { SessionController, type SessionView } from "../../../state/session";
import { controllerFor, useApp } from "../../../state/app";
import { registerComposerEditor } from "../../../chat/composer/drafts";
import { TerminalSheet } from "../../palette/TerminalSheet";
import { OverlayWatcher } from "../../palette/OverlayWatcher";
import { useSessionView } from "../../../shell/hooks";
import { MotionProvider } from "../../../ui/motion";
import { TooltipProvider } from "../../../ui/Tooltip";
import "../../../i18n";
import { PlanReviewCard } from "../../session-tools/PlanReviewCard";
import { CommandResultRow } from "../../../chat/transcript/CommandResultRow";
import type { CommandResultRecord } from "../../session-tools/results";
import { Markdown } from "../../../transcript/Markdown";
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
	showPlan(snapshot: TspHostSnapshot): void;
	showAsk(snapshot: TspHostSnapshot, request: CollabUiRequest | null, args: Record<string, unknown>, result?: ToolResultLike, classic?: boolean): Promise<void>;
	claims(): unknown;
	showQuestion(visible: boolean): void;
	showCommandResults(results: CommandResultRecord[]): void;
	showMarkdown(text: string): void;
	beginFormUpdates(): void;
	advanceFormRequest(request: CollabUiRequest | null): void;
	formPresentationEvents: { terminalTabId: string | null; requestId: number | null; claims: number }[];
}
const state = window as unknown as { gateSnapshot: TspHostSnapshot; gateListeners: Set<(patch: TspHostPatch) => void>; gate: Gate };
let view = { mode: "live", readOnly: false, host: { hostId: "gate", generation: 1, phase: "live", transport: "tsp", cols: 80, rows: 24 } } as unknown as SessionView;
let revision = 0;
const sessionListeners = new Set<() => void>();
let formAnswerGaps = false;
function publishFormRequest(request: CollabUiRequest | null, pending = view.guest?.pendingUiRequests ?? []): void {
	if (!view.guest) throw new Error("No form is open in the gate");
	view = { ...view, guest: { ...view.guest, uiRequest: request, pendingUiRequests: pending } };
	for (const listener of sessionListeners) listener();
}
const controller = { tabId: "gate", hostId: "gate", projectPath: "/tmp/vomp-fixture", sessionFile: null, getSnapshot: () => view, subscribe: (listener: () => void) => { sessionListeners.add(listener); return () => sessionListeners.delete(listener); }, ensureLive: async () => {}, restart: async () => {}, answer: (reqId: number, value?: string) => {
	state.gate.calls.push({ channel: "collab:ui-response", args: [reqId, value] });
	// GuestClient removes the displayed request immediately, retaining its pending mirror
	// until ui-request-end. The next field and main's match arrive independently.
	if (formAnswerGaps && view.guest?.uiRequest?.reqId === reqId) publishFormRequest(null);
} } as unknown as SessionController;
let askController: SessionController | null = null;
const guest = { getSnapshot: () => view.guest! };

function AskHarness({ args, result, showQuestion }: { args: Record<string, unknown>; result?: ToolResultLike; showQuestion: boolean }) {
	const controller = askController!;
	const current = useSessionView(controller);
	const pending = usePendingQuestion(controller, current?.guest?.uiRequest ?? null);
	const open = useApp(app => app.terminalTabId === controller.tabId);
	return <><OverlayWatcher /><section className="mx-auto max-w-3xl space-y-4" aria-label="Ask form"><ToolView name="ask" args={args} result={result} running={!result} defaultOpen />{showQuestion && pending && <div key={pending.key}>{pending.node}</div>}</section>{open && <TerminalSheet tabId={controller.tabId} controller={controller} />}</>;
}
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
	const [cardInstance, setCardInstance] = useState(0);
	const [showPlan, setShowPlan] = useState(false);
	const [ask, setAsk] = useState<{ request: CollabUiRequest | null; args: Record<string, unknown>; result?: ToolResultLike } | null>(null);
	const [showQuestion, setShowQuestion] = useState(true);
	const [commandResults, setCommandResults] = useState<CommandResultRecord[]>([]);
	const [markdown, setMarkdown] = useState<string | null>(null);
	useEffect(() => registerComposerEditor("gate", { focus: () => composer.current?.focus(), insertAtCaret: () => {} }), []);
	useEffect(() => {
		const calls: CapturedCall[] = [];
		const formPresentationEvents: Gate["formPresentationEvents"] = [];
		const unsubscribe = useApp.subscribe((next, previous) => {
			if (next.terminalTabId !== previous.terminalTabId) formPresentationEvents.push({ terminalTabId: next.terminalTabId, requestId: view.guest?.uiRequest?.reqId ?? null, claims: presentationClaims.getSnapshot().length });
		});
		// Entry points select one harness mode and release the previous mode's native claims.
		const resetModes = () => {
			setAsk(null); setShowPlan(false); setCommandResults([]); setShowQuestion(true);
			setMarkdown(null);
			formAnswerGaps = false;
			useApp.setState({ terminalTabId: null });
			view = { ...view, working: false, guest: null, host: { ...view.host!, transport: "tsp" } };
		};
		const update = (snapshot: TspHostSnapshot) => {
			revision = Math.max(revision + 1, snapshot.revision);
			snapshot = { ...snapshot, revision };
			state.gateSnapshot = snapshot;
			view = { ...view, mode: snapshot.generation === 0 ? "starting" : "live", host: { ...view.host!, generation: snapshot.generation, phase: snapshot.generation === 0 ? "connecting" : "live", link: null } };
			for (const listener of sessionListeners) listener();
			const patch = tspHostPatch(null, snapshot);
			for (const listener of state.gateListeners) listener(patch);
		};
		state.gate = {
			calls, buttonVisible, update, view: () => view,
			formPresentationEvents,
			beginFormUpdates() { formPresentationEvents.length = 0; formAnswerGaps = true; },
			advanceFormRequest(request) { publishFormRequest(request, request ? [request] : []); },
			open(snapshot) { calls.length = 0; resetModes(); update(snapshot); setCardInstance(value => value + 1); useApp.setState({ terminalTabId: hookDialogTarget(snapshot.surfaces) ? null : "gate" }); },
			showPlan(snapshot) { calls.length = 0; resetModes(); update(snapshot); setShowPlan(true); },
			claims: () => presentationClaims.getSnapshot(),
			showQuestion: setShowQuestion,
			async showAsk(snapshot, request, args, result, classic = false) {
				calls.length = 0;
				resetModes();
				if (!askController) {
					const ensureLive = SessionController.prototype.ensureLive;
					SessionController.prototype.ensureLive = async () => {};
					try {
						const tabId = await useApp.getState().newChat("/tmp/vomp-fixture");
						if (!tabId) throw new Error("Ask gate could not create a chat");
						askController = controllerFor(tabId)!;
					} finally { SessionController.prototype.ensureLive = ensureLive; }
					view = { ...askController.getSnapshot(), ...view };
					askController.getSnapshot = () => view;
					askController.subscribe = controller.subscribe;
					askController.answer = controller.answer;
					askController.guestClient = () => guest as GuestClient;
				}
				const replica: GuestSnapshot = { phase: "live", endedReason: null, header: null, state: null, agents: [], progress: new Map(), lifecycle: new Map(), streamDone: false, backgroundTools: new Map(), notices: [], thinkingSelector: null, readOnly: false, loading: null, uiRequest: request, pendingUiRequests: request ? [request] : [], activeTools: new Map(result ? [] : [["form", { toolCallId: "form", toolName: "ask", args, intent: undefined, startedAt: 0 }]]), entries: [], stream: null, working: !result };
				view = { ...view, working: !result, host: { ...view.host!, transport: classic ? "classic" : "tsp" }, guest: replica };
				update(snapshot);
				setShowPlan(false);
				setAsk({ request, args, result });
			},
			showCommandResults(results) { calls.length = 0; resetModes(); setCommandResults(results); },
			showMarkdown(text) { calls.length = 0; resetModes(); setMarkdown(text); },
			invoke(channel, args) {
				if (["host:tsp-event", "host:tsp-answer", "host:keys"].includes(channel)) calls.push({ channel, args });
				return channel === "host:tsp-snapshot" ? state.gateSnapshot : undefined;
			},
		};
		return unsubscribe;
	}, []);
	return <MotionProvider><TooltipProvider><main className="h-full overflow-auto bg-sheet p-4 text-fg">{markdown !== null && <section aria-label="Assistant message" className="mx-auto mt-6 max-w-3xl"><Markdown text={markdown} /></section>}{ask ? <AskHarness args={ask.args} result={ask.result} showQuestion={showQuestion} /> : <><label>Message to omp<textarea ref={composer} aria-label="Message to omp" /></label><OmpDialogCard key={cardInstance} session={controller} />{showPlan && <PlanReviewCard session={controller} />}{commandResults.length > 0 && <section aria-label="Command feedback" className="mx-auto mt-6 max-w-3xl space-y-6">{commandResults.map(result => <CommandResultRow key={result.id} result={result} onDismiss={() => setCommandResults(items => items.filter(item => item.id !== result.id))} />)}</section>}</>}{!ask && open && <TerminalSheet tabId="gate" controller={controller} />}</main></TooltipProvider></MotionProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
