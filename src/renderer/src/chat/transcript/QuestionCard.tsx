/**
 * omp questions delivered as collab requests, including field-by-field HTML forms,
 * tool approvals and extension dialogs. Saved question-list asks can use AskSeriesCard.
 */
import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { ChatCircle, Info, Question, ShieldWarning } from "@phosphor-icons/react";
import { type ReactNode, type SyntheticEvent, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { deliver } from "../composer/send";
import { pendingAsk, questionPresentation, type SessionController } from "../../state/session";
import { Button, cn, MenuItem, Textarea, toast } from "../../ui";
import { AskSeriesCard } from "./AskSeriesCard";
import { ASK_CHAT, ASK_NEXT, ASK_OTHER, CUSTOM_ANSWER_PREFIX, defaultAnswer, formSkipReason, parseAskFormQuestions, replayStep, REPLAY_START, toolCallState, type AskQuestion, type ReplayCursor, type RunningFormAsk } from "./askSeries";
import { useAskSeries, type AskSeriesState } from "./askSeriesStore";
import { CardActionsMenu, ChoiceGrid, cardClass, Heading, otherInputClass } from "./QuestionChoices";
import { FormContext } from "./FormContext";
import { useTsp } from "../../state/tsp/useTsp";
import { usePresentationClaim, type PresentationTarget } from "../../state/tsp/presentation-claims";
import { useApp } from "../../state/app";
import { ColorText } from "../../transcript/ColorText";
import { askFormFieldForRequest, isAskFormRequest, parseAskForm, type AskForm, type AskFormContextBlock, type AskFormField, type AskFormOption } from "../../tool-render/tools/askForm";
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


function sameQuestionShape(a: CollabUiRequest | null, b: CollabUiRequest): boolean {
	if (!a || a.kind !== b.kind || a.title !== b.title) return false;
	if (a.kind === "editor" && b.kind === "editor") return true;
	if (a.kind !== "select" || b.kind !== "select") return false;
	return a.selectionMarker === b.selectionMarker && a.options.length === b.options.length
		&& a.options.every((option, index) => {
			const next = b.options[index]!;
			return (typeof option === "string" ? option : option.label) === (typeof next === "string" ? next : next.label);
		});
}

interface DisplayedFormQuestion {
	html: string;
	toolCallId: string;
	request: CollabUiRequest | null;
	step: number;
	fieldIndex: number;
	initialFieldIndex: number;
	submittedReqId: number | null;
	submittedValue: string | null;
	otherEditorReqId: number | null;
}
interface FormCancelReplay {
	html: string;
	toolCallId: string;
	editorReqId: number;
	fieldIndex: number;
}


interface FormSkipReplay {
	html: string;
	toolCallId: string;
	fieldIndex: number;
	questionIndex: number;
	cursor: ReplayCursor;
}

function matchesFormFieldRequest(form: AskForm, request: CollabUiRequest, field: AskFormField, fieldIndex: number): boolean {
	return askFormFieldForRequest(form, request, fieldIndex) === field
		|| (request.kind === "editor" && field.kind === "choice" && field.other === true && request.title.startsWith(CUSTOM_ANSWER_PREFIX));
}

function isEnteringOtherEditor(form: AskForm, previous: CollabUiRequest | null, request: CollabUiRequest, fieldIndex: number, submittedValue: string | null): boolean {
	const field = form.fields[fieldIndex];
	return field?.kind === "choice" && field.other === true
		&& previous?.kind === "select" && request.kind === "editor" && submittedValue === ASK_OTHER;
}

function nextAskFormFieldIndex(form: AskForm, previous: CollabUiRequest | null, request: CollabUiRequest, fieldIndex: number, submittedReqId: number | null, submittedValue: string | null, otherEditorReqId: number | null): number {
	const currentField = form.fields[fieldIndex];
	if (!currentField || !previous) return fieldIndex;
	const validationReask = request.kind === "editor"
		&& form.fields.some(field => field.kind === "text" && request.title.startsWith(`${field.question} (`));
	if (validationReask) {
		const currentValidation = currentField.kind === "text" && submittedReqId === previous.reqId
			&& request.title.startsWith(`${currentField.question} (`);
		if (currentValidation) return fieldIndex;
		let reaskedIndex = -1;
		for (let index = fieldIndex - 1; index >= 0; index--) {
			const field = form.fields[index]!;
			if (field.kind === "text" && request.title.startsWith(`${field.question} (`)) {
				reaskedIndex = index;
				break;
			}
		}
		if (reaskedIndex >= 0) return reaskedIndex;
	}
	const previousMatches = matchesFormFieldRequest(form, previous, currentField, fieldIndex);
	const requestMatches = matchesFormFieldRequest(form, request, currentField, fieldIndex);
	const enteringOtherEditor = isEnteringOtherEditor(form, previous, request, fieldIndex, submittedValue);
	const returnedToCheckboxField = previous.reqId === otherEditorReqId && currentField.kind === "choice" && currentField.multi && requestMatches;
	const completedCurrent = previousMatches && submittedReqId === previous.reqId && !enteringOtherEditor && !returnedToCheckboxField;
	if (enteringOtherEditor || (requestMatches && !completedCurrent)) return fieldIndex;
	const next = askFormFieldForRequest(form, request, fieldIndex + Number(completedCurrent));
	return next ? form.fields.indexOf(next) : fieldIndex;
}
function initialFormFieldIndex(html: string, series: AskSeriesState | null, request: CollabUiRequest | null): number {
	if (!series || series.formHtml !== html || series.questions.length === 0) return 0;
	const form = parseAskForm(html);
	const fieldIndexOf = (question: AskQuestion | undefined): number => {
		if (!question?.formField) return -1;
		const index = Number(question.id.slice(question.id.lastIndexOf(":") + 1));
		return Number.isInteger(index) && form.fields[index]?.name === question.formField.name ? index : -1;
	};
	const editing = series.phase === "editing" || (series.phase === "fallback" && !series.fallbackWhileSending);
	const cursor = Math.min(series.cursor.question, series.questions.length - 1);
	const currentQuestion = editing ? series.questions[0] : series.questions[cursor] ?? series.questions.at(-1);
	const currentIndex = fieldIndexOf(currentQuestion);
	const replayQuestion = series.questions[Math.min(series.cursor.question, series.questions.length) - 1];
	if ((series.phase === "sent" || (series.phase === "fallback" && series.fallbackWhileSending))
		&& request?.kind === "editor" && replayQuestion?.formField?.kind === "text"
		&& request.title.startsWith(`${replayQuestion.question} (`)) {
		const replayFieldIndex = fieldIndexOf(replayQuestion);
		if (replayFieldIndex >= 0) return replayFieldIndex;
	}
	return currentIndex >= 0 ? currentIndex : 0;
}


function FormQuestionCard({ session, request, form, context, owner, closing, questionPending, note, requestAvailable, initialFieldIndex }: {
	session: SessionController;
	request: CollabUiRequest | null;
	form: RunningFormAsk;
	context: NativeForms | null;
	owner: FormOwnerRef;
	closing: boolean;
	questionPending: boolean;
	note?: string;
	requestAvailable: boolean;
	initialFieldIndex: number;
}) {
	const { t } = useTranslation("chat");
	const parsedForm = useMemo(() => parseAskForm(form.html), [form.html]);
	const formQuestions = useMemo(() => parseAskFormQuestions(form.html) ?? [], [form.html]);
	const formAnswers = useMemo(() => formQuestions.map(defaultAnswer), [formQuestions]);
	const [skipReplay, setSkipReplay] = useState<FormSkipReplay | null>(null);
	const [cancelReplay, setCancelReplay] = useState<FormCancelReplay | null>(null);
	const skipAnsweredReqIds = useRef(new Set<number>());
	const [displayed, setDisplayed] = useState<DisplayedFormQuestion>({
		html: form.html,
		toolCallId: form.toolCallId,
		request,
		step: 0,
		fieldIndex: initialFieldIndex,
		initialFieldIndex,
		submittedReqId: null,
		submittedValue: null,
		otherEditorReqId: null,
	});
	if (displayed.html !== form.html || displayed.toolCallId !== form.toolCallId || displayed.initialFieldIndex !== initialFieldIndex) {
		const newForm = displayed.html !== form.html || displayed.toolCallId !== form.toolCallId;
		setDisplayed({ html: form.html, toolCallId: form.toolCallId, request, step: newForm ? 0 : displayed.step + 1, fieldIndex: initialFieldIndex, initialFieldIndex, submittedReqId: null, submittedValue: null, otherEditorReqId: null });
	} else if (request && request.reqId !== displayed.request?.reqId) {
		const previousRequest = displayed.request;
		const advances = previousRequest !== null && (
			displayed.submittedReqId === previousRequest.reqId || !sameQuestionShape(previousRequest, request)
		);
		const enteringOtherEditor = isEnteringOtherEditor(parsedForm, previousRequest, request, displayed.fieldIndex, displayed.submittedValue);
		const fieldIndex = previousRequest === null ? initialFieldIndex : nextAskFormFieldIndex(parsedForm, previousRequest, request, displayed.fieldIndex, displayed.submittedReqId, displayed.submittedValue, displayed.otherEditorReqId);
		setDisplayed({
			html: form.html,
			toolCallId: form.toolCallId,
			request,
			step: displayed.step + Number(advances),
			fieldIndex,
			initialFieldIndex: displayed.initialFieldIndex,
			submittedReqId: null,
			submittedValue: null,
			otherEditorReqId: enteringOtherEditor ? request.reqId : null,
		});
	} else if (request && request !== displayed.request) {
		setDisplayed({ ...displayed, request });
	}
	const shown = request ?? (displayed.html === form.html ? displayed.request : null);
	const currentField = parsedForm.fields[displayed.fieldIndex];
	const validationReask = shown?.kind === "editor" && currentField?.kind === "text" && shown.title.startsWith(`${currentField.question} (`);
	const matchedField = shown ? validationReask ? currentField : askFormFieldForRequest(parsedForm, shown, displayed.fieldIndex)
		?? (currentField && shown.kind === "editor" && currentField.kind === "choice" && currentField.other === true && shown.title.startsWith(CUSTOM_ANSWER_PREFIX) ? currentField : null) : null;
	const fieldIndexForSeries = matchedField ? parsedForm.fields.indexOf(matchedField) : -1;
	if (shown && fieldIndexForSeries >= 0 && fieldIndexForSeries !== displayed.fieldIndex) {
		setDisplayed({ ...displayed, fieldIndex: fieldIndexForSeries });
	}
	const formQuestionIndex = matchedField ? formQuestions.findIndex(question => question.id === `${matchedField.name}:${fieldIndexForSeries}`) : -1;
	const formQuestion = formQuestionIndex >= 0 ? formQuestions[formQuestionIndex] : undefined;
	const skipReason = formQuestion ? formSkipReason(formQuestion) : "single";
	const skipReasonText = skipReason ? t(`question.series.skipUnavailable.${skipReason}`) : undefined;
	const claimed = useFormPresentation(context, shown?.reqId, form, owner);
	const waiting = closing || !request || !requestAvailable;
	const markStepSubmitted = useCallback((reqId: number, value?: string) => {
		setDisplayed(previous => previous.request?.reqId === reqId ? { ...previous, submittedReqId: reqId, submittedValue: value ?? null } : previous);
	}, []);
	const skipFormQuestion = useCallback(() => {
		if (!shown || !formQuestion || skipReason !== null || !requestAvailable || skipAnsweredReqIds.current.has(shown.reqId) || session.getSnapshot().guest?.uiRequest?.reqId !== shown.reqId) return;
		const cursor: ReplayCursor = { ...REPLAY_START, question: formQuestionIndex };
		if (formQuestion.formField?.kind === "text") {
			const value = formAnswers[formQuestionIndex]?.text ?? "";
			skipAnsweredReqIds.current.add(shown.reqId);
			markStepSubmitted(shown.reqId, value);
			session.answer(shown.reqId, value);
			return;
		}
		const replay: FormSkipReplay = { html: form.html, toolCallId: form.toolCallId, fieldIndex: displayed.fieldIndex, questionIndex: formQuestionIndex, cursor };
		if (shown.kind === "editor") {
			skipAnsweredReqIds.current.add(shown.reqId);
			setSkipReplay(replay);
			session.answer(shown.reqId, undefined);
			return;
		}
		const step = replayStep(formQuestions, formAnswers, cursor, shown);
		if (step.kind === "mismatch") return;
		skipAnsweredReqIds.current.add(shown.reqId);
		if (step.cursor.question !== formQuestionIndex || step.done) {
			markStepSubmitted(shown.reqId, step.value);
			setSkipReplay(null);
		} else setSkipReplay({ ...replay, cursor: step.cursor });
		session.answer(shown.reqId, step.value);
	}, [shown, formQuestion, skipReason, requestAvailable, session, formQuestionIndex, formAnswers, markStepSubmitted, form, displayed.fieldIndex, formQuestions]);
	useEffect(() => {
		if (!skipReplay || !requestAvailable) return;
		if (skipReplay.html !== form.html || skipReplay.toolCallId !== form.toolCallId || skipReplay.fieldIndex !== displayed.fieldIndex) {
			setSkipReplay(null);
			return;
		}
		if (!request || skipAnsweredReqIds.current.has(request.reqId) || session.getSnapshot().guest?.uiRequest?.reqId !== request.reqId) return;
		const step = replayStep(formQuestions, formAnswers, skipReplay.cursor, request);
		if (step.kind === "mismatch") {
			setSkipReplay(null);
			return;
		}
		skipAnsweredReqIds.current.add(request.reqId);
		if (step.cursor.question !== skipReplay.questionIndex || step.done) {
			markStepSubmitted(request.reqId, step.value);
			setSkipReplay(null);
		} else setSkipReplay({ ...skipReplay, cursor: step.cursor });
		session.answer(request.reqId, step.value);
	}, [skipReplay, requestAvailable, form.html, form.toolCallId, displayed.fieldIndex, request, session, formQuestions, formAnswers, markStepSubmitted]);
	useEffect(() => {
		if (!cancelReplay) return;
		if (cancelReplay.html !== form.html || cancelReplay.toolCallId !== form.toolCallId || cancelReplay.fieldIndex !== displayed.fieldIndex) {
			setCancelReplay(null);
			return;
		}
		if (!requestAvailable || !request || request.reqId === cancelReplay.editorReqId) return;
		if (request.kind !== "select") {
			setCancelReplay(null);
			return;
		}
		const field = askFormFieldForRequest(parsedForm, request, cancelReplay.fieldIndex);
		if (!field || parsedForm.fields.indexOf(field) !== cancelReplay.fieldIndex) {
			setCancelReplay(null);
			return;
		}
		if (skipAnsweredReqIds.current.has(request.reqId) || session.getSnapshot().guest?.uiRequest?.reqId !== request.reqId) return;
		skipAnsweredReqIds.current.add(request.reqId);
		setCancelReplay(null);
		session.answer(request.reqId, undefined);
	}, [cancelReplay, form.html, form.toolCallId, displayed.fieldIndex, requestAvailable, request, parsedForm, session]);
	const cancelForm = useCallback(() => {
		if (!shown || !requestAvailable || closing || session.getSnapshot().guest?.uiRequest?.reqId !== shown.reqId) return;
		if (shown.kind === "editor" && matchedField?.kind === "choice" && matchedField.other === true) {
			setCancelReplay({ html: form.html, toolCallId: form.toolCallId, editorReqId: shown.reqId, fieldIndex: parsedForm.fields.indexOf(matchedField) });
		}
		session.answer(shown.reqId, undefined);
	}, [shown, requestAvailable, closing, session, matchedField, form.html, form.toolCallId, parsedForm]);
	const fieldsetRef = useRef<HTMLFieldSetElement>(null);
	const formRef = useRef<HTMLDivElement>(null);
	const measured = useRef({ html: form.html, toolCallId: form.toolCallId, step: displayed.step, card: 0, form: 0 });
	const [minimumHeight, setMinimumHeight] = useState({ card: 0, form: 0 });
	const held = measured.current.html === form.html && measured.current.toolCallId === form.toolCallId
		&& measured.current.step === displayed.step;
	useLayoutEffect(() => {
		const fieldset = fieldsetRef.current;
		if (!fieldset) return;
		const measure = () => {
			const cardHeight = fieldset.getBoundingClientRect().height;
			const formHeight = formRef.current?.getBoundingClientRect().height ?? cardHeight;
			const previous = measured.current;
			const sameStep = previous.html === form.html && previous.toolCallId === form.toolCallId && previous.step === displayed.step;
			const next = {
				html: form.html,
				toolCallId: form.toolCallId,
				step: displayed.step,
				card: sameStep ? Math.max(previous.card, cardHeight) : cardHeight,
				form: sameStep ? Math.max(previous.form, formHeight) : formHeight,
			};
			measured.current = next;
			setMinimumHeight({ card: next.card, form: next.form });
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(fieldset);
		if (formRef.current) observer.observe(formRef.current);
		return () => observer.disconnect();
	}, [form.html, form.toolCallId, displayed.step, shown, waiting]);
	const guard = (event: SyntheticEvent) => {
		if (!waiting && session.getSnapshot().guest?.uiRequest?.reqId === request?.reqId) return;
		event.preventDefault(); event.stopPropagation();
	};
	if (!shown && context?.roots.length && !claimed) return <FormScreenAction session={session} standalone />;
	return <div ref={formRef} data-form-question aria-busy={waiting} style={{ minHeight: held ? minimumHeight.form : 0 }}>
		<fieldset ref={fieldsetRef} disabled={closing} aria-disabled={waiting || undefined} className="m-0 min-w-0 border-0 p-0"
			onClickCapture={guard} onDoubleClickCapture={guard}
			onKeyDownCapture={event => {
				if (["Enter", " ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) guard(event);
			}}>
			{shown && <QuestionCard key={form.toolCallId} session={session} request={shown} note={note} presentation={false} disabled={waiting} steadyControls={questionPending}
				formRequest formSkipReason={skipReasonText} onFormSkip={skipFormQuestion} onFormCancel={cancelForm}
				formContext={matchedField?.context} formOptions={matchedField?.options} formHasOther={matchedField?.other}
				minimumHeight={held ? minimumHeight.card : 0}
				onStepSubmitted={markStepSubmitted}
				formStatus={t(questionPending ? "question.messageCloses" : "question.formClosing")} />}
		</fieldset>
		{!claimed && !!context?.roots.length && <FormScreenAction session={session} />}
	</div>;
}

function FormSeriesPresenter({ session, series, request, form, context, owner, closing }: {
	session: SessionController;
	series: AskSeriesState;
	request: CollabUiRequest | null;
	form: RunningFormAsk;
	context: NativeForms | null;
	owner: FormOwnerRef;
	closing: boolean;
}) {
	const claimed = useFormPresentation(context, request?.reqId, form, owner);
	return <div data-form-question aria-busy={closing || series.phase !== "editing" || undefined}>
		<AskSeriesCard session={session} series={series} closing={closing} />
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
	const [lastFormSeries, setLastFormSeries] = useState<AskSeriesState | null>(series?.formHtml ? series : null);
	if (series?.formHtml && lastFormSeries !== series) setLastFormSeries(series);
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
	const [lastFormRequest, setLastFormRequest] = useState<{ toolCallId: string; html: string; request: CollabUiRequest | null } | null>(null);
	if (active && (lastFormRequest?.toolCallId !== active.toolCallId || lastFormRequest.html !== active.html)) {
		setLastFormRequest({ toolCallId: active.toolCallId, html: active.html, request: request && isAskFormRequest(active.html, request) ? request : null });
	} else if (active && request && isAskFormRequest(active.html, request) && lastFormRequest?.request?.reqId !== request.reqId) {
		setLastFormRequest({ toolCallId: active.toolCallId, html: active.html, request });
	}
	const owner = useRef<FormOwner | null>(null);
	const held = owner.current;
	const closing = !active && writable && !!lastForm && !!held && held.html === lastForm.html && held.toolCallId === lastForm.toolCallId
		&& held.hostId === current?.hostId && held.generation === current?.generation && held.epoch === current?.epoch
		&& toolCallState(view.guest!, lastForm.toolCallId) === "done"
		&& roots.some(({ surface, node }) => surface.open.id === held.surfaceId && node.id === held.nodeId);
	const form = active ?? (closing ? lastForm : null);
	const formSeriesState = form && series?.toolCallId === form.toolCallId && series.formHtml === form.html
		? series
		: form && closing && lastFormSeries?.toolCallId === form.toolCallId && lastFormSeries.formHtml === form.html ? lastFormSeries : null;
	const note = series?.phase === "fallback" && series.fallbackWhileSending ? t("question.series.fallback") : undefined;
	const formRequest = form && lastFormRequest?.toolCallId === form.toolCallId && lastFormRequest.html === form.html ? lastFormRequest.request : null;
	const fallbackFieldIndex = useMemo(() => form ? initialFormFieldIndex(form.html, formSeriesState, request) : 0, [
		form?.html, formSeriesState?.toolCallId, formSeriesState?.formHtml, formSeriesState?.phase,
		formSeriesState?.fallbackWhileSending, formSeriesState?.index, formSeriesState?.cursor.question, formSeriesState?.questions, request,
	]);
	if (form && formSeriesState && (formSeriesState.phase === "editing" || formSeriesState.phase === "sending" || (formSeriesState.phase === "sent" && (!request || closing)))) {
		return { key: `form:${host?.hostId}:${host?.generation}:${form.toolCallId}`, inPlace: true, node: <FormSeriesPresenter session={session} series={formSeriesState} request={request} form={form} context={context} owner={owner} closing={closing} /> };
	}
	if (form && (!request || isAskFormRequest(form.html, request))) {
		return { key: `form:${host?.hostId}:${host?.generation}:${form.toolCallId}`, inPlace: true, node: <FormQuestionCard session={session} request={request ?? formRequest} requestAvailable={request !== null} form={form} context={context} owner={owner} closing={closing} questionPending={question.pending} note={note} initialFieldIndex={fallbackFieldIndex} /> };
	}
	if (series && !series.formHtml && (series.phase === "editing" || series.phase === "sending" || (series.phase === "sent" && !request))) {
		return { key: `ask:${series.toolCallId}`, node: <AskSeriesCard session={session} series={series} /> };
	}
	if (!request) return roots.length ? { key: "omp-form-fallback", node: <FormScreenAction session={session} standalone /> } : null;
	return { key: String(request.reqId), node: <><QuestionCard session={session} request={request} note={note} />{roots.length > 0 && <FormScreenAction session={session} />}</> };
}

export function QuestionCard({ session, request, note, presentation = true, disabled = false, steadyControls = false, formStatus, minimumHeight, onStepSubmitted, formContext, formOptions, formHasOther, formRequest = false, formSkipReason: formSkipMessage, onFormSkip, onFormCancel }: {
	session: SessionController;
	request: CollabUiRequest;
	note?: string;
	presentation?: boolean;
	disabled?: boolean;
	steadyControls?: boolean;
	formStatus?: string;
	minimumHeight?: number;
	onStepSubmitted?: (reqId: number, value?: string) => void;
	formContext?: readonly AskFormContextBlock[];
	formOptions?: readonly AskFormOption[];
	formHasOther?: boolean;
	formRequest?: boolean;
	formSkipReason?: string;
	onFormSkip?: () => void;
	onFormCancel?: () => void;
}): ReactNode {
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
	const answer = (value?: string) => {
		onStepSubmitted?.(request.reqId, value);
		session.answer(request.reqId, value);
	};

	const answerMultiChoice = (index: number) => {
		const value = labels[index];
		if (formHasOther && value === ASK_OTHER) onStepSubmitted?.(request.reqId, value);
		session.answer(request.reqId, value);
	};

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
		onStepSubmitted?.(request.reqId, custom);
		session.answer(request.reqId, custom);
	}, [request, session, onStepSubmitted]);

	// A form card's ⋯ menu sits at the top right; the first lines keep clear of it.
	const cornerPad = formRequest ? "pr-8" : undefined;
	const cornerMenu = formRequest && (
		<div className="absolute top-4 right-3">
			<CardActionsMenu>
				<MenuItem danger disabled={disabled && !steadyControls} onSelect={() => onFormCancel?.()}>{t("question.series.cancelForm")}</MenuItem>
			</CardActionsMenu>
		</div>
	);
	const noteLine = note && (
		<p className={cn("mb-3 flex items-start gap-2 text-sm text-fg-muted", cornerPad)}>
			<Info aria-hidden className="mt-0.5 size-4 shrink-0" />
			{note}
		</p>
	);
	// The current step keeps its minimum through edits and request gaps.
	const steadyCard = cn(cardClass, "relative", minimumHeight ? "flex flex-col" : undefined);
	const statusText = formStatus ?? (pendingAsk(session.getSnapshot()) ? t("question.messageCloses") : undefined);
	const statusLine = statusText && <p role={formStatus === undefined ? undefined : "status"} className={formStatus === undefined ? "mt-3 text-sm text-fg-muted" : "mt-3 grid text-sm text-fg-muted"}>
		{formStatus === undefined ? statusText : <>
			{/* Retain the normal hint's wrapped height while omp retires a request. */}
			<span aria-hidden className="invisible [grid-area:1/1]">{t("question.messageCloses")}</span>
			<span data-form-status-text className="[grid-area:1/1]">{statusText}</span>
		</>}
	</p>;
	const formContextLine = formContext && <div className={cornerPad}><FormContext blocks={formContext} question={request.title} /></div>;

	if (request.kind === "editor") {
		if (request.title.startsWith(CUSTOM_ANSWER_PREFIX) && pendingCustom.has(session)) return null;
		return (
			<div data-question-card={request.reqId} className={steadyCard} style={{ minHeight: minimumHeight }}>
				{presentation && <QuestionPresentationClaim session={session} reqId={request.reqId} />}
				{cornerMenu}
				{noteLine}
				{formContextLine}
				<Heading icon={<Question className="text-accent" />}>
					<p id={titleId} className={cn("selectable mb-3 text-base font-medium text-fg", cornerPad)}>
						<ColorText text={request.title} inlineCode />
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
				<div className="mt-auto">
					{statusLine}
					{formSkipMessage && <p id={`${titleId}-skip-reason`} className="mt-2 text-sm text-fg-muted">{formSkipMessage}</p>}
					<div className="mt-3 flex justify-end gap-2">
						{formRequest ? (
							<Button variant="ghost" disabled={(disabled && !steadyControls) || !!formSkipMessage} aria-describedby={formSkipMessage ? `${titleId}-skip-reason` : undefined} onClick={() => onFormSkip?.()}>
								{t("question.series.skipThisQuestion")}
							</Button>
						) : (
							<Button variant="ghost" onClick={() => answer()}>
								{t("question.skip")}
							</Button>
						)}
						<Button variant="primary" disabled={disabled && !steadyControls} onClick={() => answer(text)}>
							{t("question.send")}
						</Button>
					</div>
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
	const formChoiceOptions = formOptions?.filter(option => !option.disabled);
	const choices = labels.slice(0, markable).map((_, index) => {
		const choice = labelOf(request, index);
		const option = formChoiceOptions?.[index];
		if (!option) return choice;
		const matchLabel = option.requestLabel ?? option.label;
		const suffix = choice.label.startsWith(matchLabel) ? choice.label.slice(matchLabel.length) : "";
		const disambiguation = /^\s+\(\d+\)$/.test(suffix) ? suffix : "";
		return { ...choice, label: `${option.label}${disambiguation}`, description: option.description ?? choice.description };
	});
	const hasOther = labels.includes(ASK_OTHER) && (formRequest ? formHasOther === true : legacyOther);
	const hasChat = labels.includes(ASK_CHAT);
	const hasNext = labels.includes(ASK_NEXT);
	const multi = request.selectionMarker === "checkbox";
	const checked = new Set(request.checkedIndices ?? []);

	if (isApproval) {
		return (
			<div data-question-card={request.reqId} className={steadyCard} style={{ minHeight: minimumHeight }}>
				{presentation && <QuestionPresentationClaim session={session} reqId={request.reqId} />}
				{noteLine}
				{formContextLine}
				<Heading icon={<ShieldWarning className="text-warn" />}>
					<p className="mb-2 text-base font-medium text-fg">{t("question.approval")}</p>
					<pre className="selectable max-h-48 overflow-auto rounded-md bg-inset px-3 py-2 font-mono text-code whitespace-pre-wrap text-fg"><ColorText text={request.title} inlineCode /></pre>
				</Heading>
				{labels.length > 2 && (
					<div className="mt-3">
						<p className="text-sm font-medium text-fg">{t("question.approvalChoices")}</p>
						<p className="mt-1 text-sm text-fg-muted">{t(labels.some(label => label.startsWith("Always ")) ? "question.approvalChoicesHelp" : "question.approvalSessionHelp")}</p>
						<div className="mt-2 flex flex-wrap gap-2">
							{labels.filter(label => label !== once && label !== "Deny").map(label => (
								<Button key={label} variant="secondary" disabled={denying} className="h-auto! min-h-8 max-w-full whitespace-normal! py-1 text-left [overflow-wrap:anywhere] [&>span]:block [&>span]:min-w-0" data-approval-choice={label} onClick={() => answer(label)}>
									<ColorText text={label} inlineCode />
								</Button>
							))}
						</div>
					</div>
				)}
				<div className="mt-auto">
					<p className="mt-3 text-sm text-fg-muted">{t("question.messageDenies")}</p>
					{explaining && (
						<div className="mt-3">
							<Textarea ref={editorRef} aria-label={t("question.denialReason")} placeholder={t("question.denialReason")} value={other}
								onChange={event => setOther(event.target.value)} minRows={2} maxRows={6} disabled={denying} />
						</div>
					)}
					<div className="mt-3 flex flex-wrap justify-end gap-2">
						<Button variant="secondary" disabled={denying} onClick={() => answer("Deny")}>
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
						<Button variant="primary" disabled={denying} autoFocus data-approval-once={once} onClick={() => answer(once ?? undefined)}>
							{t(labels.length > 2 ? "question.allowOnce" : "question.allow")}
						</Button>
					</div>
				</div>
			</div>
		);
	}

	const submit = () => {
		if (other.trim()) {
			pendingCustom.set(session, other.trim());
			answer(ASK_OTHER);
			return;
		}
		answer(labels[selected]);
	};

	const activeIndex = other.trim() || selected >= choices.length ? -1 : selected;
	const helpText = formRequest ? undefined : request.helpText?.replaceAll("\u{f0311}", "Enter").replaceAll("\u{f12b7}", "Escape");

	return (
		<div data-question-card={request.reqId} className={steadyCard} style={{ minHeight: minimumHeight }}>
			{presentation && <QuestionPresentationClaim session={session} reqId={request.reqId} />}
			{cornerMenu}
			{noteLine}
			{formContextLine}
			<Heading icon={<Question className="text-accent" />}>
				<p id={titleId} className={cn("selectable text-base font-medium text-fg", cornerPad)}>
					<ColorText text={request.title} inlineCode />
				</p>
				{(multi || helpText) && <p className="mt-0.5 text-sm text-fg-muted"><ColorText text={helpText ?? t("question.chooseMany")} inlineCode /></p>}
			</Heading>
			<ChoiceGrid
				choices={choices}
				multi={multi}
				labelledBy={titleId}
				inlineCode
				disabled={disabled && !steadyControls}
				isOn={index => (multi ? checked.has(index) : selected === index && !other.trim())}
				activeIndex={activeIndex}
				onSelect={index => {
					if (multi) answerMultiChoice(index);
					else {
						setSelected(index);
						setOther("");
					}
				}}
				onConfirm={index => multi ? answerMultiChoice(index) : answer(labels[index])}
			/>
			{hasOther && !multi && !formRequest && (
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
			<div className="mt-auto">
				{statusLine}
				{formSkipMessage && <p id={`${titleId}-skip-reason`} className="mt-2 text-sm text-fg-muted">{formSkipMessage}</p>}
				<div className="mt-3 flex items-center gap-2">
					{hasChat && (
						<Button variant="ghost" icon={<ChatCircle />} onClick={() => answer(ASK_CHAT)}>
							{ASK_CHAT}
						</Button>
					)}
					<div className="flex-1" />
					{formRequest ? (
						<Button variant="ghost" disabled={(disabled && !steadyControls) || !!formSkipMessage} aria-describedby={formSkipMessage ? `${titleId}-skip-reason` : undefined} onClick={() => onFormSkip?.()}>
							{t("question.series.skipThisQuestion")}
						</Button>
					) : (
						<Button variant="ghost" onClick={() => answer()}>
							{t("question.skip")}
						</Button>
					)}
					{multi ? (
						<Button variant="primary" disabled={!hasNext || (disabled && !steadyControls)} onClick={() => answer(ASK_NEXT)}>
							{t("question.done")}
						</Button>
					) : (
						<Button variant="primary" disabled={disabled && !steadyControls} onClick={submit}>
							{t("question.answer")}
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}
