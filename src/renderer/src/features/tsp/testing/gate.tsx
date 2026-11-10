import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { hookDialogTarget } from "@shared/tsp/dialogs";
import { tspHostPatch, type TspHostPatch } from "@shared/tsp/patch";
import { composerFacts } from "../../../../../main/omp/tsp/composer";
import type { CollabUiRequest, SessionEntry, ToolResultMessage } from "@oh-my-pi/pi-wire";
import type { FileRef, FileRefRequest } from "@shared/contracts/fileRefs";
import { TranscriptBody } from "../../../chat/transcript/Transcript";
import { Composer } from "../../../chat/composer/Composer";
import { SessionHeader } from "../../../chat/SessionHeader";
import { WorkingRow } from "../../../chat/ChatView";
import { Expand } from "../../../ui";
import { recordFormLayout } from "./form-layout-evidence";
import type { FormLayoutEvidence, FormLayoutRecorder } from "./form-layout-types";
import { useFiles } from "../../panes/files-store";
import { usePendingQuestion } from "../../../chat/transcript/QuestionCard";
import { ToolView } from "../../../tool-render/ToolView";
import type { ToolResultLike } from "../../../tool-render/types";
import type { GuestClient, GuestSnapshot } from "../../../collab/lib/client";
import { presentationClaims } from "../../../state/tsp/presentation-claims";
import { OmpDialogCard } from "../../session-tools/OmpDialogCard";
import { questionPresentation, SessionController, type SessionView } from "../../../state/session";
import { screenActivity, type ScreenActivityKind } from "../../../state/tsp/screen-activity";
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
	showAutomatic(snapshot: TspHostSnapshot): Promise<void>;
	beginScreenActivity(kind: ScreenActivityKind): void;
	endScreenActivity(): void;
	update(snapshot: TspHostSnapshot): void;
	invoke(channel: string, args: unknown[]): unknown;
	buttonVisible(button: HTMLButtonElement): boolean;
	showPlan(snapshot: TspHostSnapshot): void;
	showAsk(snapshot: TspHostSnapshot, request: CollabUiRequest | null, args: Record<string, unknown>, result?: ToolResultLike, classic?: boolean, entries?: SessionEntry[]): Promise<void>;
	finishForm(result: ToolResultMessage): void;
	showFormLayout(snapshot: TspHostSnapshot, request: CollabUiRequest, args: Record<string, unknown>, entries: SessionEntry[]): Promise<void>;
	startLayoutEvidence(): void;
	markLayoutEvidence(phase: string): void;
	stopLayoutEvidence(): FormLayoutEvidence;
	claims(): unknown;
	showQuestion(visible: boolean): void;
	showCommandResults(results: CommandResultRecord[]): void;
	showMarkdown(text: string): void;
	beginFormUpdates(): void;
	advanceFormRequest(request: CollabUiRequest | null): void;
	formPresentationEvents: { terminalTabId: string | null; requestId: number | null; claims: number; at: number }[];
	showReplyFiles(entries: SessionEntry[], projectPath: string): void;
	fileRequests: { request: FileRefRequest; resolve: (value: (FileRef | null)[]) => void }[];
	resolveFiles(index: number, value: (FileRef | null)[]): void;
	fileViewer(): { path: string | null; pane: string | null };
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

function AutomaticScreenHarness() {
	const session = askController!;
	const open = useApp(app => app.terminalTabId === session.tabId);
	const composer = useRef<HTMLTextAreaElement>(null);
	useEffect(() => registerComposerEditor(session.tabId, { focus: () => composer.current?.focus(), insertAtCaret: () => {} }), [session]);
	return <><OverlayWatcher /><main className="h-full bg-sheet p-4 text-fg"><label>Message to omp<textarea ref={composer} aria-label="Message to omp" /></label></main>{open && <TerminalSheet tabId={session.tabId} controller={session} />}</>;
}

/** Production transcript following and composer queue disclosures share one constrained chat column. */
function FormLayoutHarness() {
	const session = askController!;
	const current = useSessionView(session)!;
	const pending = usePendingQuestion(session, current.guest?.uiRequest ?? null);
	const open = useApp(app => app.terminalTabId === session.tabId);
	const stopFocus = useRef(false);
	return <div data-form-layout className="grid h-full min-h-0 grid-cols-[236px_minmax(0,1fr)_344px] gap-3 bg-bg text-fg">
		<aside aria-label="Fixture chats" className="bg-chrome p-4 text-chrome-fg"><h2>Current chats</h2><p className="mt-4">04 Ask form</p></aside>
		<section data-chat-column aria-label="Form layout chat" className="flex min-h-0 min-w-0 flex-col bg-sheet">
			<div data-gate-header><SessionHeader session={session} fallbackTitle="04 Ask form" /></div>
			<TranscriptBody scope={session} entries={current.guest?.entries ?? []} mode="normal" working={current.working} activeTools={current.guest?.activeTools} ready identity="form-layout" pendingQuestion={pending} />
			<div data-gate-working><Expand open={!questionPresentation(current).pending && (current.working || current.guest?.awaitingAsyncWork === true)}><WorkingRow view={current} session={session} activity={null} stopFocus={stopFocus} /></Expand></div>
			<div data-gate-composer className="mx-auto w-full max-w-[calc(var(--chat-max)+48px)] shrink-0 px-6 pb-4"><Composer session={session} /></div>
		</section>
		<aside aria-label="Fixture side panel" className="my-3 mr-3 rounded-lg border border-border bg-panel p-4"><h2>Tasks</h2><p className="mt-4">Release fixture questions</p></aside>
		<OverlayWatcher />
		{open && <TerminalSheet tabId={session.tabId} controller={session} />}
	</div>;
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
	const [formLayout, setFormLayout] = useState(false);
	const [automatic, setAutomatic] = useState(false);
	const [showQuestion, setShowQuestion] = useState(true);
	const [commandResults, setCommandResults] = useState<CommandResultRecord[]>([]);
	const [markdown, setMarkdown] = useState<string | null>(null);
	const [replyFiles, setReplyFiles] = useState<{ entries: SessionEntry[]; projectPath: string } | null>(null);
	useEffect(() => registerComposerEditor("gate", { focus: () => composer.current?.focus(), insertAtCaret: () => {} }), []);
	useEffect(() => {
		const calls: CapturedCall[] = [];
		const formPresentationEvents: Gate["formPresentationEvents"] = [];
		const fileRequests: Gate["fileRequests"] = [];
		let layoutRecorder: FormLayoutRecorder | null = null;
		let releaseScreenActivity: (() => void) | undefined;
		const unsubscribe = useApp.subscribe((next, previous) => {
			if (next.terminalTabId !== previous.terminalTabId) formPresentationEvents.push({ terminalTabId: next.terminalTabId, requestId: view.guest?.uiRequest?.reqId ?? null, claims: presentationClaims.getSnapshot().length, at: performance.now() });
		});
		// Entry points select one harness mode and release the previous mode's native claims.
		const resetModes = () => {
			releaseScreenActivity?.(); releaseScreenActivity = undefined;
			setAutomatic(false);
			setAsk(null); setShowPlan(false); setCommandResults([]); setShowQuestion(true);
			setMarkdown(null);
			setReplyFiles(null);
			formAnswerGaps = false;
			setFormLayout(false);
			useApp.setState({ terminalTabId: null });
			view = { ...view, working: false, guest: null, host: { ...view.host!, transport: "tsp" } };
		};
		const ensureGateController = async () => {
			if (!askController) {
				const ensureLive = SessionController.prototype.ensureLive;
				SessionController.prototype.ensureLive = async () => {};
				try {
					const tabId = await useApp.getState().newChat("/tmp/vomp-fixture");
					if (!tabId) throw new Error("The gate could not create a chat");
					askController = controllerFor(tabId)!;
				} finally { SessionController.prototype.ensureLive = ensureLive; }
				view = { ...askController.getSnapshot(), ...view };
				askController.getSnapshot = () => view;
				askController.subscribe = controller.subscribe;
				askController.answer = controller.answer;
				askController.ensureLive = controller.ensureLive;
				askController.guestClient = () => guest as GuestClient;
			}
			useApp.setState({ view: "chat", activeTabId: askController.tabId, splitTabId: null });
			return askController;
		};
		const update = (snapshot: TspHostSnapshot) => {
			revision = Math.max(revision + 1, snapshot.revision);
			snapshot = { ...snapshot, revision };
			state.gateSnapshot = snapshot;
			view = { ...view, mode: snapshot.generation === 0 ? "starting" : "live", host: { ...view.host!, generation: snapshot.generation, phase: snapshot.generation === 0 ? "connecting" : "live", link: null, tspAvailability: snapshot.availability, tspComposer: composerFacts(snapshot.surfaces) } };
			for (const listener of sessionListeners) listener();
			const patch = tspHostPatch(null, snapshot);
			for (const listener of state.gateListeners) listener(patch);
		};
		state.gate = {
			calls, buttonVisible, update, view: () => view,
			formPresentationEvents,
			async showAutomatic(snapshot) { await ensureGateController(); calls.length = 0; resetModes(); formPresentationEvents.length = 0; update(snapshot); setAutomatic(true); },
			beginScreenActivity(kind) { releaseScreenActivity?.(); releaseScreenActivity = screenActivity.hold(state.gateSnapshot, kind); },
			endScreenActivity() { releaseScreenActivity?.(); releaseScreenActivity = undefined; },
			beginFormUpdates() { formPresentationEvents.length = 0; formAnswerGaps = true; },
			advanceFormRequest(request) { publishFormRequest(request, request ? [request] : []); },
			async showFormLayout(snapshot, request, args, entries) {
				await state.gate.showAsk(snapshot, request, args, undefined, false, entries);
				setFormLayout(true);
			},
			startLayoutEvidence() { layoutRecorder?.stop(); layoutRecorder = recordFormLayout(() => ({ requestId: view.guest?.uiRequest?.reqId ?? null, claims: presentationClaims.getSnapshot().length })); },
			markLayoutEvidence(phase) { if (!layoutRecorder) throw new Error("Layout recording has not started"); layoutRecorder.mark(phase); },
			stopLayoutEvidence() { if (!layoutRecorder) throw new Error("Layout recording has not started"); const evidence = layoutRecorder.stop(); layoutRecorder = null; return evidence; },
			open(snapshot) { calls.length = 0; resetModes(); update(snapshot); setCardInstance(value => value + 1); useApp.setState({ terminalTabId: hookDialogTarget(snapshot.surfaces) ? null : "gate" }); },
			showPlan(snapshot) { calls.length = 0; resetModes(); update(snapshot); setShowPlan(true); },
			claims: () => presentationClaims.getSnapshot(),
			showQuestion: setShowQuestion,
			async showAsk(snapshot, request, args, result, classic = false, entries = []) {
				calls.length = 0;
				resetModes();
				await ensureGateController();
				const toolCallId = entries.flatMap(entry => entry.type === "message" && entry.message.role === "assistant" ? entry.message.content : []).flatMap(part => part.type === "toolCall" && part.name === "ask" ? [part.id] : [])[0] ?? "form";
				const replica: GuestSnapshot = { phase: "live", endedReason: null, header: null, state: null, agents: [], progress: new Map(), lifecycle: new Map(), streamDone: false, backgroundTools: new Map(), notices: [], thinkingSelector: null, readOnly: false, loading: null, uiRequest: request, pendingUiRequests: request ? [request] : [], activeTools: new Map(result ? [] : [[toolCallId, { toolCallId, toolName: "ask", args, intent: undefined, startedAt: 0 }]]), entries, stream: null, working: !result };
				view = { ...view, working: !result, host: { ...view.host!, transport: classic ? "classic" : "tsp" }, guest: replica };
				update(snapshot);
				setShowPlan(false);
				setAsk({ request, args, result });
			},
			finishForm(result) {
				if (!view.guest) throw new Error("No form is open in the gate");
				if (!view.guest.activeTools.has(result.toolCallId)) throw new Error("The recorded result must complete the gate's active form tool call");
				const entry: SessionEntry = { type: "message", id: "gate-result", parentId: null, timestamp: new Date(0).toISOString(), message: result };
				view = { ...view, working: false, guest: { ...view.guest, working: false, uiRequest: null, pendingUiRequests: [], activeTools: new Map(), entries: [...view.guest.entries, entry] } };
				setAsk(previous => previous && { ...previous, request: null, result });
				for (const listener of sessionListeners) listener();
			},
			showCommandResults(results) { calls.length = 0; resetModes(); setCommandResults(results); },
			showMarkdown(text) { calls.length = 0; resetModes(); setMarkdown(text); },
			fileRequests,
			resolveFiles(index, value) { fileRequests[index]!.resolve(value); },
			fileViewer() { return { path: useFiles.getState().byView["gate-reply"]?.active ?? null, pane: useApp.getState().docks["gate-reply"]?.pane ?? null }; },
			showReplyFiles(entries, projectPath) {
				calls.length = 0; fileRequests.length = 0; resetModes();
				const app = useApp.getState();
				useApp.setState({ view: "chat", activeTabId: "gate-reply", tabs: [...app.tabs.filter(tab => tab.id !== "gate-reply"), { id: "gate-reply", projectPath, sessionFile: null, title: "Reply files" }] });
				setReplyFiles({ entries, projectPath });
			},
			invoke(channel, args) {
				if (["host:tsp-event", "host:tsp-answer", "host:keys"].includes(channel)) calls.push({ channel, args });
				if (channel === "fs:resolveRefs") {
					const { promise, resolve } = Promise.withResolvers<(FileRef | null)[]>();
					fileRequests.push({ request: args[0] as FileRefRequest, resolve });
					return promise;
				}
				return channel === "host:tsp-snapshot" ? state.gateSnapshot : undefined;
			},
		};
		return () => { unsubscribe(); releaseScreenActivity?.(); layoutRecorder?.stop(); };
	}, []);
	return <MotionProvider><TooltipProvider>{automatic ? <AutomaticScreenHarness /> : formLayout ? <FormLayoutHarness /> : <main className="h-full overflow-auto bg-sheet p-4 text-fg">{replyFiles ? <section aria-label="Reply file references" className="flex h-full flex-col"><TranscriptBody scope={{ tabId: "gate-reply", projectPath: replyFiles.projectPath }} entries={replyFiles.entries} mode="normal" ready identity={replyFiles.projectPath} /></section> : <>{markdown !== null && <section aria-label="Assistant message" className="mx-auto mt-6 max-w-3xl"><Markdown text={markdown} /></section>}{ask ? <AskHarness args={ask.args} result={ask.result} showQuestion={showQuestion} /> : <><label>Message to omp<textarea ref={composer} aria-label="Message to omp" /></label><OmpDialogCard key={cardInstance} session={controller} />{showPlan && <PlanReviewCard session={controller} />}{commandResults.length > 0 && <section aria-label="Command feedback" className="mx-auto mt-6 max-w-3xl space-y-6">{commandResults.map(result => <CommandResultRow key={result.id} result={result} onDismiss={() => setCommandResults(items => items.filter(item => item.id !== result.id))} />)}</section>}</>}{!ask && open && <TerminalSheet tabId="gate" controller={controller} />}</>}</main>}</TooltipProvider></MotionProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
