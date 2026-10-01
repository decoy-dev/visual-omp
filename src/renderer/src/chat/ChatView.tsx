import { type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { chatSlots } from "../registry/slots";
import { elapsed, useNow, useSessionView } from "../shell/hooks";
import { useApp } from "../state/app";
import type { SessionController, SessionView } from "../state/session";
import { Button, cn, Expand, StatusDot, WorkingIndicator } from "../ui";
import { Composer } from "./composer/Composer";
import { friendlySummary, resolveToolCall } from "./friendly";
import { SessionHeader } from "./SessionHeader";
import { Transcript } from "./transcript/Transcript";

function Banner({ tone, role = "status", children }: { tone: "info" | "warn" | "err"; role?: "status" | "alert"; children: ReactNode }): ReactNode {
	return (
		<div
			role={role}
			className={cn(
				"mx-auto mt-3 flex w-full max-w-(--chat-max) items-center gap-3 rounded-md px-4 py-2 text-md",
				tone === "err" ? "bg-err-bg text-err" : tone === "warn" ? "bg-warn-bg text-warn" : "bg-info-bg text-info",
			)}
		>
			{children}
		</div>
	);
}

/**
 * A read-only chat follows another omp window's file. Shows whether that still works, whether
 * ownership could be checked, and offers "Continue here" only once main reported the file free.
 */
function FollowRow({ session, follow }: { session: SessionController; follow: SessionView["follow"] }): ReactNode {
	const { t } = useTranslation("chat");
	const [checking, setChecking] = useState(false);
	const [refused, setRefused] = useState(false);
	if (follow && !follow.readable) {
		return (
			<Banner tone="warn" role="alert">
				{t("follow.unreadable", { error: follow.error ?? t("follow.unknownError") })}
			</Banner>
		);
	}
	if (follow?.ownership === "free") {
		const continueHere = async () => {
			setChecking(true);
			setRefused(false);
			const started = await session.continueHere().catch(() => false);
			setChecking(false);
			setRefused(!started);
		};
		return (
			<Banner tone="info">
				<span className="flex-1">
					{t("follow.free")}
					{refused && <span className="ml-2 text-fg-muted">{t("follow.refused")}</span>}
				</span>
				<Button size="sm" disabled={checking} onClick={() => void continueHere()}>
					{t("follow.continue")}
				</Button>
			</Banner>
		);
	}
	return (
		<div role="status" className="mx-auto mt-3 flex w-full max-w-(--chat-max) items-center gap-2.5 px-6 text-sm text-fg-muted">
			<StatusDot status="live" label={t("followingLabel")} />
			{follow?.ownership === "unknown" ? t("follow.unknown") : t("readOnly")}
		</div>
	);
}

function StateBanner({ session, view }: { session: SessionController; view: SessionView }): ReactNode {
	const { t } = useTranslation("chat");
	if (view.readOnly) return <FollowRow session={session} follow={view.follow} />;
	if (view.mode === "exited") {
		const code = view.host?.exitCode;
		return (
			<Banner tone="err">
				<span className="flex-1">
					{t("exited", { code: code !== null && code !== undefined && code !== 0 ? t("exitedCode", { code }) : "" })}
					{view.error && <span className="selectable ml-2 text-fg-muted">{view.error}</span>}
				</span>
				<Button size="sm" onClick={() => void session.ensureLive()}>
					{t("restartOmp")}
				</Button>
			</Banner>
		);
	}
	if (view.mode === "reconnecting") return <Banner tone="warn">{t("reconnecting")}</Banner>;
	if (view.mode === "history") return <Banner tone="info">{t("historyNotice")}</Banner>;
	if (view.error) return <Banner tone="err">{view.error}</Banner>;
	return null;
}

/** Windows has no way to see a terminal omp on this chat's file; a quiet reminder until dismissed. */
function OwnerNotice({ session, view }: { session: SessionController; view: SessionView }): ReactNode {
	const { t } = useTranslation("chat");
	if (!view.ownerUnverified) return null;
	return (
		<div role="note" className="mx-auto mt-2 flex w-full max-w-(--chat-max) items-center gap-3 px-6 text-sm text-fg-muted">
			<span className="flex-1">{t("ownerUnverified.text")}</span>
			<Button size="sm" variant="ghost" onClick={() => session.dismissOwnerNotice()}>
				{t("ownerUnverified.dismiss")}
			</Button>
		</div>
	);
}

/**
 * "Working… 14s · Running tests" pinned above the composer while omp works (DESIGN §4.6). Status only:
 * stopping is the composer's action slot. Mounted only while working.
 */
function WorkingRow({ view }: { view: SessionView }): ReactNode {
	const { t } = useTranslation(["chat", "tools"]);
	const since = useRef(Date.now());
	const now = useNow(1000);
	const tool = view.guest ? [...view.guest.activeTools.values()].at(-1) : undefined;
	const summary = tool ? friendlySummary(resolveToolCall({ name: tool.toolName, args: tool.args, running: true, intent: tool.intent })) : null;
	const activity = summary ? t(`tools:${summary.key}`, summary.values) : view.guest?.stream ? null : t("chat:thinking");
	const time = elapsed(now - since.current);
	return (
		<div className="mx-auto flex h-9 w-full max-w-(--chat-max) items-center px-6 pb-2">
			<WorkingIndicator label={activity ? t("chat:workingActivity", { elapsed: time, activity }) : t("chat:working", { elapsed: time })} />
		</div>
	);
}

export function ChatView({ session, title, focused }: { session: SessionController; title: string | null; focused: boolean }): ReactNode {
	const view = useSessionView(session);
	const mode = useApp(state => state.prefs?.transcriptMode ?? "normal");
	const slots = chatSlots.use();
	if (!view) return null;
	return (
		<section
			className={cn("relative flex min-w-0 flex-1 flex-col bg-bg", !focused && "opacity-[0.97]")}
			aria-label={title ?? undefined}
			onFocusCapture={() => {
				const state = useApp.getState();
				if (state.splitTabId === session.tabId) state.focusSplit("secondary");
				else if (state.activeTabId === session.tabId) state.focusSplit("primary");
			}}
		>
			<SessionHeader session={session} view={view} fallbackTitle={title} />
			<div data-chat-column className="relative flex min-h-0 flex-1 flex-col">
				<StateBanner session={session} view={view} />
				<OwnerNotice session={session} view={view} />
				<Transcript session={session} view={view} mode={mode} />
				{slots
					.filter(slot => slot.placement === "aboveComposer")
					.map(slot => (
						<slot.component key={slot.id} session={session} />
					))}
				<Expand open={view.working}>
					<WorkingRow view={view} />
				</Expand>
				<div data-tour="composer" className="mx-auto w-full max-w-[calc(var(--chat-max)+48px)] px-6 pb-4">
					<Composer session={session} />
				</div>
			</div>
			{slots
				.filter(slot => slot.placement === "watchers")
				.map(slot => (
					<slot.component key={slot.id} session={session} />
				))}
		</section>
	);
}
