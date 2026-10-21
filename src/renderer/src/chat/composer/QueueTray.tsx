/**
 * Messages waiting for omp to finish its current reply (DESIGN §3.6), in a tray tucked on top of the
 * composer card so they read as the next things omp gets: send one now (steers the running turn), edit
 * its text inline, remove it, or drag rows to change the order. A message with images carries a chip
 * with their count, and its images go with it. Shows at most three rows; the rest collapse into
 * "N more". The tray also carries the chip that points at an unanswered omp question, and the notice
 * with "Restart omp" while omp's message box may still hold a failed message's images.
 */
import { ArrowCounterClockwise, DotsSixVertical, Hourglass, ImageSquare, PaperPlaneRight, PencilSimple, Question, Warning, X } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type DragEvent, type KeyboardEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { QueuedMessage, SessionController } from "../../state/session";
import { Button, Chip, cn, duration, ease, Expand, IconButton, spring, toast, useMotionReduced } from "../../ui";

const VISIBLE_ROWS = 3;

interface QueueTrayProps {
	session: SessionController;
	queue: readonly QueuedMessage[];
	/** Pending omp question (reqId) not yet answered. */
	questionId: number | null;
	/** omp's message box may still hold images from a message that didn't send (`SessionView.strandedImages`). */
	strandedImages: boolean;
}

/** Bring the question card into view and put focus on its first control. */
function revealQuestion(reqId: number, reduced: boolean): void {
	const card =
		document.querySelector<HTMLElement>(`[data-question-card="${reqId}"]`) ??
		document.querySelector<HTMLElement>("[data-question-card]");
	if (!card) return;
	card.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
	card.querySelector<HTMLElement>("button, [tabindex='0'], textarea, input")?.focus({ preventScroll: true });
}

/**
 * The tray stays mounted in the composer and opens or closes itself. After the last queued message leaves, the
 * section is held open until that row's exit animation finishes, then collapses.
 */
export function QueueTray({ session, queue, questionId, strandedImages }: QueueTrayProps) {
	const { t } = useTranslation("composer");
	const [expanded, setExpanded] = useState(false);
	const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
	const [dragId, setDragId] = useState<string | null>(null);
	const [dropIndex, setDropIndex] = useState<number | null>(null);
	const reducedMotion = useMotionReduced();
	// Held open while rows are still leaving; the last visible count labels the section during that exit.
	const [held, setHeld] = useState(queue.length > 0);
	if (queue.length > 0 && !held) setHeld(true);
	const queueLength = useRef(queue.length);
	queueLength.current = queue.length;
	const shownCount = useRef(queue.length);
	if (queue.length > 0) shownCount.current = queue.length;
	const count = shownCount.current;
	const rows = expanded ? queue : queue.slice(0, VISIBLE_ROWS);
	const hidden = queue.length - rows.length;
	// "Restart omp" stays disabled from the click until the restart clears the hold, or fails.
	const [restarting, setRestarting] = useState(false);
	if (restarting && !strandedImages) setRestarting(false);

	const restart = () => {
		setRestarting(true);
		session.restart().catch((error: unknown) => {
			setRestarting(false);
			toast({ tone: "err", message: t("queue.restartFailed"), description: error instanceof Error ? error.message : String(error) });
		});
	};

	const commitEdit = () => {
		if (!editing) return;
		const text = editing.text.trim();
		// Clearing the text of a message with images keeps the images queued on their own.
		const images = queue.find(item => item.id === editing.id)?.images.length ?? 0;
		if (text || images > 0) session.editQueued(editing.id, text);
		else session.removeQueued(editing.id);
		setEditing(null);
	};

	const onEditKey = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter" && !event.nativeEvent.isComposing) {
			event.preventDefault();
			commitEdit();
		} else if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			setEditing(null);
		}
	};

	const onDragOver = (event: DragEvent<HTMLDivElement>, index: number) => {
		if (!dragId) return;
		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer.dropEffect = "move";
		const box = event.currentTarget.getBoundingClientRect();
		setDropIndex(event.clientY > box.top + box.height / 2 ? index + 1 : index);
	};

	const onDrop = (event: DragEvent<HTMLDivElement>) => {
		if (!dragId || dropIndex === null) return;
		event.preventDefault();
		event.stopPropagation();
		const from = queue.findIndex(item => item.id === dragId);
		session.moveQueued(dragId, from < dropIndex ? dropIndex - 1 : dropIndex);
		setDragId(null);
		setDropIndex(null);
	};

	return (
		<Expand open={held || questionId !== null || strandedImages}>
			<div className="mx-3 rounded-t-lg border border-b-0 border-border-strong bg-inset">
			<Expand open={questionId !== null}>
				<div className="flex items-center gap-2 px-3 pt-2 pb-1.5">
					<button
						type="button"
						onClick={() => {
							if (questionId !== null) revealQuestion(questionId, reducedMotion);
						}}
						className="inline-flex h-6 items-center gap-1.5 rounded-full bg-accent-muted px-2.5 text-xs font-semibold text-accent outline-none transition-colors duration-(--dur-fast) hover:bg-selected focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
					>
						<Question weight="bold" className="size-3" aria-hidden />
						{t("question.chip")}
					</button>
					<span className="text-xs text-fg-faint">{t("question.hint")}</span>
				</div>
			</Expand>
			<Expand open={strandedImages}>
				<div role="status" className="flex items-center gap-2 px-3 pt-2 pb-1.5">
					<Warning weight="fill" className="size-3.5 shrink-0 text-warn" aria-hidden />
					<p className="min-w-0 flex-1 text-xs text-fg-muted">{t("queue.stranded")}</p>
					<Button
						size="sm"
						variant="secondary"
						icon={<ArrowCounterClockwise />}
						className="h-6 shrink-0 px-2"
						disabled={restarting}
						onClick={restart}
					>
						{t("queue.restart")}
					</Button>
				</div>
			</Expand>
			<Expand open={held}>
				<section aria-label={t("queue.label", { count })} className="p-menu">
					<p className="flex items-center gap-1.5 px-1.5 pb-1 text-xs font-medium text-fg-muted">
						<Hourglass className="size-3 text-fg-faint" aria-hidden />
						{t("queue.title", { count })}
					</p>
					<ol className="relative flex flex-col gap-0.5">
						<AnimatePresence
							initial={false}
							mode="popLayout"
							onExitComplete={() => {
								if (queueLength.current === 0) setHeld(false);
							}}
						>
							{rows.map((item, index) => (
								// Motion owns the li (enter, leave, reorder); the inner div keeps native drag and drop.
								<motion.li
									key={item.id}
									layout="position"
									initial={{ opacity: 0, y: 6 }}
									animate={{ opacity: 1, y: 0 }}
									exit={{ opacity: 0, x: 12, transition: { duration: duration.fast, ease: "easeIn" } }}
									transition={{ layout: spring.gentle, y: spring.gentle, opacity: { duration: duration.base, ease: ease.outQuart } }}
								>
									<div
										draggable={editing?.id !== item.id}
										onDragStart={event => {
											setDragId(item.id);
											event.dataTransfer.effectAllowed = "move";
											event.dataTransfer.setData("application/x-vomp-queue", item.id);
										}}
										onDragEnd={() => {
											setDragId(null);
											setDropIndex(null);
										}}
										onDragOver={event => onDragOver(event, index)}
										onDrop={onDrop}
										className={cn(
											"group relative flex h-8 items-center gap-1 rounded-sm bg-panel pr-1 text-sm shadow-(--shadow-card) transition-opacity duration-(--dur-fast)",
											dragId === item.id && "opacity-50",
											dropIndex === index && dragId && "before:absolute before:-top-px before:inset-x-1 before:h-0.5 before:rounded-full before:bg-accent",
											dropIndex === index + 1 && index === rows.length - 1 && dragId &&
												"after:absolute after:-bottom-px after:inset-x-1 after:h-0.5 after:rounded-full after:bg-accent",
										)}
									>
										<button
											type="button"
											aria-label={t("queue.reorder", { position: index + 1, count: queue.length })}
											title={t("queue.dragHint")}
											onKeyDown={event => {
												if (event.key === "ArrowUp" && index > 0) {
													event.preventDefault();
													session.moveQueued(item.id, index - 1);
												} else if (event.key === "ArrowDown" && index < queue.length - 1) {
													event.preventDefault();
													session.moveQueued(item.id, index + 1);
												}
											}}
											className="inline-flex h-8 w-6 shrink-0 cursor-grab items-center justify-center rounded-sm text-fg-faint outline-none hover:text-fg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring active:cursor-grabbing"
										>
											<DotsSixVertical weight="bold" className="size-3.5" aria-hidden />
										</button>
										{item.images.length > 0 && (
											// A narrow composer shows only the count, so the message text keeps some room.
											<Chip icon={<ImageSquare />} title={item.images.map(image => image.name).join("\n")} className="h-5 px-2">
												<span className="@max-[28rem]/composer:sr-only">{t("queue.images", { count: item.images.length })}</span>
												<span aria-hidden className="hidden @max-[28rem]/composer:inline">
													{item.images.length}
												</span>
											</Chip>
										)}
										{editing?.id === item.id ? (
											<input
												// biome-ignore lint/a11y/noAutofocus: inline edit opens on explicit user action.
												autoFocus
												aria-label={t("queue.editLabel")}
												value={editing.text}
												onChange={event => setEditing({ id: item.id, text: event.target.value })}
												onKeyDown={onEditKey}
												onBlur={commitEdit}
												className="h-6 min-w-0 flex-1 rounded-sm border border-ring bg-panel px-2 text-sm text-fg outline-none"
											/>
										) : (
											<span className="min-w-0 flex-1 truncate text-fg" title={item.text}>
												{item.text}
											</span>
										)}
										<Button
											size="sm"
											variant="ghost"
											icon={<PaperPlaneRight />}
											className="h-6 px-2 text-accent"
											title={t("queue.sendNowTip")}
											// Nothing may be typed into omp until it restarts (the notice above says why).
											disabled={strandedImages}
											onClick={() =>
												session.sendNow(item.id).catch((error: unknown) =>
													toast({
														tone: "err",
														message: t("queue.sendFailed"),
														description: error instanceof Error ? error.message : String(error),
													}),
												)
											}
										>
											{/* A narrow composer keeps only the icon, so the message text keeps its width. */}
											<span className="@max-[28rem]/composer:sr-only">{t("queue.sendNow")}</span>
										</Button>
										<IconButton
											size="sm"
											label={t("queue.edit")}
											icon={<PencilSimple />}
											onClick={() => setEditing({ id: item.id, text: item.text })}
										/>
										<IconButton
											size="sm"
											label={t("queue.remove")}
											icon={<X />}
											onClick={() => session.removeQueued(item.id)}
										/>
									</div>
								</motion.li>
							))}
						</AnimatePresence>
					</ol>
					{(hidden > 0 || expanded) && queue.length > VISIBLE_ROWS && (
						<button
							type="button"
							onClick={() => setExpanded(value => !value)}
							className="mt-1 ml-7 rounded-sm px-1 text-xs font-medium text-fg-muted outline-none hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
						>
							{expanded ? t("queue.less") : t("queue.more", { count: hidden })}
						</button>
					)}
				</section>
			</Expand>
			</div>
		</Expand>
	);
}
