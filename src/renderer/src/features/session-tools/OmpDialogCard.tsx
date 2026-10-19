/**
 * DESIGN §4.8 for omp's own in-place dialogs. Builtin commands (`/seance`, `/cleanse`, `/fork`
 * confirms, the goal prompts…) ask through omp's generic selector, confirm, input and editor, which
 * stay local to the TUI instead of reaching the app over collab. The card reads the dialog from the
 * painted screen (`ompDialog.ts`) and answers it with keys: a choice moves omp's highlight until the
 * screen shows it on the option, then presses Enter; a text answer replaces the field's text and
 * presses the submit key omp's legend names; Cancel presses omp's cancel key. The dialog is
 * registered as a native overlay (index.ts), so the terminal sheet stays closed while the card shows.
 */
import { Info, Question } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Rise, Textarea } from "@/ui";
import { ChoiceGrid, cardClass, Heading } from "../../chat/transcript/QuestionChoices";
import type { ChatSlotProps } from "../../registry/slots";
import { useApp } from "../../state/app";
import type { SessionController } from "../../state/session";
import { reportFailure } from "./drive";
import { dialogKey, type OmpDialog, type OmpSelectDialog, type OmpTextDialog, parseOmpDialog } from "./ompDialog";
import { cancelDialog, chooseOption, submitText } from "./ompDialogActions";
import { screenPoller, useOmpScreen, useSessionView } from "./status";

type Busy = "answer" | "cancel" | number | null;

function useAction(session: SessionController): [Busy, (busy: Exclude<Busy, null>, action: () => Promise<void>) => Promise<void>] {
	const [busy, setBusy] = useState<Busy>(null);
	const run = async (next: Exclude<Busy, null>, action: () => Promise<void>) => {
		if (busy !== null) return;
		setBusy(next);
		try {
			await action();
		} catch (error) {
			reportFailure(error);
		} finally {
			setBusy(null);
			void screenPoller(session).refresh();
		}
	};
	return [busy, run];
}

function Detail({ dialog }: { dialog: OmpDialog }): ReactNode {
	if (dialog.detail.length === 0) return null;
	return <p className="selectable mt-0.5 text-sm whitespace-pre-line text-fg-muted">{dialog.detail.join("\n")}</p>;
}

function SelectBody({ session, dialog }: { session: SessionController; dialog: OmpSelectDialog }): ReactNode {
	const { t } = useTranslation("session");
	const titleId = useId();
	// The pick follows its label, because a windowed list repaints other rows as omp's highlight scrolls.
	const [pickedLabel, setPickedLabel] = useState(dialog.options[dialog.selected]?.label ?? "");
	const found = dialog.options.findIndex(option => option.label === pickedLabel);
	const picked = found >= 0 ? found : dialog.selected;
	const [busy, run] = useAction(session);
	const answer = (index: number) => run(dialog.confirm ? index : "answer", () => chooseOption(session, dialog, index));

	if (dialog.confirm) {
		return (
			<>
				<Heading icon={<Question className="text-accent" />}>
					<p id={titleId} className="selectable text-base font-medium text-fg">
						{dialog.title}
					</p>
					<Detail dialog={dialog} />
				</Heading>
				<div className="mt-3 flex justify-end gap-2">
					<Button variant="secondary" loading={busy === 1} disabled={busy !== null} onClick={() => void answer(1)}>
						{dialog.options[1]?.label}
					</Button>
					<Button variant="primary" loading={busy === 0} disabled={busy !== null} onClick={() => void answer(0)}>
						{dialog.options[0]?.label}
					</Button>
				</div>
			</>
		);
	}

	return (
		<>
			<Heading icon={<Question className="text-accent" />}>
				<p id={titleId} className="selectable text-base font-medium text-fg">
					{dialog.title}
				</p>
				<Detail dialog={dialog} />
				{dialog.help && <p className="mt-0.5 text-sm text-fg-muted">{dialog.help}</p>}
			</Heading>
			<ChoiceGrid
				choices={dialog.options.map(option => ({ label: option.label, description: option.description ?? undefined }))}
				multi={false}
				labelledBy={titleId}
				isOn={index => index === picked}
				activeIndex={picked}
				onSelect={index => setPickedLabel(dialog.options[index]?.label ?? "")}
				onConfirm={index => void answer(index)}
				disabled={busy !== null}
			/>
			{dialog.hidden > 0 && (
				<div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
					<Info aria-hidden className="size-4 shrink-0" />
					<span className="min-w-0 flex-1">
						{dialog.query ? t("ompDialog.filtered", { count: dialog.hidden, query: dialog.query }) : t("ompDialog.more", { count: dialog.hidden })}
					</span>
					<Button size="sm" variant="ghost" onClick={() => useApp.getState().openTerminal(session.tabId)}>
						{t("ompDialog.openTerminal")}
					</Button>
				</div>
			)}
			<div className="mt-3 flex justify-end gap-2">
				<Button variant="ghost" loading={busy === "cancel"} disabled={busy !== null} onClick={() => void run("cancel", () => cancelDialog(session, dialog))}>
					{t("ompDialog.cancel")}
				</Button>
				<Button variant="primary" loading={busy === "answer"} disabled={busy !== null} onClick={() => void answer(picked)}>
					{t("ompDialog.choose")}
				</Button>
			</div>
		</>
	);
}

function TextBody({ session, dialog }: { session: SessionController; dialog: OmpTextDialog }): ReactNode {
	const { t } = useTranslation("session");
	const titleId = useId();
	const [text, setText] = useState(dialog.value);
	const [busy, run] = useAction(session);
	const send = () => run("answer", () => submitText(session, dialog, dialog.kind === "input" ? text.replace(/\s*\n\s*/g, " ") : text));

	return (
		<>
			<Heading icon={<Question className="text-accent" />}>
				<p id={titleId} className="selectable mb-1 text-base font-medium text-fg">
					{dialog.title}
				</p>
				<Detail dialog={dialog} />
				<div className="mt-2">
					{dialog.kind === "input" ? (
						<Input
							aria-labelledby={titleId}
							value={text}
							onChange={event => setText(event.currentTarget.value)}
							onKeyDown={event => {
								if (event.key === "Enter" && !event.nativeEvent.isComposing) {
									event.preventDefault();
									void send();
								}
							}}
							placeholder={t("ompDialog.placeholder")}
							disabled={busy !== null}
							autoFocus
						/>
					) : (
						<Textarea
							aria-labelledby={titleId}
							value={text}
							onChange={event => setText(event.currentTarget.value)}
							onKeyDown={event => {
								if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
									event.preventDefault();
									void send();
								}
							}}
							placeholder={t("ompDialog.placeholder")}
							minRows={2}
							maxRows={8}
							disabled={busy !== null}
							autoFocus
						/>
					)}
				</div>
			</Heading>
			<div className="mt-3 flex justify-end gap-2">
				<Button variant="ghost" loading={busy === "cancel"} disabled={busy !== null} onClick={() => void run("cancel", () => cancelDialog(session, dialog))}>
					{t("ompDialog.cancel")}
				</Button>
				<Button variant="primary" loading={busy === "answer"} disabled={busy !== null} onClick={() => void send()}>
					{t("ompDialog.send")}
				</Button>
			</div>
		</>
	);
}

/** The card after the transcript while omp shows one of its in-place dialogs. */
export function OmpDialogCard({ session }: ChatSlotProps) {
	const { t } = useTranslation("session");
	const view = useSessionView(session);
	const { lines } = useOmpScreen(session);
	const live = view.mode === "live" && !view.readOnly;
	const focused = view.host?.tui?.focused ?? null;
	// Questions mirrored over collab are QuestionCard's, even while omp paints the same dialog locally.
	const asking = Boolean(view.guest?.uiRequest);

	// A dialog takes keyboard focus from omp's editor: read the screen now instead of on the next idle tick.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `focused` is the trigger, not an input.
	useEffect(() => {
		if (live) void screenPoller(session).refresh();
	}, [focused, live, session]);

	const dialog = live && !asking ? parseOmpDialog(lines) : null;
	if (!dialog) return null;
	return (
		<Rise as="section" key={dialogKey(dialog)} className="my-3" aria-label={t("ompDialog.aria")}>
			<div className={cardClass}>
				{dialog.kind === "select" ? <SelectBody session={session} dialog={dialog} /> : <TextBody session={session} dialog={dialog} />}
			</div>
		</Rise>
	);
}
