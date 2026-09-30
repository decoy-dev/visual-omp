/**
 * omp questions that reach the app as collab `ui-request`s (DESIGN §4.8): tool approvals
 * (select "Approve"/"Deny"), the `ask` tool (one select per question with Other / Chat / Next
 * sentinels; multi-select toggles one option per answer), generic extension selects, and editors.
 */
import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { ChatCircle, Check, Question, ShieldWarning } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionController } from "../../state/session";
import { Button, cn, spring, Textarea } from "../../ui";

// Sentinel labels appended by omp's ask dialog (coding-agent modes/controllers/extension-ui-controller.ts).
const OTHER = "Other (type your own)";
const CHAT = "Chat about this";
const NEXT = "Next →";
const CUSTOM_ANSWER_PREFIX = "Custom answer: ";

/** Text typed into "Other" is sent as soon as omp asks for the custom answer. */
const pendingCustom = new WeakMap<SessionController, string>();

const cardClass = "rounded-lg border border-border bg-panel p-4 shadow-(--shadow-card)";

function labelOf(item: CollabUiRequest & { kind: "select" }, index: number): { label: string; description?: string } {
	const option = item.options[index];
	if (option === undefined) return { label: "" };
	return typeof option === "string" ? { label: option } : option;
}

/** The question itself, led by a glyph that says who is asking and why. */
function Heading({ icon, children }: { icon: ReactNode; children: ReactNode }): ReactNode {
	return (
		<div className="flex items-start gap-2.5">
			<span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center [&>svg]:size-4.5" aria-hidden>
				{icon}
			</span>
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	);
}

export function QuestionCard({ session, request }: { session: SessionController; request: CollabUiRequest }): ReactNode {
	const { t } = useTranslation("chat");
	const [text, setText] = useState(request.kind === "editor" ? (request.prefill ?? "") : "");
	const [selected, setSelected] = useState(request.kind === "select" ? (request.initialIndex ?? 0) : 0);
	const [other, setOther] = useState("");
	const rootRef = useRef<HTMLDivElement>(null);
	const indicatorId = useId();
	const titleId = useId();

	// Answer the follow-up editor for an "Other" choice without showing a second card.
	useEffect(() => {
		if (request.kind !== "editor" || !request.title.startsWith(CUSTOM_ANSWER_PREFIX)) return;
		const custom = pendingCustom.get(session);
		if (custom === undefined) return;
		pendingCustom.delete(session);
		session.answer(request.reqId, custom);
	}, [request, session]);

	if (request.kind === "editor") {
		if (request.title.startsWith(CUSTOM_ANSWER_PREFIX) && pendingCustom.has(session)) return null;
		return (
			<div ref={rootRef} data-question-card={request.reqId} className={cardClass}>
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
	const isApproval = labels.length === 2 && labels[0] === "Approve" && labels[1] === "Deny";
	const markable = request.markableCount ?? labels.filter(label => label !== OTHER && label !== CHAT && label !== NEXT).length;
	const choices = labels.slice(0, markable);
	const hasOther = labels.includes(OTHER);
	const hasChat = labels.includes(CHAT);
	const hasNext = labels.includes(NEXT);
	const multi = request.selectionMarker === "checkbox";
	const checked = new Set(request.checkedIndices ?? []);

	if (isApproval) {
		return (
			<div data-question-card={request.reqId} className={cardClass}>
				<Heading icon={<ShieldWarning className="text-warn" />}>
					<p className="mb-2 text-base font-medium text-fg">{t("question.approval")}</p>
					<pre className="selectable max-h-48 overflow-auto rounded-md bg-inset px-3 py-2 font-mono text-code whitespace-pre-wrap text-fg">{request.title}</pre>
				</Heading>
				<div className="mt-3 flex justify-end gap-2">
					<Button variant="secondary" onClick={() => session.answer(request.reqId, "Deny")}>
						{t("question.deny")}
					</Button>
					<Button variant="primary" autoFocus onClick={() => session.answer(request.reqId, "Approve")}>
						{t("question.allow")}
					</Button>
				</div>
			</div>
		);
	}

	const submit = () => {
		if (other.trim()) {
			pendingCustom.set(session, other.trim());
			session.answer(request.reqId, OTHER);
			return;
		}
		session.answer(request.reqId, labels[selected]);
	};

	const activeIndex = other.trim() || selected >= choices.length ? -1 : selected;
	const moveSelection = (event: KeyboardEvent<HTMLDivElement>) => {
		const current = Number((event.target as HTMLElement).dataset.choice ?? activeIndex);
		const last = choices.length - 1;
		const next =
			event.key === "ArrowDown" || event.key === "ArrowRight"
				? current >= last ? 0 : current + 1
				: event.key === "ArrowUp" || event.key === "ArrowLeft"
					? current <= 0 ? last : current - 1
					: event.key === "Home"
						? 0
						: event.key === "End"
							? last
							: null;
		if (next === null) return;
		event.preventDefault();
		setSelected(next);
		setOther("");
		event.currentTarget.querySelector<HTMLElement>(`[data-choice="${next}"]`)?.focus();
	};

	return (
		<div data-question-card={request.reqId} className={cardClass}>
			<Heading icon={<Question className="text-accent" />}>
				<p id={titleId} className="selectable text-base font-medium text-fg">
					{request.title}
				</p>
				{(multi || request.helpText) && <p className="mt-0.5 text-sm text-fg-muted">{request.helpText ?? t("question.chooseMany")}</p>}
			</Heading>
			<div
				role={multi ? "group" : "radiogroup"}
				aria-labelledby={titleId}
				onKeyDown={multi ? undefined : moveSelection}
				className="mt-3 grid gap-2 sm:grid-cols-2"
			>
				{choices.map((label, index) => {
					const { description } = labelOf(request, index);
					const on = multi ? checked.has(index) : selected === index && !other.trim();
					// Radio pattern: only the checked option (or the first) is a tab stop; arrow keys move and select.
					const tabStop = multi || (activeIndex === -1 ? index === 0 : index === activeIndex);
					return (
						<button
							key={label}
							type="button"
							role={multi ? "checkbox" : "radio"}
							aria-checked={on}
							tabIndex={tabStop ? 0 : -1}
							data-choice={index}
							onClick={() => {
								if (multi) session.answer(request.reqId, label);
								else {
									setSelected(index);
									setOther("");
								}
							}}
							onDoubleClick={() => {
								if (!multi) session.answer(request.reqId, label);
							}}
							className={cn(
								"relative flex min-h-12 items-start gap-2.5 rounded-md border px-3 py-2.5 text-left outline-none transition-colors duration-(--dur) focus-visible:outline-2 focus-visible:outline-ring",
								on ? "border-transparent" : "border-control hover:bg-hover",
								multi && on && "border-accent bg-accent-muted",
							)}
						>
							{/* Single choice: one highlight slides to the picked option. */}
							{!multi && on && (
								<motion.span
									layoutId={indicatorId}
									aria-hidden
									transition={spring.snappy}
									className="absolute -inset-px rounded-md border border-accent bg-accent-muted"
								/>
							)}
							<span
								className={cn(
									"relative mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-colors duration-(--dur)",
									multi ? "rounded-sm" : "rounded-full",
									on ? "border-accent bg-accent text-accent-fg" : "border-control bg-panel",
								)}
								aria-hidden
							>
								<AnimatePresence initial={false}>
									{on && (
										<motion.span
											key="mark"
											initial={{ scale: 0.4, opacity: 0 }}
											animate={{ scale: 1, opacity: 1 }}
											exit={{ scale: 0.4, opacity: 0 }}
											transition={spring.snappy}
											className="inline-flex"
										>
											{multi ? <Check weight="bold" className="size-3" /> : <span className="size-1.5 rounded-full bg-accent-fg" />}
										</motion.span>
									)}
								</AnimatePresence>
							</span>
							<span className="relative min-w-0">
								<span className="block text-md font-medium text-fg">{label}</span>
								{description && <span className="mt-0.5 block text-sm text-fg-muted">{description}</span>}
							</span>
						</button>
					);
				})}
			</div>
			{hasOther && !multi && (
				<input
					value={other}
					onChange={event => setOther(event.target.value)}
					onKeyDown={event => {
						if (event.key === "Enter") submit();
					}}
					placeholder={t("question.placeholder")}
					aria-label={OTHER}
					className="mt-2 h-9 w-full rounded-md border border-control bg-panel px-3 text-md text-fg transition-colors duration-(--dur) placeholder:text-fg-faint hover:border-fg-muted focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-ring"
				/>
			)}
			<div className="mt-3 flex items-center gap-2">
				{hasChat && (
					<Button variant="ghost" icon={<ChatCircle />} onClick={() => session.answer(request.reqId, CHAT)}>
						{CHAT}
					</Button>
				)}
				<div className="flex-1" />
				<Button variant="ghost" onClick={() => session.answer(request.reqId, undefined)}>
					{t("question.skip")}
				</Button>
				{multi ? (
					<Button variant="primary" disabled={!hasNext} onClick={() => session.answer(request.reqId, NEXT)}>
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
