import { Brain, Clock, Hourglass, UsersThree } from "@phosphor-icons/react";
import type { OPTIONAL_STATUS_ITEMS } from "@shared/statusBar";
import { type ReactNode, useMemo } from "react";
import { useDeferredTranslation } from "../../i18n";
import { useDisplayedEntries } from "../../chat/branch";
import { composerModel } from "../../collab/lib/modelFallback";
import { runningHelpers } from "../../features/panes/derive";
import { useChatModels } from "../../features/session-tools/model";
import { useThinking } from "../../features/session-tools/pickers";
import type { PaneProps } from "../../registry/slots";
import { elapsed, useNow, useSessionView } from "../hooks";
import type { SessionController } from "../../state/session";
import { Tooltip } from "../../ui";

function StatusText({ label, children }: { label: string; children: ReactNode }) {
	return <Tooltip content={label}><span tabIndex={0} aria-label={label} className="flex h-6 min-w-0 items-center gap-1.5 rounded-sm px-1.5 tabular-nums">{children}</span></Tooltip>;
}

export function ContextStatusItem({ session }: PaneProps) {
	const { t } = useDeferredTranslation("settings");
	const view = useSessionView(session);
	const percent = view?.guest?.state?.contextUsage?.percent;
	if (percent === null || percent === undefined || !Number.isFinite(percent)) return null;
	const label = t("status.context", { percent: Math.round(percent) });
	return <StatusText label={label}>{label}</StatusText>;
}

function ModelStatus({ session }: { session: SessionController }) {
	const { t } = useDeferredTranslation("settings");
	const view = useSessionView(session)!;
	const entries = useDisplayedEntries(view);
	const live = view.guest?.state?.model;
	const stream = view.guest?.stream ?? null;
	const { model } = useMemo(() => composerModel(entries, live, stream), [entries, live, stream]);
	const { models } = useChatModels(session.projectPath);
	if (!model) return null;
	const name = models?.find(entry => entry.provider === model.provider && entry.id === model.id)?.name ?? model.name;
	return <StatusText label={t("status.model", { name })}><span className="max-w-[18ch] truncate">{name}</span></StatusText>;
}
export function ModelStatusItem({ session }: PaneProps) { return session ? <ModelStatus session={session} /> : null; }

function ThinkingStatus({ session }: { session: SessionController }) {
	const { t } = useDeferredTranslation("settings");
	const level = useThinking(session);
	if (!level) return null;
	const label = t("session:thinking.levels." + level + ".label");
	return <StatusText label={t("status.thinking", { level: label })}><Brain aria-hidden className="size-3.5 shrink-0" />{label}</StatusText>;
}
export function ThinkingStatusItem({ session }: PaneProps) { return session ? <ThinkingStatus session={session} /> : null; }

export function QueueStatusItem({ session }: PaneProps) {
	const { t } = useDeferredTranslation("settings");
	const view = useSessionView(session);
	if (!view) return null;
	const label = t("status.queue", { count: view.queue.length });
	return <StatusText label={label}><Hourglass aria-hidden className="size-3.5 shrink-0" />{label}</StatusText>;
}

function WorkingTime({ since }: { since: number | null }) {
	const { t } = useDeferredTranslation("settings");
	const now = useNow(1000);
	const label = since === null ? t("status.workingUntimed") : t("status.working", { elapsed: elapsed(now - since) });
	return <StatusText label={label}><Clock aria-hidden className="size-3.5 shrink-0" />{label}</StatusText>;
}
export function WorkingStatusItem({ session }: PaneProps) {
	const view = useSessionView(session);
	return view?.working ? <WorkingTime since={view.workingSince} /> : null;
}

export function HelpersStatusItem({ session }: PaneProps) {
	const { t } = useDeferredTranslation("settings");
	const view = useSessionView(session);
	if (!view) return null;
	const label = t("status.helpers", { count: runningHelpers(view) });
	return <StatusText label={label}><UsersThree aria-hidden className="size-3.5 shrink-0" />{label}</StatusText>;
}

const COMPONENTS = {
	"chat.context": ContextStatusItem,
	"chat.model": ModelStatusItem,
	"chat.thinking": ThinkingStatusItem,
	"chat.queue": QueueStatusItem,
	"chat.time": WorkingStatusItem,
	"chat.helpers": HelpersStatusItem,
};

/** One lazy boundary serves every optional focused-chat item. */
export function ChatStatusItem({ kind, ...props }: PaneProps & { kind: (typeof OPTIONAL_STATUS_ITEMS)[number] }) {
	const Item = COMPONENTS[kind];
	return <Item {...props} />;
}
