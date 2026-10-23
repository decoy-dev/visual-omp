/**
 * Preview pane (DESIGN §3.7): a small browser for the project's dev server. Only local
 * (`http://localhost:*`, `127.0.0.1`) and `https:` pages load, matching the app's frame CSP.
 * Dev-server addresses printed by omp's commands are offered as one-click suggestions.
 */
import { ArrowClockwise, ArrowLeft, ArrowRight, ArrowSquareOut, Globe, MonitorPlay } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PaneProps } from "../../registry/slots";
import { useSessionView } from "../../shell/hooks";
import { liveEntries } from "../../state/session";
import { OVERVIEW_DOCK } from "../../state/dockLayout";
import { Button, cn, EmptyState, Expand, IconButton } from "../../ui";
import { PaneToolbar } from "./common";
import { devServerUrls } from "./derive";
import { normalizePreviewUrl } from "./preview-url";
import { NO_HISTORY, usePreview } from "./preview-store";
import { TargetContextMenu } from "../../ui/TargetContextMenu";


export function PreviewPane({ session, projectPath }: PaneProps) {
	const { t } = useTranslation("panes");
	const view = useSessionView(session);
	const scope = session?.tabId ?? OVERVIEW_DOCK;
	const history = usePreview(state => state.byScope[scope] ?? NO_HISTORY);
	const current = history.entries[history.index] ?? null;
	const [address, setAddress] = useState(current ?? "");
	const [invalid, setInvalid] = useState(false);

	const entries = liveEntries(view) ?? view?.history?.entries;
	const activeTools = view?.guest?.activeTools;
	const detected = useMemo(() => (entries ? devServerUrls(entries, activeTools) : []), [entries, activeTools]);

	useEffect(() => {
		setAddress(current ?? "");
		setInvalid(false);
	}, [current]);

	const navigate = (target: string) => {
		const url = normalizePreviewUrl(target);
		if (!url) {
			setInvalid(true);
			return;
		}
		setInvalid(false);
		usePreview.getState().go(scope, url);
	};
	const submit = (event: FormEvent) => {
		event.preventDefault();
		navigate(address);
	};

	const suggestions = detected.filter(url => url !== current).slice(0, 4);
	return (
		<TargetContextMenu projectPath={projectPath} tabId={session?.tabId ?? null}>
		<div className="flex min-h-0 flex-1 flex-col">
			<PaneToolbar>
				<IconButton
					size="sm"
					label={t("preview.back")}
					icon={<ArrowLeft />}
					disabled={history.index <= 0}
					onClick={() => usePreview.getState().step(scope, -1)}
				/>
				<IconButton
					size="sm"
					label={t("preview.forward")}
					icon={<ArrowRight />}
					disabled={history.index >= history.entries.length - 1}
					onClick={() => usePreview.getState().step(scope, 1)}
				/>
				<IconButton
					size="sm"
					label={t("preview.reload")}
					icon={<ArrowClockwise />}
					disabled={!current}
					onClick={() => usePreview.getState().reload(scope)}
				/>
				<form onSubmit={submit} className="min-w-0 flex-1">
					<input
						value={address}
						onChange={event => {
							setAddress(event.target.value);
							setInvalid(false);
						}}
						aria-label={t("preview.address")}
						aria-invalid={invalid || undefined}
						placeholder={t("preview.placeholder")}
						spellCheck={false}
						className={cn(
							"h-7 w-full rounded-md border bg-inset px-2 font-mono text-xs text-fg outline-none placeholder:text-fg-faint",
							"focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-ring-soft",
							invalid ? "border-err" : "border-border",
						)}
					/>
				</form>
				<IconButton
					size="sm"
					label={t("preview.openExternal")}
					icon={<ArrowSquareOut />}
					disabled={!current}
					onClick={() => current && void window.vomp.invoke("app:openExternal", current)}
				/>
			</PaneToolbar>
			<Expand open={invalid} className="border-b border-border bg-err-bg px-3 py-1.5">
				<p role="alert" className="text-xs text-err">
					{t("preview.invalid")}
				</p>
			</Expand>
			<Expand open={suggestions.length > 0} className="flex flex-wrap items-center gap-1.5 border-b border-border bg-panel px-3 py-1.5">
				<span className="text-xs text-fg-muted">{t("preview.detected")}</span>
				{suggestions.map(url => (
					<Button key={url} data-context-url={url} size="sm" variant="secondary" icon={<Globe />} className="h-6 font-mono text-xs" onClick={() => navigate(url)}>
						{url.replace(/^https?:\/\//, "")}
					</Button>
				))}
			</Expand>
			{current ? (
				<iframe
					key={`${current}#${history.nonce}`}
					src={current}
					title={t("preview.frameTitle", { url: current })}
					className="min-h-0 w-full flex-1 border-0 bg-panel"
					sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
				/>
			) : (
				<EmptyState
					icon={<MonitorPlay />}
					title={t("preview.emptyTitle")}
					body={t("preview.empty")}
					actions={
						detected[0] ? (
							<Button data-context-url={detected[0]} size="sm" variant="primary" icon={<Globe />} onClick={() => navigate(detected[0])}>
								{t("preview.openDetected", { url: detected[0].replace(/^https?:\/\//, "") })}
							</Button>
						) : undefined
					}
				/>
			)}
		</div>
		</TargetContextMenu>
	);
}
