/**
 * omp questions that reach the app as collab `ui-request`s (DESIGN §4.8): tool approvals
 * (select "Approve"/"Deny"), the `ask` tool (one select per question with Other / Chat / Next
 * sentinels; multi-select toggles one option per answer), generic extension selects, and editors.
 * An `ask` with more than one question is answered as a series instead (`AskSeriesCard`).
 */
import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { ChatCircle, Info, Question, ShieldWarning } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { deliver } from "../composer/send";
import type { SessionController } from "../../state/session";
import { Button, Textarea, toast } from "../../ui";
import { AskSeriesCard } from "./AskSeriesCard";
import { ASK_CHAT, ASK_NEXT, ASK_OTHER, CUSTOM_ANSWER_PREFIX } from "./askSeries";
import { useAskSeries } from "./askSeriesStore";
import { ChoiceGrid, cardClass, Heading, otherInputClass } from "./QuestionChoices";

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
	if (series && (series.phase === "editing" || series.phase === "sending" || (series.phase === "sent" && !request))) {
		return { key: `ask:${series.toolCallId}`, node: <AskSeriesCard session={session} series={series} /> };
	}
	if (!request) return null;
	// A series that stopped before sending (another request came first) shows that request as it is, without the note.
	const note = series?.phase === "fallback" && series.fallbackWhileSending ? t("question.series.fallback") : undefined;
	return { key: String(request.reqId), node: <QuestionCard session={session} request={request} note={note} /> };
}

export function QuestionCard({ session, request, note }: { session: SessionController; request: CollabUiRequest; note?: string }): ReactNode {
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
				{noteLine}
				<Heading icon={<Question className="text-accent" />}>
					<p id={titleId} className="selectable mb-3 text-base font-medium text-fg">
						{request.title}
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
	const markable = request.markableCount ?? labels.filter(label => label !== ASK_OTHER && label !== ASK_CHAT && label !== ASK_NEXT).length;
	const choices = labels.slice(0, markable).map((_, index) => labelOf(request, index));
	const hasOther = labels.includes(ASK_OTHER);
	const hasChat = labels.includes(ASK_CHAT);
	const hasNext = labels.includes(ASK_NEXT);
	const multi = request.selectionMarker === "checkbox";
	const checked = new Set(request.checkedIndices ?? []);

	if (isApproval) {
		return (
			<div data-question-card={request.reqId} className={cardClass}>
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

	return (
		<div data-question-card={request.reqId} className={cardClass}>
			{noteLine}
			<Heading icon={<Question className="text-accent" />}>
				<p id={titleId} className="selectable text-base font-medium text-fg">
					{request.title}
				</p>
				{(multi || request.helpText) && <p className="mt-0.5 text-sm text-fg-muted">{request.helpText ?? t("question.chooseMany")}</p>}
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
