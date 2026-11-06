import { ArrowsOut, DotsThree, FolderOpen, Square, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadFailedNotice } from "../../registry/lazy";
import type { SessionController } from "../../state/session";
import { useApp } from "../../state/app";
import { Button, cn, IconButton, Menu, MenuContent, MenuItem, MenuTrigger, Progress } from "../../ui";
import { openInFiles } from "../panes/files-store";
import { FileName } from "../panes/common";
import { ExpandPreview, loadFileImage, PdfFrame, PreviewImage } from "../panes/media";
import { loadAdapter } from "./formats";
import { followedSubject, isOfficeSubject, useLivePreview, usePreviewChat, visibleSubjects } from "./store";
import { stopAndRedirect, usePreviewRedirect } from "./redirect";
import type { LiveAdapter, LiveFrameProps, LiveSubject, OfficeFrameSnapshot } from "./types";

export function subjectName(subject: LiveSubject): string {
	return subject.path?.split(/[\\/]/).at(-1) || subject.toolName || subject.format;
}

function officeCacheFor(tabId: string, subject: LiveSubject | undefined) {
	if (!subject) return undefined;
	const { id, path, format, revision } = subject;
	return {
		read: () => useLivePreview.getState().readOffice(tabId, id, path, format, revision),
		write: (snapshot: OfficeFrameSnapshot) => {
			if (snapshot.path === path && snapshot.format === format && snapshot.revision <= revision) useLivePreview.getState().retainOffice(tabId, id, snapshot);
		},
		clear: () => useLivePreview.getState().discardOffice(tabId, id, path, format),
	};
}
/** Coalesce revisions while an adapter loads and between its permitted frame updates. */
function Frame(props: LiveFrameProps) {
	const latest = useRef(props);
	latest.current = props;
	const [adapter, setAdapter] = useState<LiveAdapter | null>(null);
	const [shown, setShown] = useState(props);
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		if (adapter) return;
		setFailed(false);
		let current = true;
		void loadAdapter(props.subject.format).then(value => { if (current) setAdapter(value); }).catch(() => {
			if (!current) return;
			setFailed(true);
			if (isOfficeSubject(props.subject)) props.onOfficeCheck?.(null);
		});
		return () => { current = false; };
	}, [adapter, props.subject.format, props.subject.revision, attempt]);
	useEffect(() => {
		if (!adapter) return;
		const update = () => setShown(previous => {
			const next = latest.current;
			return next.subject.revision > previous.subject.revision || next.subject.state !== previous.subject.state || next.related !== previous.related || next.turnImages !== previous.turnImages ? next : previous;
		});
		update();
		const timer = setInterval(update, 1000 / adapter.maxFps);
		return () => clearInterval(timer);
	}, [adapter]);
	const { t } = useTranslation("panes");
	if (failed) return <LoadFailedNotice retry={() => setAttempt(value => value + 1)} className="m-3" />;
	return adapter ? <adapter.Frame {...shown} /> : <p role="status" className="p-3 text-sm text-fg-muted">{t("live.loading")}</p>;
}

function ExpandedFrame({ subject, projectPath, related, turnImages, officeCache, open, onOpenChange }: LiveFrameProps & { open: boolean; onOpenChange(open: boolean): void }) {
	const name = subjectName(subject);
	return <ExpandPreview name={name} path={subject.path} image={["svg", "image", "result-images", "sequence"].includes(subject.format)} open={open} onOpenChange={onOpenChange} hideTrigger
		render={zoom => subject.format === "pdf" && subject.path
			? <PdfFrame path={subject.path} revision={subject.revision} name={name} />
			: subject.format === "image" && subject.path
				? <PreviewImage sourceKey={`${subject.id}:${subject.revision}`} load={() => loadFileImage(subject.path!)} pdf={false} enabled alt={name} explain zoom={zoom} />
				: <Frame subject={subject} projectPath={projectPath} related={related} turnImages={turnImages} officeCache={officeCache} />} />;
}

export function Stage({ session, onShowOutput }: { session: SessionController; onShowOutput(path: string): void }) {
	const { t } = useTranslation("panes");
	const enabled = useApp(state => state.prefs?.livePreview === true);
	const chat = usePreviewChat(session.tabId);
	const redirect = usePreviewRedirect(state => state[session.tabId]);
	const subjects = visibleSubjects(chat);
	const subject = followedSubject(chat);
	const candidate = chat.selected === null ? subjects.find(item => chat.officeChecks[item.id]?.safe !== false && chat.officeChecks[item.id]?.safe !== null) : undefined;
	const pending = candidate && candidate.id !== subject?.id && isOfficeSubject(candidate) && chat.officeChecks[candidate.id] === undefined ? candidate : undefined;
	const [expanded, setExpanded] = useState(false);
	// Stop and redirect from the overflow menu focuses the composer, so the closing menu must not take focus back.
	const redirecting = useRef(false);
	const officeCache = useMemo(() => officeCacheFor(session.tabId, subject), [session.tabId, subject?.id, subject?.path, subject?.format, subject?.revision]);
	const pendingOfficeCache = useMemo(() => officeCacheFor(session.tabId, pending), [session.tabId, pending?.id, pending?.path, pending?.format, pending?.revision]);
	if (!enabled || !subject) return null;
	const name = subjectName(subject);
	const turnImages = subjects.filter(item => item.path && (item.format === "image" || item.format === "svg")).map(item => item.path!);
	const running = subject.state === "writing" || subject.state === "running";
	const stopping = redirect === "stopping";
	const canExpand = ["svg", "image", "pdf", "result-images", "sequence", "docx", "xlsx", "pptx"].includes(subject.format) && subject.kind !== "render";
	const openFile = () => { if (subject.path) openInFiles(session.projectPath, subject.path, { tabId: session.tabId }); };
	const redirectAction = () => stopAndRedirect(session, name, value => t("live.about", { name: value }));
	const progress = subject.progress;
	const progressLabel = progress ? t(progress.total === null ? "live.progressUnknown" : "live.progressKnown", {
		unit: t(`live.progressUnit.${progress.unit}`), done: Math.round(progress.done * 10) / 10, total: progress.total,
	}) : null;
	const rendering = running && (subject.kind === "render" || progress !== null);
	const status = stopping ? t("live.stopping") : redirect === "failed" ? t("live.stopFailed")
		: rendering ? t("live.rendering") : t(`live.state.${subject.state}`);
	return <section aria-label={t("live.title")} className={cn("@container/live shrink-0 border-b border-border px-3 py-3", subject.format === "xlsx" && "flex h-full min-h-64 flex-col")}>
		<div className="mb-2 flex items-center gap-2">
			<h3 className="min-w-0 flex-1 text-sm font-semibold text-fg">{t("live.title")}</h3>
			<IconButton size="sm" label={t("live.close")} icon={<X />} onClick={() => useLivePreview.getState().close(session.tabId)} />
		</div>
		<div role="group" aria-label={t("live.choose")} className="mb-2 flex gap-1 overflow-x-auto pb-1">
			{subjects.map(item => <button key={item.id} type="button" aria-pressed={item.id === subject.id} title={item.path ?? subjectName(item)}
				onClick={() => useLivePreview.getState().select(session.tabId, item.id)}
				className={cn("max-w-40 shrink-0 rounded-md px-2 py-1 text-xs outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring", item.id === subject.id ? "bg-selected text-fg" : "text-fg-muted")}>
				<FileName name={subjectName(item)} />
			</button>)}
		</div>
		<div className={cn("flex min-h-40 flex-col rounded-md bg-inset", subject.format === "docx" ? "overflow-hidden" : subject.format === "xlsx" ? "min-h-0 flex-1 overflow-hidden" : "h-64 overflow-auto")} data-live-subject={subject.id}>
			{[subject, ...(pending ? [pending] : [])].map(item => <div key={`${item.id}:${item.format}`} hidden={item.id !== subject.id}
				className={cn("min-h-0 flex-1 flex-col", item.format === "xlsx" ? "overflow-hidden" : "overflow-auto")} style={{ display: item.id === subject.id ? "flex" : "none" }}>
				{item.kind === "render" && !(item.format === "video" && item.path) ? <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-fg-muted">{item.intent ?? (running ? t("live.rendering") : status)}</div>
					: <Frame subject={item} projectPath={session.projectPath} related={chat.related} turnImages={turnImages}
						officeCache={item.id === subject.id ? officeCache : pendingOfficeCache}
						onOfficeCheck={safe => useLivePreview.getState().checkOffice(session.tabId, item, safe)} />}
			</div>)}
		</div>
		{rendering && <Progress className="mt-2" aria-label={status} value={progress && progress.total !== null ? progress.percent ?? undefined : undefined} />}
		<p className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-xs text-fg-muted">
			<span role="status" className="font-medium">{status}</span>
			{rendering && !stopping && redirect !== "failed" && progressLabel && <span> · {progressLabel}</span>}
			<span className="min-w-0 break-words">{subject.intent ?? name}</span>
			{subject.size !== null && <span className="tabular-nums">{t("live.size", { size: Math.ceil(subject.size / 1024) })}</span>}
			<span>{t(`live.format.${subject.format}`)}</span>
			{subject.sequence && <span className="tabular-nums">{t("live.sequenceCount", { count: subject.sequence.count })}</span>}
		</p>
		<div className="mt-2 flex flex-wrap items-center gap-1">
			{(running || redirect === "failed") && <Button size="sm" variant="secondary" icon={<Square />} disabled={stopping} onClick={() => session.abort()}>{stopping ? t("live.stopping") : t("live.stop")}</Button>}
			<span className="hidden @min-[28rem]/live:contents">
				{running && <Button size="sm" variant="ghost" disabled={stopping} onClick={redirectAction}>{t("live.redirect")}</Button>}
				{subject.path && <IconButton size="sm" label={t("live.openFiles")} icon={<FolderOpen />} onClick={openFile} />}
			</span>
			{canExpand && <><span className="hidden @min-[28rem]/live:contents"><IconButton size="sm" label={t("files.expand")} icon={<ArrowsOut />} onClick={() => setExpanded(true)} /></span><ExpandedFrame key={subject.id} subject={subject} projectPath={session.projectPath} related={chat.related} turnImages={turnImages} officeCache={officeCache} open={expanded} onOpenChange={setExpanded} /></>}
			<span className="contents @min-[28rem]/live:hidden">
				<Menu><MenuTrigger asChild><IconButton size="sm" label={t("live.actions")} icon={<DotsThree />} /></MenuTrigger>
					<MenuContent align="end" onCloseAutoFocus={event => { if (!redirecting.current) return; redirecting.current = false; event.preventDefault(); }}>
						{running && <MenuItem disabled={stopping} onSelect={() => { redirecting.current = true; redirectAction(); }}>{t("live.redirect")}</MenuItem>}
						{subject.path && <MenuItem icon={<FolderOpen />} onSelect={openFile}>{t("live.openFiles")}</MenuItem>}
						{canExpand && <MenuItem icon={<ArrowsOut />} onSelect={() => setExpanded(true)}>{t("files.expand")}</MenuItem>}
					</MenuContent>
				</Menu>
			</span>
			{subject.state === "saved" && subject.path && <Button size="sm" variant="ghost" onClick={() => onShowOutput(subject.path!)}>{t("live.showOutput")}</Button>}
		</div>
	</section>;
}
