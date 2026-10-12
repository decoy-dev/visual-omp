/**
 * A multi-question `ask` as one card (DESIGN §4.8): one question at a time with its progress, a
 * way back to earlier questions, and the answers sent to omp together after the last one.
 */
import { ArrowLeft, ArrowRight, ChatCircle, Question } from "@phosphor-icons/react";
import { type KeyboardEvent, type ReactNode, useCallback, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionController } from "../../state/session";
import { Button, cn, PresenceSwap, Spinner } from "../../ui";
import { ASK_CHAT, ASK_OTHER, isComplete } from "./askSeries";
import { askSeriesFor, type AskSeriesState } from "./askSeriesStore";
import { ChoiceGrid, cardClass, Heading, otherInputClass } from "./QuestionChoices";

export function AskSeriesCard({ session, series }: { session: SessionController; series: AskSeriesState }): ReactNode {
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
		(node.querySelector<HTMLElement>('[data-choice][tabindex="0"]') ?? node.querySelector<HTMLElement>("input"))?.focus({ preventScroll: true });
	}, []);
	const { questions, answers, index, phase } = series;
	const question = questions[index];
	const answer = answers[index];
	const sending = phase !== "editing";
	const canEnd = !sending && driver.pendingRequest() !== null;

	if (!question || !answer) return null;
	const last = index === questions.length - 1;
	const complete = isComplete(question, answer);
	const custom = answer.custom;
	const activeIndex = question.multi || custom.trim() || answer.selected.length === 0 ? -1 : (answer.selected[0] ?? -1);

	const go = (to: number) => {
		if (sending || to < 0 || to >= questions.length) return;
		setDirection(to > index ? 1 : -1);
		moved.current = true;
		driver.show(to);
	};
	const next = () => {
		if (sending || !complete) return;
		if (last) driver.submit();
		else go(index + 1);
	};
	const select = (option: number) => {
		if (sending) return;
		if (!question.multi) {
			driver.setAnswer(index, { selected: [option], custom: "" });
			return;
		}
		const selected = answer.selected.includes(option) ? answer.selected.filter(at => at !== option) : [...answer.selected, option].sort((a, b) => a - b);
		driver.setAnswer(index, { selected, custom });
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
		<div data-question-card="series" data-ask-series={series.toolCallId} className={cn(cardClass, "relative")} onKeyDown={onKeyDown}>
			{/* Outside the sliding content, so the progress stays put and is announced once per question. */}
			<span id={progressId} role="status" aria-live="polite" className="absolute top-4 right-4 mt-0.5 text-sm whitespace-nowrap text-fg-muted tabular-nums">
				{t("question.series.progress", { current: index + 1, total: questions.length })}
			</span>
			<PresenceSwap swapKey={index} variant="slide" direction={direction}>
				<div ref={focusOnArrival}>
					<Heading icon={<Question className="text-accent" />}>
						{/* The right padding keeps a long title clear of the progress label. */}
						<p id={titleId} className="selectable pr-28 text-base font-medium wrap-anywhere text-fg">
							{question.question}
						</p>
						{question.multi && <p className="mt-0.5 text-sm text-fg-muted">{t("question.chooseMany")}</p>}
					</Heading>
					<ChoiceGrid
						choices={question.options}
						multi={question.multi}
						labelledBy={titleId}
						describedBy={progressId}
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
					<input
						value={custom}
						onChange={event => driver.setAnswer(index, { selected: answer.selected, custom: event.target.value })}
						onKeyDown={event => {
							if (event.key === "Enter") next();
						}}
						disabled={sending}
						placeholder={t("question.placeholder")}
						aria-label={ASK_OTHER}
						className={otherInputClass}
					/>
				</div>
			</PresenceSwap>
			<div className="mt-3 flex flex-wrap items-center gap-2">
				{sending ? (
					<span role="status" className="inline-flex items-center gap-2 text-sm text-fg-muted">
						<Spinner />
						{t("question.series.sending")}
					</span>
				) : (
					<>
						{index > 0 && (
							<Button variant="ghost" icon={<ArrowLeft />} onClick={() => go(index - 1)} aria-keyshortcuts="Alt+ArrowLeft">
								{t("question.series.previous")}
							</Button>
						)}
						<Button variant="ghost" icon={<ChatCircle />} disabled={!canEnd} onClick={() => driver.chat()}>
							{ASK_CHAT}
						</Button>
					</>
				)}
				<div className="ml-auto flex items-center gap-2">
					{!sending && (
						<Button variant="ghost" disabled={!canEnd} onClick={() => driver.skip()}>
							{t("question.series.skip")}
						</Button>
					)}
					<Button
						variant="primary"
						disabled={!complete || sending}
						iconRight={last ? undefined : <ArrowRight />}
						onClick={next}
						aria-keyshortcuts={last ? undefined : "Alt+ArrowRight"}
					>
						{last ? t("question.series.send") : t("question.series.next")}
					</Button>
				</div>
			</div>
		</div>
	);
}
