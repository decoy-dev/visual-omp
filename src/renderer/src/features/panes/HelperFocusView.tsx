import { ArrowLeft, ChatCircleText, Info, PaperPlaneTilt, X } from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { TranscriptBody } from "../../chat/transcript/Transcript";
import type { SessionController } from "../../state/session";
import { useApp } from "../../state/app";
import { useVisualSnapshot } from "../../state/visualSnapshot";
import { Markdown } from "../../transcript/Markdown";
import { Button, IconButton, Spinner, StatusDot } from "../../ui";
import type { Helper } from "./derive";
import { closeHelper } from "./helperFocus";
import { helperConversation } from "./helperConversation";
import { helperTranscript, type HelperTranscriptItem } from "./helperTranscript";
import { useDeferredTranslation } from "../../i18n";
import { HelperIdentity } from "./HelperIdentity";

function HelperPrompt({ items }: { items: readonly HelperTranscriptItem[] }): ReactNode {
	const { t } = useTranslation("panes");
	return <div className="space-y-3">{items.map(item => {
		switch (item.kind) {
			case "assignment":
			case "prompt": return <div key={item.id} className="rounded-lg border border-border bg-inset px-4 py-3">
				<p className="mb-1 text-sm font-medium text-fg-muted">{t(item.kind === "assignment" ? "tasks.assignment" : "tasks.transcriptMessage")}</p>
				<div className="selectable whitespace-pre-wrap text-base text-fg">{item.text}</div>
			</div>;
			case "message": return <div key={item.id} className="rounded-lg border border-border bg-panel px-card py-3">
				<p className="flex items-center gap-2 text-sm text-fg-muted"><ChatCircleText aria-hidden className="size-4" />{item.from ? t("tasks.transcriptMessageFrom", { name: item.from }) : t("tasks.transcriptMessage")}{item.interrupted && <span>{t("tasks.transcriptInterrupted")}</span>}</p>
				<div className="selectable mt-2"><Markdown text={item.text} /></div>
			</div>;
			case "notice": return <p key={item.id} role="note" className="flex items-start gap-2 text-sm text-fg-muted"><Info className="mt-0.5 size-4 shrink-0" aria-hidden />{item.text}</p>;
		}
	})}</div>;
}

/** Loaded on helper focus. The normal transcript and draft remain mounted underneath this column. */
export function HelperFocusView({ session, helper }: { session: SessionController; helper: Helper }): ReactNode {
	const { t } = useDeferredTranslation("helperFocus");
	const conversation = useMemo(() => helperConversation(session, helper), [session, helper.id]);
	const state = useVisualSnapshot(conversation.subscribe, conversation.getSnapshot);
	const mode = useApp(app => app.prefs?.transcriptMode ?? "normal");
	const root = useRef<HTMLDivElement>(null);
	const back = useRef<HTMLButtonElement>(null);
	useEffect(() => { back.current?.focus(); }, [conversation]);
	const entries = state.history?.entries ?? [];
	const prompts = useMemo(() => {
		const users = new Map<string, readonly HelperTranscriptItem[]>();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			users.set(entry.id, []);
		}
		for (const item of helperTranscript(entries)) {
			const id = item.kind === "assignment" ? item.id : item.id.slice(0, item.id.lastIndexOf(":"));
			users.set(id, [...users.get(id) ?? [], item]);
		}
		return users;
	}, [entries]);
	const scope = useMemo(() => ({ tabId: session.tabId, projectPath: state.history?.header?.cwd ?? session.projectPath }), [session, state.history?.header?.cwd]);
	const send = (event: FormEvent) => { event.preventDefault(); conversation.enqueue(); };
	return <div ref={root} data-helper-focus className="absolute inset-0 z-10 flex min-h-0 flex-col bg-bg" onKeyDown={event => {
		if (event.key !== "Escape" || event.nativeEvent.isComposing || event.defaultPrevented) return;
		event.preventDefault(); event.stopPropagation(); closeHelper(session);
	}}>
		<div role="group" aria-label={`${state.helper.name}, ${t(`tasks.helperStatus.${state.helper.status}`)}`} className="flex min-h-12 shrink-0 items-center gap-3 border-b border-border px-6 py-2">
			<Button ref={back} size="sm" variant="ghost" icon={<ArrowLeft />} onClick={() => closeHelper(session)}>{t("tasks.focus.back")}</Button>
			<HelperIdentity helper={state.helper} />
			<div className="min-w-0 flex-1"><h2 className="truncate text-md font-medium text-fg">{t("tasks.transcriptTitle", { name: state.helper.name })}</h2></div>
			<StatusDot glyph status={state.helper.status === "running" ? "agent" : state.helper.status === "failed" ? "err" : state.helper.status === "done" ? "ok" : "idle"} label={t(`tasks.helperStatus.${state.helper.status}`)} />
			<span className="text-sm text-fg-muted">{t(`tasks.helperStatus.${state.helper.status}`)}</span>
		</div>
		{state.error && <div role="alert" className="mx-6 mt-3 flex items-center gap-3 rounded-md bg-warn-bg px-3 py-2 text-sm text-warn"><p className="min-w-0 flex-1 break-words">{state.error}</p>{!state.stale && <Button size="sm" onClick={() => conversation.reload()}>{t("tasks.focus.retry")}</Button>}</div>}
		{!state.history && !state.error ? <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-fg-muted"><Spinner />{t("tasks.transcriptLoading")}</div> : <TranscriptBody
			key={state.file} scope={scope} entries={entries} mode={mode} ready={state.history !== null}
			sessionFile={state.file}
			outputIdentity={`${session.getSnapshot().host?.hostId ?? ""}:${session.getSnapshot().host?.generation ?? ""}:${state.file ?? helper.id}`}
			identity={state.file ?? helper.id} working={state.helper.status === "running"}
			emptyState={<p className="text-sm text-fg-muted">{t("tasks.transcriptEmpty")}</p>}
			renderUser={(entry: SessionEntry) => <HelperPrompt items={prompts.get(entry.id) ?? []} />}
		/>}
		<div className="mx-auto w-full max-w-[calc(var(--chat-max)+48px)] shrink-0 px-6 pb-4 pt-2">
			{state.queue.length > 0 && <ul aria-label={t("tasks.focus.queueLabel")} className="mb-2 max-h-44 space-y-2 overflow-y-auto">{state.queue.map(item => <li key={item.id} className="rounded-md border border-border bg-panel px-3 py-2">
				<div className="flex items-start gap-2"><p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-fg">{item.text}</p>{item.state !== "sending" && <IconButton size="sm" icon={<X />} label={t("tasks.focus.cancel")} onClick={() => conversation.cancel(item.id)} />}</div>
				<p role="status" className="mt-1 text-xs text-fg-muted">{item.error ?? t(item.state === "sending" ? "tasks.focus.sending" : item.state === "preparing" ? "tasks.focus.preparing" : "tasks.focus.queued")}</p>
				{item.state === "error" && !state.stale && <Button size="sm" variant="ghost" onClick={() => conversation.retry(item.id)}>{t("tasks.focus.retryMessage")}</Button>}
			</li>)}</ul>}
			<form onSubmit={send} className="rounded-lg border border-control-border bg-panel p-3 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
				<label htmlFor={`helper-message-${session.tabId}`} className="sr-only">{t("tasks.messageTitle", { name: state.helper.name })}</label>
				<textarea id={`helper-message-${session.tabId}`} rows={3} value={state.draft} onChange={event => conversation.setDraft(event.target.value)}
					disabled={!state.helper.messageable} placeholder={t(state.helper.messageable ? "tasks.focus.placeholder" : "tasks.focus.unavailable")}
					onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) send(event); }}
					className="block max-h-40 w-full resize-y bg-transparent text-base text-fg outline-none placeholder:text-fg-faint disabled:opacity-60" />
				<div className="mt-2 flex items-center gap-3"><p className="min-w-0 flex-1 text-xs text-fg-muted">{t("tasks.focus.hint")}</p><Button type="submit" size="sm" variant="primary" icon={<PaperPlaneTilt />} disabled={!state.draft.trim() || !state.helper.messageable}>{t(state.helper.status === "running" ? "tasks.focus.queue" : "tasks.send")}</Button></div>
			</form>
		</div>
	</div>;
}
