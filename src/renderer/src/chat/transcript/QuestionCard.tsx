/**
 * omp questions delivered as collab requests, including field-by-field HTML forms,
 * tool approvals and extension dialogs. Saved question-list asks can use AskSeriesCard.
 */
import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { ChatCircle, Info, Question, ShieldWarning } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { deliver } from "../composer/send";
import { pendingAsk, type SessionController } from "../../state/session";
import { Button, Textarea, toast } from "../../ui";
import { AskSeriesCard } from "./AskSeriesCard";
import { ASK_CHAT, ASK_NEXT, ASK_OTHER, CUSTOM_ANSWER_PREFIX, findRunningFormAsk } from "./askSeries";
import { useAskSeries } from "./askSeriesStore";
import { ChoiceGrid, cardClass, Heading, otherInputClass } from "./QuestionChoices";
import { useTsp } from "../../state/tsp/useTsp";
import { usePresentationClaim, type PresentationTarget } from "../../state/tsp/presentation-claims";
import { useApp } from "../../state/app";
import { ColorText } from "../../transcript/ColorText";
import { isAskFormRequest } from "../../tool-render/tools/askForm";
import { isClaimable, TSP_ROLES } from "@shared/tsp/roles";
import { walkNodes } from "@shared/tsp/view-state";

/** Keep an established form owner through request retirement and delayed main matching. */
function TspFormPresentationClaim({ hostId, generation, reqId, html }: { hostId: string; generation: number; reqId: number | undefined; html: string }) {
	const covered = useApp(state => !!state.terminalTabId || !!state.sheet);
	const { snapshot } = useTsp(hostId);
	const retained = useRef<(PresentationTarget & { generation: number; html: string }) | null>(null);
	const current = snapshot?.hostId === hostId && snapshot.generation === generation && snapshot.lifecycle === "live" ? snapshot : null;
	const forms = current?.surfaces.flatMap(surface => surface.closed || surface.suspended || surface.documentGeneration !== generation ? [] : [...walkNodes(surface.document)]
		.filter(node => node.p?.role === TSP_ROLES.editorAsk && isClaimable(node, surface))
		.map(node => ({ surfaceId: surface.open.id, nodeId: node.id }))) ?? [];
	const candidates = current?.questionMatches?.filter(match => (match.status === "matched" || match.status === "settling")
		&& forms.some(form => form.surfaceId === match.surfaceId && form.nodeId === match.nodeId)) ?? [];
	const direct = candidates.filter(match => reqId !== undefined && match.reqId === reqId);
	const prior = retained.current;
	const carried = prior?.hostId === hostId && prior.generation === generation && prior.epoch === current?.epoch && prior.html === html
		? candidates.filter(match => match.surfaceId === prior.surfaceId && match.nodeId === prior.nodeId) : [];
	const match = direct.length === 1 ? direct[0] : direct.length === 0 && carried.length === 1 ? carried[0] : undefined;
	const target = current && match ? { hostId, generation, epoch: current.epoch, surfaceId: match.surfaceId, nodeId: match.nodeId, html } : null;
	useLayoutEffect(() => { retained.current = target; }, [hostId, generation, current?.epoch, target?.surfaceId, target?.nodeId, html]);
	usePresentationClaim(target, !covered, true);
	return null;
}

function FormQuestionCard({ session, request, html }: { session: SessionController; request: CollabUiRequest | null; html: string }) {
	const { t } = useTranslation("chat");
	const [previous, setPrevious] = useState({ html, request });
	if (previous.html !== html || request && request !== previous.request) setPrevious({ html, request });
	const shown = request ?? (previous.html === html ? previous.request : null);
	const host = session.getSnapshot().host;
	return <div data-form-question aria-busy={!request}>
		{host?.transport === "tsp" && <TspFormPresentationClaim hostId={host.hostId} generation={host.generation} reqId={shown?.reqId} html={html} />}
		<fieldset disabled={!request} className="m-0 min-w-0 border-0 p-0">
			{shown && <QuestionCard key={shown.reqId} session={session} request={shown} presentation={false} />}
		</fieldset>
		{!request && <p role="status" className="mt-2 text-sm text-fg-muted">{t("question.formPending")}</p>}
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
export function usePendingQuestion(session: SessionController, request: CollabUiRequest | null): { key: string; node: ReactNode } | null {
	const { t } = useTranslation("chat");
	const series = useAskSeries(session);
	const view = session.getSnapshot();
	const form = view.mode === "live" && !view.readOnly && view.guest?.phase === "live" && !view.guest.readOnly ? findRunningFormAsk(view.guest) : null;
	if (form && (!request || isAskFormRequest(form.html, request))) {
		return { key: `form:${view.host?.hostId}:${view.host?.generation}:${form.toolCallId}`, node: <FormQuestionCard session={session} request={request} html={form.html} /> };
	}
	if (series && (series.phase === "editing" || series.phase === "sending" || (series.phase === "sent" && !request))) {
		return { key: `ask:${series.toolCallId}`, node: <AskSeriesCard session={session} series={series} /> };
	}
	if (!request) return null;
	// A series that stopped before sending (another request came first) shows that request as it is, without the note.
	const note = series?.phase === "fallback" && series.fallbackWhileSending ? t("question.series.fallback") : undefined;
	return { key: String(request.reqId), node: <QuestionCard session={session} request={request} note={note} /> };
}

export function QuestionCard({ session, request, note, presentation = true }: { session: SessionController; request: CollabUiRequest; note?: string; presentation?: boolean }): ReactNode {
	const { t } = useTranslation("chat");
	const [text, setText] = useState(request.kind === "editor" ? (request.prefill ?? "") : "");
	const [selected, setSelected] = useState(request.kind === "select" ? (request.initialIndex ?? 0) : 0);
	const [other, setOther] = useState("");
	const [explaining, setExplaining] = useState(false);
	const [denying, setDenying] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const titleId = useId();

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

	if (request.kind === "editor") {
		if (request.title.startsWith(CUSTOM_ANSWER_PREFIX) && pendingCustom.has(session)) return null;
		return (
			<div ref={rootRef} data-question-card={request.reqId} className={cardClass}>
				{presentation && <QuestionPresentationClaim session={session} reqId={request.reqId} />}
				{noteLine}
				<Heading icon={<Question className="text-accent" />}>
					<p id={titleId} className="selectable mb-3 text-base font-medium text-fg">
						<ColorText text={request.title} />
					</p>
					<Textarea
						aria-labelledby={titleId}
						value={text}
						onChange={event => setText(event.target.value)}
						placeholder={t("question.placeholder")}
						minRows={2}
						maxRows={8}
						autoFocus
					/>
				</Heading>
				{pendingAsk(session.getSnapshot()) && <p className="mt-3 text-sm text-fg-muted">{t("question.messageCloses")}</p>}
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
			<div data-question-card={request.reqId} className={cardClass}>
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
						<Textarea aria-label={t("question.denialReason")} placeholder={t("question.denialReason")} value={other}
							onChange={event => setOther(event.target.value)} minRows={2} maxRows={6} autoFocus disabled={denying} />
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
		<div data-question-card={request.reqId} className={cardClass}>
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
			{pendingAsk(session.getSnapshot()) && <p className="mt-3 text-sm text-fg-muted">{t("question.messageCloses")}</p>}
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
