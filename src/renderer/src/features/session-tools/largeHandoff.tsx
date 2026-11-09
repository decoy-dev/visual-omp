import { WarningCircle } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { composerText, useComposerDrafts } from "../../chat/composer/drafts";
import { applyMode } from "../../chat/composer/send";
import { formatFileMention } from "../../chat/fileMentions";
import { i18n } from "../../i18n";
import type { ResumeMessage, ResumeRequest } from "../../registry/guards";
import type { ChatSlotProps } from "../../registry/slots";
import { chatTitle, elapsed, useNow } from "../../shell/hooks";
import { controllerFor, useApp } from "../../state/app";
import type { SessionController } from "../../state/session";
import { Button, Spinner } from "../../ui";

export interface LargeHandoff {
	tabId: string;
	sourceFile: string;
	projectPath: string;
	title: string;
	message: ResumeMessage;
	phase: "writing" | "stopping" | "sending" | "failed";
	started: number;
	error?: string;
}

export const useLargeHandoffs = create<{ pending: Record<string, LargeHandoff> }>(() => ({ pending: {} }));
interface Operation {
	id: string;
	cancelled: boolean;
	unsubscribe: () => void;
	release: (() => void) | null;
	controller: SessionController;
}
const operations = new Map<string, Operation>();

function update(entry: LargeHandoff): void {
	useLargeHandoffs.setState(state => ({ pending: { ...state.pending, [entry.tabId]: entry } }));
}

function remove(tabId: string): void {
	const operation = operations.get(tabId);
	operation?.unsubscribe();
	operation?.release?.();
	operations.delete(tabId);
	useComposerDrafts.getState().setSendBlocked(tabId, false);
	useLargeHandoffs.setState(state => {
		const { [tabId]: _old, ...pending } = state.pending;
		return { pending };
	});
}

/** A closed source does not own the replacement chat. Closing the replacement cancels its RPC work. */
export async function startLargeHandoff(request: ResumeRequest): Promise<void> {
	if (request.signal.aborted) return;
	const source = useApp.getState().tabs.find(tab => tab.id === request.tabId);
	const title = chatTitle(controllerFor(request.tabId)?.getSnapshot() ?? null, source?.title ?? null) ?? i18n.t("session:largeResume.untitled");
	const tabId = await useApp.getState().newChat(request.projectPath);
	if (!tabId) return;
	const controller = controllerFor(tabId);
	if (!controller || request.signal.aborted) return;
	const drafts = useComposerDrafts.getState();
	const message = request.message ?? { text: applyMode(composerText(drafts, request.tabId), drafts.modes[request.tabId] ?? null), images: [...(drafts.attachments[request.tabId] ?? [])] };
	const hold = Promise.withResolvers<void>();
	controller.holdQueue(hold.promise);
	const operation: Operation = { id: "", cancelled: false, unsubscribe: () => {}, release: hold.resolve, controller };
	operations.set(tabId, operation);
	operation.unsubscribe = useApp.subscribe(state => {
		if (state.tabs.some(tab => tab.id === tabId)) return;
		operation.cancelled = true;
		if (operation.id) void window.vomp.invoke("sessions:cancelHandoff", operation.id).catch(() => {});
		remove(tabId);
	});
	drafts.setDraft(tabId, message.text);
	drafts.addAttachments(tabId, [...message.images]);
	if (request.message) request.messageTransferred = true;
	else {
		drafts.setDraft(request.tabId, "");
		drafts.clearAttachments(request.tabId);
		drafts.setMode(request.tabId, null);
	}
	drafts.setSendBlocked(tabId, true);
	drafts.focus(tabId);
	const entry: LargeHandoff = { tabId, sourceFile: request.file, projectPath: request.projectPath, title, message, phase: "writing", started: Date.now() };
	update(entry);
	void writeHandoff(entry, operation);
}

function currentMessage(tabId: string): ResumeMessage {
	const drafts = useComposerDrafts.getState();
	return { text: applyMode(composerText(drafts, tabId), drafts.modes[tabId] ?? null), images: [...(drafts.attachments[tabId] ?? [])] };
}

function sameMessage(a: ResumeMessage, b: ResumeMessage): boolean {
	return a.text === b.text && a.images.length === b.images.length && a.images.every((image, index) => image.path === b.images[index]?.path);
}

async function writeHandoff(entry: LargeHandoff, operation: Operation): Promise<void> {
	const id = crypto.randomUUID();
	operation.id = id;
	operation.cancelled = false;
	if (!operation.release) {
		const hold = Promise.withResolvers<void>();
		operation.controller.holdQueue(hold.promise);
		operation.release = hold.resolve;
	}
	update({ ...entry, phase: "writing", started: Date.now(), error: undefined });
	const message = currentMessage(entry.tabId);
	const focus = message.text || message.images.length ? `Prepare for this next request:\n${message.text}${message.images.length ? `\nAttached images: ${message.images.map(image => image.path).join(", ")}` : ""}` : "";
	try {
		const result = await window.vomp.invoke("sessions:handoff", id, entry.sourceFile, entry.projectPath, focus);
		if (operations.get(entry.tabId) !== operation || operation.id !== id || operation.cancelled) return;
		if (!sameMessage(message, currentMessage(entry.tabId))) throw new Error(i18n.t("session:largeResume.messageChanged"));
		await sendPending(entry, operation, result.file);
	} catch (error) {
		if (operations.get(entry.tabId) !== operation || operation.id !== id || operation.cancelled) return;
		update({ ...entry, phase: "failed", error: error instanceof Error ? error.message : String(error) });
	}
}

async function sendPending(entry: LargeHandoff, operation: Operation, file?: string): Promise<void> {
	if (operations.get(entry.tabId) !== operation || controllerFor(entry.tabId) !== operation.controller) return;
	const message = currentMessage(entry.tabId);
	const mention = file ? formatFileMention(file, { isQuotedPrefix: true }) : "";
	if (file && !mention.startsWith("@")) throw new Error(i18n.t("session:largeResume.unquotablePath"));
	const text = [mention, message.text].filter(Boolean).join("\n\n");
	update({ ...entry, phase: "sending", error: undefined });
	operation.release?.();
	operation.release = null;
	// The receipt distinguishes host submission from queue ownership. Queued failures keep their
	// own explicit recovery and image safeguards, so the handoff must not retain a duplicate draft.
	await operation.controller.sendWithOwnership(text, message.images);
	if (operations.get(entry.tabId) !== operation) return;
	const drafts = useComposerDrafts.getState();
	if (sameMessage(message, currentMessage(entry.tabId))) {
		drafts.setDraft(entry.tabId, "");
		drafts.clearAttachments(entry.tabId);
		drafts.setMode(entry.tabId, null);
	}
	remove(entry.tabId);
}

export async function cancelLargeHandoff(tabId: string): Promise<void> {
	const operation = operations.get(tabId);
	const entry = useLargeHandoffs.getState().pending[tabId];
	if (!operation || !entry || entry.phase !== "writing" || operation.cancelled) return;
	operation.cancelled = true;
	const id = operation.id;
	try {
		await window.vomp.invoke("sessions:cancelHandoff", id);
		if (operations.get(tabId) === operation && operation.id === id) update({ ...entry, phase: "failed", error: i18n.t("session:largeResume.handoffCancelled") });
	} catch (error) {
		if (operations.get(tabId) === operation && operation.id === id) update({ ...entry, phase: "failed", error: error instanceof Error ? error.message : String(error) });
	}
}

export async function retryLargeHandoff(tabId: string): Promise<void> {
	const operation = operations.get(tabId);
	const entry = useLargeHandoffs.getState().pending[tabId];
	if (!operation || entry?.phase !== "failed") return;
	const id = operation.id;
	operation.cancelled = true;
	update({ ...entry, phase: "stopping", error: undefined });
	try {
		await window.vomp.invoke("sessions:cancelHandoff", id);
		if (operations.get(tabId) !== operation || operation.id !== id) return;
		await writeHandoff(entry, operation);
	} catch (error) {
		if (operations.get(tabId) === operation && operation.id === id) update({ ...entry, phase: "failed", error: error instanceof Error ? error.message : String(error) });
	}
}

export async function sendWithoutHandoff(tabId: string): Promise<void> {
	const operation = operations.get(tabId);
	const entry = useLargeHandoffs.getState().pending[tabId];
	if (!operation || entry?.phase !== "failed") return;
	try { await sendPending(entry, operation); }
	catch (error) {
		if (operations.get(tabId) === operation) update({ ...entry, phase: "failed", error: error instanceof Error ? error.message : String(error) });
	}
}

export function LargeHandoffRow({ session }: ChatSlotProps): ReactNode {
	const entry = useLargeHandoffs(state => state.pending[session.tabId]);
	const { t } = useTranslation("session");
	const now = useNow(1_000);
	if (!entry) return null;
	const failed = entry.phase === "failed";
	return <div className="mx-auto w-full max-w-(--chat-max) px-6 pb-3">
		<div className="flex flex-wrap items-center gap-2 text-md">
			{failed ? <WarningCircle className="size-4 shrink-0 text-warn" aria-hidden /> : <Spinner size={14} />}
			<span role="status" className="min-w-0 flex-1 break-words">{t(failed ? "largeResume.handoffFailed" : entry.phase === "stopping" ? "largeResume.stoppingHandoff" : entry.phase === "sending" ? "largeResume.sendingHandoff" : "largeResume.writingHandoff", { title: entry.title })}</span>
			{!failed && <span aria-hidden className="text-sm tabular-nums text-fg-muted">{elapsed(now - entry.started)}</span>}
			{entry.phase === "writing" && <Button size="sm" variant="ghost" onClick={() => void cancelLargeHandoff(entry.tabId)}>{t("common.cancel")}</Button>}
		</div>
		{failed && <>
			<p className="mt-2 whitespace-pre-wrap break-words text-sm text-fg-muted">{entry.error}</p>
			<div className="mt-2 flex flex-wrap gap-2">
				<Button size="sm" variant="secondary" onClick={() => void sendWithoutHandoff(entry.tabId)}>{t("largeResume.sendWithout")}</Button>
				<Button size="sm" variant="ghost" onClick={() => void retryLargeHandoff(entry.tabId)}>{t("largeResume.tryAgain")}</Button>
			</div>
		</>}
	</div>;
}
