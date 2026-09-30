/**
 * omp questions that reach the app as collab `ui-request`s (DESIGN §4.8): tool approvals
 * (select "Approve"/"Deny"), the `ask` tool (one select per question with Other / Chat / Next
 * sentinels; multi-select toggles one option per answer), generic extension selects, and editors.
 */
import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { Check, MessageCircle, ShieldAlert } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionController } from "../../state/session";
import { Button, cn, Textarea } from "../../ui";

// Sentinel labels appended by omp's ask dialog (coding-agent modes/controllers/extension-ui-controller.ts).
const OTHER = "Other (type your own)";
const CHAT = "Chat about this";
const NEXT = "Next →";
const CUSTOM_ANSWER_PREFIX = "Custom answer: ";

/** Text typed into "Other" is sent as soon as omp asks for the custom answer. */
const pendingCustom = new WeakMap<SessionController, string>();

function labelOf(item: CollabUiRequest & { kind: "select" }, index: number): { label: string; description?: string } {
	const option = item.options[index];
	if (option === undefined) return { label: "" };
	return typeof option === "string" ? { label: option } : option;
}

export function QuestionCard({ session, request }: { session: SessionController; request: CollabUiRequest }): ReactNode {
	const { t } = useTranslation("chat");
	const [text, setText] = useState(request.kind === "editor" ? (request.prefill ?? "") : "");
	const [selected, setSelected] = useState(request.kind === "select" ? (request.initialIndex ?? 0) : 0);
	const [other, setOther] = useState("");
	const rootRef = useRef<HTMLDivElement>(null);

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
			<div ref={rootRef} data-question-card={request.reqId} className="rounded-lg border border-border bg-panel p-4 shadow-[inset_2px_0_0_var(--agent)] shadow-(--shadow-card)">
				<p className="bracket-label mb-1.5 text-agent!">{t("question.eyebrow")}</p>
				<p className="selectable mb-3 text-base text-fg">{request.title}</p>
				<Textarea value={text} onChange={event => setText(event.target.value)} placeholder={t("question.placeholder")} minRows={2} maxRows={8} autoFocus />
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
			<div data-question-card={request.reqId} className="rounded-lg border border-border bg-panel p-4 shadow-[inset_2px_0_0_var(--warn)] shadow-(--shadow-card)">
				<div className="mb-1.5 flex items-center gap-1.5">
					<ShieldAlert className="size-3.5 text-warn" aria-hidden />
					<span className="bracket-label">{t("question.approval")}</span>
				</div>
				<pre className="selectable mb-3 max-h-48 overflow-auto rounded-md bg-inset px-3 py-2 font-mono text-code whitespace-pre-wrap text-fg">{request.title}</pre>
				<div className="flex justify-end gap-2">
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

	return (
		<div data-question-card={request.reqId} className="rounded-lg border border-border bg-panel p-4 shadow-[inset_2px_0_0_var(--agent)] shadow-(--shadow-card)">
			<p className="bracket-label mb-1.5 text-agent!">{t("question.eyebrow")}</p>
			<p className="selectable mb-1 text-base text-fg">{request.title}</p>
			{(multi || request.helpText) && <p className="mb-2 text-sm text-fg-muted">{request.helpText ?? t("question.chooseMany")}</p>}
			<div role={multi ? "group" : "radiogroup"} aria-label={request.title} className="mt-2 grid gap-2 sm:grid-cols-2">
				{choices.map((label, index) => {
					const { description } = labelOf(request, index);
					const on = multi ? checked.has(index) : selected === index && !other.trim();
					return (
						<button
							key={label}
							type="button"
							role={multi ? "checkbox" : "radio"}
							aria-checked={on}
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
								"flex min-h-12 items-start gap-2.5 rounded-md border px-3 py-2.5 text-left outline-none focus-visible:outline-2 focus-visible:outline-ring",
								on ? "border-accent bg-accent-muted" : "border-border-strong bg-panel hover:bg-hover",
							)}
						>
							<span
								className={cn(
									"mt-0.5 flex size-4 shrink-0 items-center justify-center border",
									multi ? "rounded-sm" : "rounded-full",
									on ? "border-accent bg-accent text-accent-fg" : "border-border-strong",
								)}
								aria-hidden
							>
								{on && <Check className="size-3" strokeWidth={3} />}
							</span>
							<span className="min-w-0">
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
					className="mt-2 h-9 w-full rounded-md border border-border-strong bg-panel px-3 text-md text-fg placeholder:text-fg-faint focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-ring"
				/>
			)}
			<div className="mt-3 flex items-center gap-2">
				{hasChat && (
					<Button variant="ghost" icon={<MessageCircle />} onClick={() => session.answer(request.reqId, CHAT)}>
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
						{t("question.answer")} →
					</Button>
				)}
			</div>
		</div>
	);
}
