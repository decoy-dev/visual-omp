/**
 * What omp printed for a typed slash command (DESIGN §3.5 "Command results"): a tool-style row with the
 * command and a bounded output well. Plain output keeps its lines; omp Markdown reports reuse the
 * chat renderer and copy their raw source. Warnings and errors tone the row's icon. Rows are ephemeral.
 */
import { Copy, FolderOpen, TerminalWindow, Warning, X, XCircle } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CommandPanelOwnership } from "../../features/session-tools/command-panels";
import type { CommandResultRecord } from "../../features/session-tools/results";
import { Markdown } from "../../transcript/Markdown";
import { Button, cn, IconButton, toast } from "../../ui";
import { TranscriptTime } from "./TranscriptTime";

/** Longer output starts cut to this many lines. */
const COLLAPSED_LINES = 12;

const TONE_ICON = { info: TerminalWindow, warn: Warning, err: XCircle };
const TONE_CLASS = { info: "text-fg-faint", warn: "text-warn", err: "text-err" };

type ResultLocation = NonNullable<CommandResultRecord["locations"]>[number];

function CommandResultLocation({ location }: { location: ResultLocation }): ReactNode {
	const { t } = useTranslation("session");
	const [exists, setExists] = useState(false);
	useEffect(() => {
		let cancelled = false;
		if (location.kind === "path") {
			void window.vomp.invoke("fs:exists", location.value).then(
				value => { if (!cancelled) setExists(value); },
				() => { if (!cancelled) setExists(false); },
			);
		}
		return () => { cancelled = true; };
	}, [location.kind, location.value]);
	return (
		<li className="flex min-w-0 flex-col items-start gap-1">
			<code tabIndex={0} className="selectable w-full rounded-sm font-mono text-code whitespace-pre-wrap text-fg-muted outline-none [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
				{location.value}
			</code>
			<div className="flex flex-wrap gap-1">
				<Button size="sm" variant="ghost" icon={<Copy />} onClick={() => void navigator.clipboard.writeText(location.value).then(
					() => toast({ tone: "ok", message: t(location.kind === "url" ? "commandResult.urlCopied" : "commandResult.pathCopied") }),
					() => toast({ tone: "err", message: t("commandResult.copyFailed") }),
				)}>
					{t(location.kind === "url" ? "commandResult.copyUrl" : "commandResult.copyPath")}
				</Button>
				{location.kind === "path" && exists && (
					<Button size="sm" variant="ghost" icon={<FolderOpen />} onClick={() => void window.vomp.invoke("app:showItem", location.value).catch(
						() => toast({ tone: "err", message: t("commandResult.revealFailed") }),
					)}>
						{t("commandResult.showInFolder")}
					</Button>
				)}
			</div>
		</li>
	);
}

export function CommandResultRow({ result, onDismiss }: { result: CommandResultRecord; onDismiss: () => void }): ReactNode {
	const { t } = useTranslation("session");
	const [open, setOpen] = useState(false);
	const [overflows, setOverflows] = useState(false);
	const markdownBody = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		if (!result.markdown) { setOverflows(false); return; }
		const body = markdownBody.current;
		if (!body || open) return;
		const measure = () => setOverflows(body.scrollHeight > body.clientHeight + 1);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(body);
		if (body.firstElementChild) observer.observe(body.firstElementChild);
		return () => observer.disconnect();
	}, [result.markdown, result.lines, open]);
	const long = result.lines.length > COLLAPSED_LINES;
	const shown = open || !long ? result.lines : result.lines.slice(0, COLLAPSED_LINES);
	const ToneIcon = TONE_ICON[result.tone];
	const seenLocations = new Set<string>();
	const locations = (result.locations ?? []).filter(location => {
		const key = JSON.stringify([location.kind, location.value]);
		if (seenLocations.has(key)) return false;
		seenLocations.add(key);
		return true;
	});
	return (
		<section aria-label={t("commandResult.aria", { command: result.command })} className="group/result flex flex-col">
			<div className="-mx-2 flex h-8 w-[calc(100%+1rem)] items-center gap-2.5 rounded-md px-2">
				<ToneIcon className={cn("size-4 shrink-0", TONE_CLASS[result.tone])} aria-hidden />
				<span className="selectable min-w-0 flex-1 truncate font-mono text-sm text-fg-muted">{result.command}</span>
				<TranscriptTime timestamp={result.createdAt} />
				{result.markdown && <IconButton
					label={t("commandResult.copy")}
					icon={<Copy />}
					size="sm"
					onClick={() => void navigator.clipboard.writeText(result.lines.join("\n")).then(
						() => toast({ tone: "ok", message: t("commandResult.copied") }),
						() => toast({ tone: "err", message: t("commandResult.copyFailed") }),
					)}
				/>}
				<IconButton
					label={t("commandResult.dismiss")}
					icon={<X />}
					size="sm"
					className="opacity-0 transition-opacity duration-(--dur) group-hover/result:opacity-100 group-focus-within/result:opacity-100"
					onClick={onDismiss}
				/>
			</div>
			<div className="pb-1 pl-6.5">
				{result.title && <h3 className="selectable mb-2 text-sm font-medium text-fg [overflow-wrap:anywhere]">{result.title}</h3>}
				{result.markdown ? (
					<div ref={markdownBody} className={cn("selectable min-w-0 rounded-md bg-inset px-3 py-2 text-sm [overflow-wrap:anywhere]", !open && "max-h-96 overflow-auto")}>
						<Markdown text={result.lines.join("\n")} />
					</div>
				) : (
					<pre className="selectable max-h-96 overflow-auto rounded-md bg-inset px-3 py-2 font-mono text-code whitespace-pre text-fg-muted">
						{shown.join("\n")}
					</pre>
				)}
				{(long || overflows || open) && (
					<button
						type="button"
						aria-expanded={open}
						onClick={() => setOpen(value => !value)}
						className="mt-1 rounded-sm text-sm font-medium text-fg-muted outline-none transition-colors duration-(--dur-fast) hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
					>
						{result.markdown ? t(open ? "commandResult.lessReport" : "commandResult.moreReport")
							: open ? t("commandResult.less") : t("commandResult.more", { count: result.lines.length })}
					</button>
				)}
				{locations.length > 0 && (
					<ul aria-label={t("commandResult.locations")} className="mt-2 flex min-w-0 flex-col gap-2">
						{locations.map(location => (
							<CommandResultLocation key={JSON.stringify([result.id, location.kind, location.value])} location={location} />
						))}
					</ul>
				)}
				<CommandPanelOwnership result={result} onRelease={onDismiss} />
			</div>
		</section>
	);
}
