/**
 * Update surfaces (DESIGN §4.22): a toast when a new visual-omp release is published, and the
 * omp engine update (`omp update`) with its output streamed into a dialog.
 */
import { CircleAlert, CircleCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import type { AppUpdateStatus, OmpUpdateRun, OmpUpdateStatus } from "@shared/contracts/updates";
import { i18n } from "../../i18n";
import type { SheetProps } from "../../registry/slots";
import { useApp } from "../../state/app";
import { Button, Dialog, DialogContent, toast, WorkingIndicator } from "../../ui";

export const OMP_UPDATE_SHEET = "onboarding.ompUpdate";

/** First engine check after launch; omp's own check is cached for 6 hours in main. */
const OMP_CHECK_DELAY_MS = 20_000;

const useOmpUpdate = create<{ status: OmpUpdateStatus | null }>(() => ({ status: null }));

/**
 * Latest `omp update --check` result, for the status bar omp chip (`--info` dot + "Update omp to X"
 * menu item that runs the `app.updateOmp` command). Null until the first check finishes.
 */
export function useOmpUpdateStatus(): OmpUpdateStatus | null {
	return useOmpUpdate(state => state.status);
}

async function checkOmpUpdate(force = false): Promise<void> {
	useOmpUpdate.setState({ status: await window.vomp.invoke("updates:omp:check", force) });
}

function showAppUpdate(status: AppUpdateStatus): void {
	const t = i18n.getFixedT(null, "onboarding");
	const { hint, latestVersion } = status;
	if (!hint || !latestVersion) return;
	const message = t("update.appTitle", { version: latestVersion });
	const open = (url: string) => void window.vomp.invoke("app:openExternal", url);
	switch (hint.kind) {
		case "command":
			toast({
				tone: "info",
				sticky: true,
				message,
				description: t("update.brewBody", { command: hint.command }),
				action: {
					label: t("update.copyCommand"),
					onClick: () => {
						void navigator.clipboard.writeText(hint.command);
						toast({ tone: "ok", message: t("update.copied"), description: t("update.copiedBody") });
					},
				},
			});
			return;
		case "download":
			toast({ tone: "info", sticky: true, message, description: t("update.downloadBody"), action: { label: t("update.download"), onClick: () => open(hint.url) } });
			return;
		case "page":
			toast({ tone: "info", sticky: true, message, description: t("update.pageBody"), action: { label: t("update.openPage"), onClick: () => open(hint.url) } });
	}
}

/** Listens for release checks (main runs them in the background) and schedules the engine check. */
export function installUpdateWatchers(): void {
	const announced = new Set<string>();
	window.vomp.on("updates:app", status => {
		if (!status.updateAvailable || !status.latestVersion || announced.has(status.latestVersion)) return;
		announced.add(status.latestVersion);
		showAppUpdate(status);
	});
	window.vomp.on("updates:omp:finished", () => void checkOmpUpdate());
	setTimeout(() => void checkOmpUpdate(), OMP_CHECK_DELAY_MS);
}

/** Runs `omp update` (or attaches to a run already in progress) and streams its output. */
export function OmpUpdateSheet({ close }: SheetProps<undefined>) {
	const { t } = useTranslation("onboarding");
	const [run, setRun] = useState<OmpUpdateRun | null>(null);
	const [error, setError] = useState<string | null>(null);
	const output = useRef<HTMLPreElement>(null);

	useEffect(() => {
		let current: OmpUpdateRun | null = null;
		const earlyOutput = new Map<string, string[]>();
		const earlyFinished = new Map<string, OmpUpdateRun>();
		const offOutput = window.vomp.on("updates:omp:output", chunk => {
			if (!current) {
				earlyOutput.set(chunk.runId, [...(earlyOutput.get(chunk.runId) ?? []), chunk.data]);
				return;
			}
			if (chunk.runId !== current.runId) return;
			current = { ...current, output: current.output + chunk.data };
			setRun(current);
		});
		const offFinished = window.vomp.on("updates:omp:finished", finished => {
			if (!current) {
				earlyFinished.set(finished.runId, finished);
				return;
			}
			if (finished.runId !== current.runId) return;
			current = finished;
			setRun(finished);
			void useApp.getState().refreshOmp();
		});
		void (async () => {
			const last = await window.vomp.invoke("updates:omp:lastRun");
			// StrictMode remounts reuse the run the first mount started (main returns the active run).
			current = last && last.finishedAt === null ? last : await window.vomp.invoke("updates:omp:run");
			const outputBeforeAttach = earlyOutput.get(current.runId)?.join("") ?? "";
			if (outputBeforeAttach && !current.output.includes(outputBeforeAttach)) {
				current = { ...current, output: current.output + outputBeforeAttach };
			}
			const finishedBeforeAttach = earlyFinished.get(current.runId);
			if (finishedBeforeAttach) current = finishedBeforeAttach;
			setRun(current);
			if (finishedBeforeAttach) void useApp.getState().refreshOmp();
		})().catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
		return () => {
			offOutput();
			offFinished();
		};
	}, []);

	useEffect(() => {
		const element = output.current;
		if (element) element.scrollTop = element.scrollHeight;
	}, [run?.output]);

	const running = !error && (!run || run.finishedAt === null);
	const failed = Boolean(error) || (run?.exitCode !== null && run?.exitCode !== undefined && run.exitCode !== 0);
	const latest = useOmpUpdate.getState().status?.latestVersion;

	return (
		<Dialog open onOpenChange={open => !open && close()}>
			<DialogContent
				size="lg"
				title={latest ? t("update.omp.titleTo", { version: latest }) : t("update.omp.title")}
				footer={
					<Button variant={running ? "ghost" : "primary"} onClick={close}>
						{t("update.omp.close")}
					</Button>
				}
			>
				<div role="status" className="mb-3 flex items-center gap-2 text-md">
					{running ? (
						<WorkingIndicator label={t("update.omp.running")} />
					) : failed ? (
						<>
							<CircleAlert className="size-4 text-err" aria-hidden />
							<span className="text-fg">{error ?? t("update.omp.failed", { code: run?.exitCode })}</span>
						</>
					) : (
						<>
							<CircleCheck className="size-4 text-ok" aria-hidden />
							<span className="text-fg">
								{run?.versionAfter ? t("update.omp.doneVersion", { version: run.versionAfter }) : t("update.omp.done")}
							</span>
						</>
					)}
				</div>
				<pre
					ref={output}
					aria-label={t("update.omp.outputLabel")}
					tabIndex={0}
					className="h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-inset p-3 font-mono text-sm text-fg"
				>
					{run?.output || t("update.omp.waiting")}
				</pre>
				{!running && !failed && <p className="mt-3 text-sm text-fg-muted">{t("update.omp.restartNote")}</p>}
			</DialogContent>
		</Dialog>
	);
}
