/**
 * omp questions delivered as collab requests, including field-by-field HTML forms,
 * tool approvals and extension dialogs. Saved question-list asks can use AskSeriesCard.
 */
import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { ChatCircle, Info, Question, ShieldWarning } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { deliver } from "../composer/send";
import { pendingAsk, questionPresentation, type SessionController } from "../../state/session";
import { Button, Textarea, toast } from "../../ui";
import { AskSeriesCard } from "./AskSeriesCard";
import { ASK_CHAT, ASK_NEXT, ASK_OTHER, CUSTOM_ANSWER_PREFIX, toolCallState, type RunningFormAsk } from "./askSeries";
import { useAskSeries } from "./askSeriesStore";
import { ChoiceGrid, cardClass, Heading, otherInputClass } from "./QuestionChoices";
import { useTsp } from "../../state/tsp/useTsp";
import { usePresentationClaim, type PresentationTarget } from "../../state/tsp/presentation-claims";
import { useApp } from "../../state/app";
import { ColorText } from "../../transcript/ColorText";
import { isAskFormRequest } from "../../tool-render/tools/askForm";
import { isClaimable, TSP_ROLES } from "@shared/tsp/roles";
import { walkNodes, type TspNodeTarget } from "@shared/tsp/view-state";
import type { TspHostSnapshot } from "@shared/tsp-host";

interface FormOwner extends PresentationTarget { generation: number; html: string; toolCallId: string }
interface FormOwnerRef { current: FormOwner | null }
interface NativeForms { snapshot: TspHostSnapshot; roots: TspNodeTarget[] }

/** Initial ownership is exact; a known form can settle through its local presentation changes. */
function useFormPresentation(context: NativeForms | null, reqId: number | undefined, form: RunningFormAsk, owner: FormOwnerRef): boolean {
	const covered = useApp(state => !!state.terminalTabId || !!state.sheet);
	const current = context?.snapshot;
	const forms = context?.roots.filter(({ node, surface }) => isClaimable(node, surface)) ?? [];
	const candidates = current?.questionMatches?.filter(match => (match.status === "matched" || match.status === "settling")
		&& forms.some(({ surface, node }) => surface.open.id === match.surfaceId && node.id === match.nodeId)) ?? [];
	const direct = candidates.filter(match => reqId !== undefined && match.reqId === reqId);
	const prior = owner.current;
	const carried = prior && current && prior.hostId === current.hostId && prior.generation === current.generation && prior.epoch === current.epoch && prior.html === form.html && prior.toolCallId === form.toolCallId
		? candidates.filter(match => match.surfaceId === prior.surfaceId && match.nodeId === prior.nodeId) : [];
	const match = direct.length === 1 ? direct[0] : direct.length === 0 && carried.length === 1 ? carried[0] : undefined;
	const target = current && match ? { hostId: current.hostId, generation: current.generation, epoch: current.epoch, surfaceId: match.surfaceId, nodeId: match.nodeId, ...form } : null;
	useLayoutEffect(() => {
		owner.current = target;
		return () => { owner.current = null; };
	}, [owner, current?.hostId, current?.generation, current?.epoch, target?.surfaceId, target?.nodeId, form.html, form.toolCallId]);
	usePresentationClaim(target, !covered, true);
	return target !== null;
}

function FormScreenAction({ session, standalone = false }: { session: SessionController; standalone?: boolean }) {
	const { t } = useTranslation("chat");
	return <div data-form-fallback className={standalone ? cardClass : "mt-2 flex flex-wrap items-center justify-between gap-2 text-sm text-fg-muted"}>
		{standalone ? <Heading icon={<Question className="text-accent" />}>
			<p className="text-base font-medium text-fg">{t("question.formFallbackTitle")}</p>
			<p className="mt-1 text-sm text-fg-muted">{t("question.formFallbackHelp")}</p>
		</Heading> : <p>{t("question.formViewAlternative")}</p>}
		<div className={standalone ? "mt-3 flex justify-end" : undefined}>
			<Button variant="secondary" onClick={() => useApp.getState().openTerminal(session.tabId)}>{t("question.formView")}</Button>
		</div>
	</div>;
}

function FormQuestionCard({ session, request, form, context, owner, closing, questionPending }: { session: SessionController; request: CollabUiRequest | null; form: RunningFormAsk; context: NativeForms | null; owner: FormOwnerRef; closing: boolean; questionPending: boolean }) {
	const { t } = useTranslation("chat");
	const [previous, setPrevious] = useState({ html: form.html, request });
	if (previous.html !== form.html || request && request !== previous.request) setPrevious({ html: form.html, request });
	const shown = request ?? (previous.html === form.html ? previous.request : null);
	const claimed = useFormPresentation(context, shown?.reqId, form, owner);
	const waiting = closing || !request;
	const fieldsetRef = useRef<HTMLFieldSetElement>(null);
	const formRef = useRef<HTMLDivElement>(null);
	const measured = useRef({ html: form.html, card: 0, form: 0 });
	const [minimumHeight, setMinimumHeight] = useState({ card: 0, form: 0 });
	const focusedChoice = useRef<{ html: string; request: Extract<CollabUiRequest, { kind: "select" }>; node: HTMLButtonElement } | null>(null);
	useLayoutEffect(() => {
		const focused = focusedChoice.current;
		if (!focused || !request || waiting) return;
		const prior = focused.request;
		if (focused.html !== form.html || request.kind !== "select" || request.selectionMarker !== "checkbox"
			|| request.title !== prior.title || request.options.length !== prior.options.length
			|| !request.options.every((_, index) => labelOf(request, index).label === labelOf(prior, index).label)) {
			focusedChoice.current = null;
			return;
		}
		// Disabling the retired request can blur its option. Restore it only if focus has not moved elsewhere.
		if (document.activeElement === document.body && focused.node.isConnected) focused.node.focus({ preventScroll: true });
		else if (document.activeElement !== focused.node) focusedChoice.current = null;
		focused.request = request;
	}, [form.html, request, waiting]);
	useLayoutEffect(() => {
		const fieldset = fieldsetRef.current;
		if (!fieldset) return;
		const measure = () => {
			const cardHeight = fieldset.getBoundingClientRect().height;
			const formHeight = formRef.current?.getBoundingClientRect().height ?? cardHeight;
			const previous = measured.current;
			// Both the visible card and its surrounding fallback area retain their high-water marks.
			const sameForm = previous.html === form.html;
			const next = { html: form.html, card: sameForm ? Math.max(previous.card, cardHeight) : cardHeight, form: sameForm ? Math.max(previous.form, formHeight) : formHeight };
			measured.current = next;
			setMinimumHeight({ card: next.card, form: next.form });
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(fieldset);
		if (formRef.current) observer.observe(formRef.current);
		return () => observer.disconnect();
	}, [form.html, shown, waiting]);
	if (!shown && context?.roots.length && !claimed) return <FormScreenAction session={session} standalone />;
	return <div ref={formRef} data-form-question aria-busy={waiting} style={{ minHeight: measured.current.html === form.html ? minimumHeight.form : 0 }}
		onFocusCapture={event => {
			const node = event.target;
			focusedChoice.current = request?.kind === "select" && request.selectionMarker === "checkbox" && node instanceof HTMLButtonElement && node.hasAttribute("data-choice")
				? { html: form.html, request, node } : null;
		}}
		onBlurCapture={event => {
			if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) focusedChoice.current = null;
		}}>
		<fieldset ref={fieldsetRef} disabled={waiting} className="m-0 min-w-0 border-0 p-0">
			{shown && <QuestionCard session={session} request={shown} presentation={false} disabled={waiting}
				minimumHeight={measured.current.html === form.html ? minimumHeight.card : 0}
				formStatus={t(questionPending ? "question.messageCloses" : "question.formClosing")} />}
		</fieldset>
		{!claimed && !!context?.roots.length && <FormScreenAction session={session} />}
	</div>;
}

/** A collab card claims only the exact hook main associates with this visible request. */
function QuestionPresentationClaim({ session, reqId }: { session: SessionController; reqId: number }) {
	const host = session.getSnapshot().host;
	return host?.transport === "tsp" ? <TspQuestionPresentationClaim hostId={host.hostId} generation={host.generation} reqId={reqId} /> : null;
}
function TspQuestionPresentationClaim({ hostId, generation, reqId }: { hostId: string; generation: number; reqId: number }) {
	const covered = useApp(state => !!state.terminalTabId || !!state.sheet);
	const { snapshot } = useTsp(hostId);
	const match = snapshot?.hostId === hostId && snapshot.generation === generation && snapshot.lifecycle === "live"
		? snapshot.questionMatches?.find(match => match.reqId === reqId && (match.status === "matched" || match.status === "settling")) : null;
	usePresentationClaim(snapshot && match ? { hostId: snapshot.hostId, epoch: snapshot.epoch, surfaceId: match.surfaceId, nodeId: match.nodeId } : null, !covered, true);
	return null;
}

/** Text typed into "Other" is sent as soon as omp asks for the custom answer. */
const pendingCustom = new WeakMap<SessionController, string>();

function labelOf(item: CollabUiRequest & { kind: "select" }, index: number): { label: string; description?: string } {
	const option = item.options[index];
	if (option === undefined) return { label: "" };
	return typeof option === "string" ? { label: option } : option;
}

/**
 * The card to show after the transcript, keyed so it rises in once per question: the series card
 * for a multi-question ask while it is answered or sent, else omp's pending request.
 */
export function usePendingQuestion(session: SessionController, request: CollabUiRequest | null): { key: string; node: ReactNode; inPlace?: boolean } | null {
	const { t } = useTranslation("chat");
	const series = useAskSeries(session);
	const view = session.getSnapshot();
	const host = view.host;
	const { snapshot } = useTsp(host?.transport === "tsp" ? host.hostId : null);
	const current = snapshot?.hostId === host?.hostId && snapshot?.generation === host?.generation && snapshot?.lifecycle === "live" ? snapshot : null;
	const roots = current?.surfaces.flatMap(surface => surface.closed || surface.suspended || surface.documentGeneration !== current.generation ? [] : [...walkNodes(surface.document)]
		.filter(node => node.p?.role === TSP_ROLES.editorAsk || node.p?.role === TSP_ROLES.editorAskHidden).map(node => ({ surface, node }))) ?? [];
	const context = current ? { snapshot: current, roots } : null;
	const writable = view.mode === "live" && !view.readOnly && view.guest?.phase === "live" && !view.guest.readOnly;
	const question = questionPresentation(view);
	const active = question.form;
	const [lastForm, setLastForm] = useState(active);
	if (active && (lastForm?.toolCallId !== active.toolCallId || lastForm.html !== active.html)) setLastForm(active);
	const owner = useRef<FormOwner | null>(null);
	const held = owner.current;
	const closing = !active && writable && !!lastForm && !!held && held.html === lastForm.html && held.toolCallId === lastForm.toolCallId
		&& held.hostId === current?.hostId && held.generation === current?.generation && held.epoch === current?.epoch
		&& toolCallState(view.guest!, lastForm.toolCallId) === "done"
		&& roots.some(({ surface, node }) => surface.open.id === held.surfaceId && node.id === held.nodeId);
	const form = active ?? (closing ? lastForm : null);
	if (form && (!request || isAskFormRequest(form.html, request))) {
		return { key: `form:${host?.hostId}:${host?.generation}:${form.toolCallId}`, inPlace: true, node: <FormQuestionCard session={session} request={request} form={form} context={context} owner={owner} closing={closing} questionPending={question.pending} /> };
	}
	if (series && (series.phase === "editing" || series.phase === "sending" || (series.phase === "sent" && !request))) {
		return { key: `ask:${series.toolCallId}`, node: <AskSeriesCard session={session} series={series} /> };
	}
	if (!request) return roots.length ? { key: "omp-form-fallback", node: <FormScreenAction session={session} standalone /> } : null;
	const note = series?.phase === "fallback" && series.fallbackWhileSending ? t("question.series.fallback") : undefined;
	return { key: String(request.reqId), node: <><QuestionCard session={session} request={request} note={note} />{roots.length > 0 && <FormScreenAction session={session} />}</> };
}

export function QuestionCard({ session, request, note, presentation = true, disabled = false, formStatus, minimumHeight }: { session: SessionController; request: CollabUiRequest; note?: string; presentation?: boolean; disabled?: boolean; formStatus?: string; minimumHeight?: number }): ReactNode {
	const { t } = useTranslation("chat");
	const [text, setText] = useState(request.kind === "editor" ? (request.prefill ?? "") : "");
	const [selected, setSelected] = useState(request.kind === "select" ? (request.initialIndex ?? 0) : 0);
	const [other, setOther] = useState("");
	const [explaining, setExplaining] = useState(false);
	const [denying, setDenying] = useState(false);
	const [stateRequest, setStateRequest] = useState(request);
	if (stateRequest.reqId !== request.reqId || stateRequest.kind !== request.kind || stateRequest.title !== request.title) {
		setStateRequest(request);
		setText(request.kind === "editor" ? (request.prefill ?? "") : "");
		setSelected(request.kind === "select" ? (request.initialIndex ?? 0) : 0);
		setOther("");
		setExplaining(false);
		setDenying(false);
	}
	const editorRef = useRef<HTMLTextAreaElement>(null);
	const titleId = useId();

	// Native autofocus can scroll every ancestor when a form advances to its editor.
	useLayoutEffect(() => {
		if (!disabled && (request.kind === "editor" || explaining)) editorRef.current?.focus({ preventScroll: true });
	}, [request.reqId, request.kind, explaining, disabled]);

	// Answer the follow-up editor for an "Other" choice without showing a second card.
	useEffect(() => {
		if (request.kind !== "editor" || !request.title.startsWith(CUSTOM_ANSWER_PREFIX)) return;
		const custom = pendingCustom.get(session);
		if (custom === undefined) return;
		pendingCustom.delete(session);
		session.answer(request.reqId, custom);
	}, [request, session]);

	const noteLine = note && (
		<p className="mb-3 flex items-start gap-2 text-sm text-fg-muted">
			<Info aria-hidden className="mt-0.5 size-4 shrink-0" />
			{note}
		</p>
	);
	const statusText = formStatus ?? (pendingAsk(session.getSnapshot()) ? t("question.messageCloses") : undefined);
	const statusLine = statusText && <p role={formStatus === undefined ? undefined : "status"} className={formStatus === undefined ? "mt-3 text-sm text-fg-muted" : "mt-3 grid text-sm text-fg-muted"}>
		{formStatus === undefined ? statusText : <>
			{/* Retain the normal hint's wrapped height while omp retires a request. */}
			<span aria-hidden className="invisible [grid-area:1/1]">{t("question.messageCloses")}</span>
			<span data-form-status-text className="[grid-area:1/1]">{statusText}</span>
		</>}
	</p>;

	if (request.kind === "editor") {
		if (request.title.startsWith(CUSTOM_ANSWER_PREFIX) && pendingCustom.has(session)) return null;
		return (
			<div data-question-card={request.reqId} className={cardClass} style={{ minHeight: minimumHeight }}>
				{presentation && <QuestionPresentationClaim session={session} reqId={request.reqId} />}
				{noteLine}
				<Heading icon={<Question className="text-accent" />}>
					<p id={titleId} className="selectable mb-3 text-base font-medium text-fg">
						<ColorText text={request.title} />
					</p>
					<Textarea
						ref={editorRef}
						aria-labelledby={titleId}
						value={text}
						onChange={event => setText(event.target.value)}
						placeholder={t("question.placeholder")}
						minRows={2}
						maxRows={8}
						disabled={disabled}
					/>
				</Heading>
				{statusLine}
				<div className="mt-3 flex justify-end gap-2">
					<Button variant="ghost" onClick={() => session.answer(request.reqId, undefined)}>
						{t("question.skip")}
					</Button>
					<Button variant="primary" onClick={() => session.answer(request.reqId, text)}>
						{t("question.send")}
					</Button>
				</div>
			</div>
		);
	}

	const labels = request.options.map((_, index) => labelOf(request, index).label);
	// omp may put remembered grants before the one-time choice. Never use option 0 as the default.
	const once = labels.includes("Approve Once") ? "Approve Once" : labels.includes("Approve") ? "Approve" : null;
	const isApproval = once !== null && labels.at(-1) === "Deny";
	const legacyOther = labels.includes(ASK_CHAT);
	const markable = request.markableCount ?? labels.filter(label => label !== ASK_CHAT && label !== ASK_NEXT && (!legacyOther || label !== ASK_OTHER)).length;
	const choices = labels.slice(0, markable).map((_, index) => labelOf(request, index));
	const hasOther = legacyOther && labels.includes(ASK_OTHER);
	const hasChat = labels.includes(ASK_CHAT);
	const hasNext = labels.includes(ASK_NEXT);
	const multi = request.selectionMarker === "checkbox";
	const checked = new Set(request.checkedIndices ?? []);

	if (isApproval) {
		return (
			<div data-question-card={request.reqId} className={cardClass} style={{ minHeight: minimumHeight }}>
				{presentation && <QuestionPresentationClaim session={session} reqId={request.reqId} />}
				{noteLine}
				<Heading icon={<ShieldWarning className="text-warn" />}>
					<p className="mb-2 text-base font-medium text-fg">{t("question.approval")}</p>
					<pre className="selectable max-h-48 overflow-auto rounded-md bg-inset px-3 py-2 font-mono text-code whitespace-pre-wrap text-fg">{request.title}</pre>
				</Heading>
				{labels.length > 2 && (
					<div className="mt-3">
						<p className="text-sm font-medium text-fg">{t("question.approvalChoices")}</p>
						<p className="mt-1 text-sm text-fg-muted">{t(labels.some(label => label.startsWith("Always ")) ? "question.approvalChoicesHelp" : "question.approvalSessionHelp")}</p>
						<div className="mt-2 flex flex-wrap gap-2">
							{labels.filter(label => label !== once && label !== "Deny").map(label => (
								<Button key={label} variant="secondary" disabled={denying} className="h-auto! min-h-8 max-w-full whitespace-normal! py-1 text-left [overflow-wrap:anywhere] [&>span]:block [&>span]:min-w-0" data-approval-choice={label} onClick={() => session.answer(request.reqId, label)}>
									{label}
								</Button>
							))}
						</div>
					</div>
				)}
				<p className="mt-3 text-sm text-fg-muted">{t("question.messageDenies")}</p>
				{explaining && (
					<div className="mt-3">
						<Textarea ref={editorRef} aria-label={t("question.denialReason")} placeholder={t("question.denialReason")} value={other}
							onChange={event => setOther(event.target.value)} minRows={2} maxRows={6} disabled={denying} />
					</div>
				)}
				<div className="mt-3 flex flex-wrap justify-end gap-2">
					<Button variant="secondary" disabled={denying} onClick={() => session.answer(request.reqId, "Deny")}>
						{t("question.deny")}
					</Button>
					<Button variant="secondary" disabled={denying || session.getSnapshot().strandedImages || (explaining && !other.trim())} onClick={() => {
						if (!explaining) { setExplaining(true); return; }
						if (!other.trim() || session.getSnapshot().guest?.uiRequest?.reqId !== request.reqId) return;
						setDenying(true);
						void deliver(session, other.trim(), [], true).catch((error: unknown) => {
							setDenying(false);
							toast({ tone: "err", message: t("question.denialFailed"), description: String(error) });
						});
					}}>
						{t(explaining ? "question.denySend" : "question.denyExplain")}
					</Button>
					<Button variant="primary" disabled={denying} autoFocus data-approval-once={once} onClick={() => session.answer(request.reqId, once ?? undefined)}>
						{t(labels.length > 2 ? "question.allowOnce" : "question.allow")}
					</Button>
				</div>
			</div>
		);
	}

	const submit = () => {
		if (other.trim()) {
			pendingCustom.set(session, other.trim());
			session.answer(request.reqId, ASK_OTHER);
			return;
		}
		session.answer(request.reqId, labels[selected]);
	};

	const activeIndex = other.trim() || selected >= choices.length ? -1 : selected;
	const helpText = request.helpText?.replaceAll("\u{f0311}", "Enter").replaceAll("\u{f12b7}", "Escape");

	return (
		<div data-question-card={request.reqId} className={cardClass} style={{ minHeight: minimumHeight }}>
			{presentation && <QuestionPresentationClaim session={session} reqId={request.reqId} />}
			{noteLine}
			<Heading icon={<Question className="text-accent" />}>
				<p id={titleId} className="selectable text-base font-medium text-fg">
					<ColorText text={request.title} />
				</p>
				{(multi || helpText) && <p className="mt-0.5 text-sm text-fg-muted"><ColorText text={helpText ?? t("question.chooseMany")} /></p>}
			</Heading>
			<ChoiceGrid
				choices={choices}
				multi={multi}
				labelledBy={titleId}
				disabled={disabled}
				isOn={index => (multi ? checked.has(index) : selected === index && !other.trim())}
				activeIndex={activeIndex}
				onSelect={index => {
					if (multi) session.answer(request.reqId, labels[index]);
					else {
						setSelected(index);
						setOther("");
					}
				}}
				onConfirm={index => session.answer(request.reqId, labels[index])}
			/>
			{hasOther && !multi && (
				<input
					value={other}
					onChange={event => setOther(event.target.value)}
					onKeyDown={event => {
						if (event.key === "Enter") submit();
					}}
					placeholder={t("question.placeholder")}
					aria-label={ASK_OTHER}
					className={otherInputClass}
				/>
			)}
			{statusLine}
			<div className="mt-3 flex items-center gap-2">
				{hasChat && (
					<Button variant="ghost" icon={<ChatCircle />} onClick={() => session.answer(request.reqId, ASK_CHAT)}>
						{ASK_CHAT}
					</Button>
				)}
				<div className="flex-1" />
				<Button variant="ghost" onClick={() => session.answer(request.reqId, undefined)}>
					{t("question.skip")}
				</Button>
				{multi ? (
					<Button variant="primary" disabled={!hasNext} onClick={() => session.answer(request.reqId, ASK_NEXT)}>
						{t("question.done")}
					</Button>
				) : (
					<Button variant="primary" onClick={submit}>
						{t("question.answer")}
					</Button>
				)}
			</div>
		</div>
	);
}
