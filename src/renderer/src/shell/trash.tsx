/**
 * Deleting a saved chat: the confirmation the sidebar's "Delete chat" and a typed `/delete` share. The
 * chat's tab closes first (its omp stops), then main moves the session file to the system trash.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { type SheetProps, sheets } from "../registry/slots";
import { controllerFor, useApp } from "../state/app";
import { Button, Dialog, DialogContent, toast } from "../ui";
import { SessionTitle } from "../ui/SessionTitle";
import { chatTitle, useSessionView } from "./hooks";

export interface TrashTarget {
	/** Absolute path of the session `.jsonl` file. */
	file: string;
	/** Project folder whose chat list reloads afterwards. */
	cwd: string;
	/** Open tab of the chat, closed before the file moves. */
	tabId: string | null;
}

async function trashChat({ file, cwd, tabId }: TrashTarget): Promise<void> {
	if (tabId) await useApp.getState().closeTab(tabId);
	try {
		await window.vomp.invoke("sessions:trash", file);
		await useApp.getState().loadSessions(cwd);
	} catch (error) {
		toast({ tone: "err", message: error instanceof Error ? error.message : String(error) });
	}
}

interface TrashChatDialogProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	title: string;
	target: TrashTarget | null;
}

export function TrashChatDialog({ open, onOpenChange, title, target }: TrashChatDialogProps): ReactNode {
	const { t } = useTranslation("shell");
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				size="sm"
				destructive
				title={t("deleteChat.title")}
				description={<><SessionTitle title={title} className="mb-2 text-fg" />{t("deleteChat.body")}</>}
				footer={
					<>
						<Button variant="secondary" onClick={() => onOpenChange(false)}>
							{t("deleteChat.cancel")}
						</Button>
						<Button
							variant="danger"
							onClick={() => {
								onOpenChange(false);
								if (target) void trashChat(target);
							}}
						>
							{t("deleteChat.confirm")}
						</Button>
					</>
				}
			/>
		</Dialog>
	);
}

/** `openSheet("chat-trash", { tabId })`: the confirmation for an open chat with a saved session file. */
function TrashChatSheet({ props, close }: SheetProps<{ tabId: string }>): ReactNode {
	const { t } = useTranslation("shell");
	const controller = controllerFor(props.tabId);
	const view = useSessionView(controller);
	const tabTitle = useApp(state => state.tabs.find(tab => tab.id === props.tabId)?.title ?? null);
	const file = controller?.sessionFile ?? null;
	if (!controller || !file) return null;
	return (
		<TrashChatDialog
			open
			onOpenChange={open => !open && close()}
			title={chatTitle(view, tabTitle) ?? t("chat.newTitle")}
			target={{ file, cwd: controller.projectPath, tabId: props.tabId }}
		/>
	);
}

sheets.register({ id: "chat-trash", component: TrashChatSheet });
