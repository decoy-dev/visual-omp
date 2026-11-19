/**
 * A multi-question `ask` as one card (DESIGN §4.8): one question at a time with its progress, a
 * way back to earlier questions, and the answers sent to omp together after the last one.
 */
import { ArrowLeft, ArrowRight, ChatCircle, Question } from "@phosphor-icons/react";
import { type KeyboardEvent, type ReactNode, useCallback, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionController } from "../../state/session";
import { Button, cn, MenuItem, PresenceSwap, Spinner, Textarea } from "../../ui";
import { ASK_CHAT, ASK_OTHER, formSkipReason, isComplete } from "./askSeries";
import { askSeriesFor, type AskSeriesState } from "./askSeriesStore";
import { CardActionsMenu, ChoiceGrid, cardClass, Heading, otherInputClass } from "./QuestionChoices";
import { FormContext } from "./FormContext";
import { ColorText } from "../../transcript/ColorText";
export function AskSeriesCard({ session, series, closing = false }: { session: SessionController; series: AskSeriesState; closing?: boolean }): ReactNode {
	const { t } = useTranslation("chat");
	const driver = askSeriesFor(session);
	const titleId = useId();
	const progressId = useId();
	const [direction, setDirection] = useState<1 | -1>(1);
	/** Set by Back and Next, so keyboard focus follows to the arriving question's picked (or first) option. */
	const moved = useRef(false);
	const focusOnArrival = useCallback((node: HTMLDivElement | null) => {
		if (!node || !moved.current) return;
		moved.current = false;
		(node.querySelector<HTMLElement>('[data-choice][tabindex="0"]') ?? node.querySelector<HTMLElement>("textarea, input"))?.focus({ preventScroll: true });
	}, []);
	const { questions, answers, index, phase } = series;
	const question = questions[index];
	const answer = answers[index];
	const sending = closing || phase !== "editing";
	const isForm = series.formHtml !== undefined;
	const canEnd = !sending && driver.pendingRequest() !== null;

	if (!question || !answer) return null;
	const last = index === questions.length - 1;
	const complete = isComplete(question, answer);
	const custom = answer.custom;
	const savedText = answer.text === undefined ? {} : { text: answer.text };
	const field = question.formField;
	const formText = field?.kind === "text";
	const allowOther = field ? field.kind === "choice" && field.other === true : true;
	const skipReason = isForm ? formSkipReason(question) : null;
	const skipReasonText = skipReason ? t(`question.series.skipUnavailable.${skipReason}`) : undefined;
	const activeIndex = question.multi || custom.trim() || answer.selected.length === 0 ? -1 : (answer.selected[0] ?? -1);
	const clearOfCorner = questions.length > 1 ? "pr-40 @max-[26rem]/askcard:pr-0" : "pr-8";

	const go = (to: number, advance: () => void = () => driver.show(to)) => {
		if (sending || to < 0 || to >= questions.length) return;
		setDirection(to > index ? 1 : -1);
		moved.current = true;
		advance();
	};
	const next = () => {
		if (sending || !complete) return;
		if (last) driver.submit();
		else go(index + 1);
	};
	const select = (option: number) => {
		if (sending) return;
		if (!question.multi) {
			driver.setAnswer(index, { selected: [option], custom: "", ...savedText });
			return;
		}
		const selected = answer.selected.includes(option) ? answer.selected.filter(at => at !== option) : [...answer.selected, option].sort((a, b) => a - b);
		driver.setAnswer(index, { selected, custom, ...savedText });
	};
	const skip = () => {
		if (!isForm) driver.skip();
		else if (last) driver.skipQuestion();
		else go(index + 1, () => driver.skipQuestion());
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		// Alt+Left moves the caret by word in a text field, so the shortcuts apply outside one.
		const target = event.target as HTMLElement;
		if (!event.altKey || event.metaKey || event.ctrlKey || target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
		if (event.key === "ArrowLeft" && index > 0) {
			event.preventDefault();
			go(index - 1);
		} else if (event.key === "ArrowRight" && !last) {
			event.preventDefault();
			next();
		}
	};

	return (
		<div data-question-card="series" data-ask-series={series.toolCallId} className={cn(cardClass, "relative @container/askcard")} onKeyDown={onKeyDown}>
			{/* Progress and the ⋯ menu share the top right; the title and the first context line keep clear of them, or start
			    below them once the card is too narrow to share the line. */}
			<div className="absolute top-4 right-3 flex items-center gap-2">
				{questions.length > 1 && (
					<span id={progressId} role="status" aria-live="polite" className="text-sm whitespace-nowrap text-fg-muted tabular-nums">
						{t("question.series.progress", { current: index + 1, total: questions.length })}
					</span>
				)}
				{!sending && (
					<CardActionsMenu>
						{isForm ? (
							<MenuItem danger disabled={!canEnd} onSelect={() => driver.cancelForm()}>{t("question.series.cancelForm")}</MenuItem>
						) : (
							<MenuItem icon={<ChatCircle />} disabled={!canEnd} onSelect={() => driver.chat()}>{ASK_CHAT}</MenuItem>
						)}
					</CardActionsMenu>
				)}
			</div>
			<PresenceSwap swapKey={index} variant="slide" direction={direction}>
				<div ref={focusOnArrival} className={cn(questions.length > 1 && "@max-[26rem]/askcard:pt-9")}>
					{field?.context.length ? <div className={clearOfCorner}><FormContext blocks={field.context} question={question.question} /></div> : null}
					<Heading icon={<Question className="text-accent" />}>
						<p id={titleId} className={cn("selectable text-base font-medium wrap-anywhere text-fg", clearOfCorner)}>
							<ColorText text={question.question} inlineCode />
						</p>
						{question.multi && <p className="mt-0.5 text-sm text-fg-muted">{t("question.chooseMany")}</p>}
					</Heading>
					{formText ? field?.control === "textarea" ? (
						<Textarea
							value={answer.text ?? ""}
							onChange={event => driver.setAnswer(index, { selected: [], custom: "", text: event.target.value })}
							placeholder={t("question.placeholder")}
							aria-labelledby={titleId}
							minRows={2}
							maxRows={8}
							disabled={sending}
						/>
					) : (
						<input
							value={answer.text ?? ""}
							onChange={event => driver.setAnswer(index, { selected: [], custom: "", text: event.target.value })}
							onKeyDown={event => {
								if (event.key === "Enter") next();
							}}
							disabled={sending}
							placeholder={t("question.placeholder")}
							aria-labelledby={titleId}
							className={otherInputClass}
						/>
					) : (
						<ChoiceGrid
							choices={question.options}
							multi={question.multi}
							labelledBy={titleId}
							inlineCode
							describedBy={questions.length > 1 ? progressId : undefined}
							isOn={option => answer.selected.includes(option) && (question.multi || !custom.trim())}
							activeIndex={activeIndex}
							onSelect={select}
							onConfirm={option => {
								select(option);
								if (last) driver.submit();
								else go(index + 1);
							}}
							disabled={sending}
						/>
					)}
					{allowOther && (
						<input
							value={custom}
							onChange={event => driver.setAnswer(index, { selected: answer.selected, custom: event.target.value, ...savedText })}
							onKeyDown={event => {
								if (event.key === "Enter") next();
							}}
							disabled={sending}
							placeholder={t("question.placeholder")}
							aria-label={ASK_OTHER}
							className={otherInputClass}
						/>
					)}
					{skipReasonText && <p id={`${titleId}-skip-reason`} className="mt-2 text-sm text-fg-muted">{skipReasonText}</p>}
				</div>
			</PresenceSwap>
			{!sending && <p className="mt-3 text-sm text-fg-muted">{t("question.messageCloses")}</p>}
			<div data-series-footer className="mt-3 flex flex-wrap items-center gap-2">
				{sending ? (
					<span role="status" className="inline-flex items-center gap-2 text-sm text-fg-muted">
						{closing ? <span data-form-status-text>{t("question.formClosing")}</span> : <>
							<Spinner />
							{t("question.series.sending")}
						</>}
					</span>
				) : index > 0 && (
					<Button variant="ghost" icon={<ArrowLeft />} onClick={() => go(index - 1)} aria-keyshortcuts="Alt+ArrowLeft">
						<FooterLabel full={t("question.series.previous")} />
					</Button>
				)}
				<div className="ml-auto flex items-center gap-2">
					{!sending && (
						<Button
							variant="ghost"
							disabled={isForm ? skipReason !== null : !canEnd}
							aria-describedby={skipReasonText ? `${titleId}-skip-reason` : undefined}
							title={skipReasonText}
							onClick={skip}
						>
							<FooterLabel
								full={t(isForm ? last ? "question.series.skipAndSend" : "question.series.skipThisQuestion" : "question.series.skip")}
								short={t("question.series.skipShort")}
							/>
						</Button>
					)}
					<Button
						variant="primary"
						disabled={!complete || sending}
						iconRight={last ? undefined : <ArrowRight />}
						onClick={next}
						aria-keyshortcuts={last ? undefined : "Alt+ArrowRight"}
					>
						{last
							? <FooterLabel full={t("question.series.send")} short={t("question.series.sendShort")} narrowOnly />
							: <FooterLabel full={t("question.series.next")} short={t("question.series.nextShort")} />}
					</Button>
				</div>
			</div>
		</div>
	);
}

/**
 * A footer label that keeps the footer on one row as the card narrows. Below 32rem (22rem with `narrowOnly`) only the
 * short label shows, or the button's icon alone without one; the rest of the full label stays for assistive
 * technology, so the button's name and text never change. The breakpoints are in rem, so they follow the app's text
 * size. A short label that does not begin the full one leaves the full label showing.
 */
function FooterLabel({ full, short, narrowOnly = false }: { full: string; short?: string; narrowOnly?: boolean }): ReactNode {
	const hidden = narrowOnly ? "@max-[22rem]/askcard:sr-only" : "@max-[32rem]/askcard:sr-only";
	if (short === undefined) return <span className={hidden}>{full}</span>;
	if (!full.startsWith(short)) return full;
	return <span>{short}<span className={hidden}>{full.slice(short.length)}</span></span>;
}
