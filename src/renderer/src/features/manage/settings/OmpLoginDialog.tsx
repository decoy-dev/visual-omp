/**
 * Runs omp's own sign-in (`omp login [provider]`) in an inline terminal. omp does everything: it
 * opens the browser, asks for codes or API keys and stores the credential. When omp exits, main
 * drops its cached providers and models and every window re-reads them.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dialog, DialogContent, FadeIn, Spinner } from "@/ui";
import { InlineTerminal } from "../../onboarding/InlineTerminal";
import { CommandRun } from "../../onboarding/terminal";
import { ipcErrorMessage } from "../shared";

export interface OmpLoginTarget {
	/** omp `/login` entry; null opens omp's own provider picker. */
	methodId: string | null;
	/** Provider name for the title; null with the picker. */
	name: string | null;
}

export interface OmpLoginDialogProps {
	target: OmpLoginTarget;
	/** Selected project folder, or null; main resolves the folder omp actually runs in. */
	cwd: string | null;
	onClose(): void;
	onFinished(code: number): void;
}

export function OmpLoginDialog({ target, cwd, onClose, onFinished }: OmpLoginDialogProps) {
	const { t } = useTranslation("manage");
	const [run, setRun] = useState<CommandRun | null>(null);
	const [exitCode, setExitCode] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const finished = useRef(onFinished);
	finished.current = onFinished;

	// The run starts from the effect but lives in state, so a StrictMode remount reuses it.
	useEffect(() => {
		let live = true;
		let started: CommandRun | null = null;
		void (async () => {
			try {
				// Main picks the folder, the same one it reads providers in; the dialog never chooses one.
				const login = await window.vomp.invoke("providers:loginCommand", target.methodId ?? undefined, cwd ?? undefined);
				if (!live) return;
				started = await CommandRun.start({ command: login.command, cwd: login.cwd, cols: 88, rows: 18 });
				if (live) setRun(started);
				else started.kill();
			} catch (reason) {
				if (live) setError(ipcErrorMessage(reason));
			}
		})();
		return () => {
			live = false;
			started?.kill();
		};
	}, [target.methodId, cwd]);

	useEffect(() => {
		if (!run) return;
		let reported = false;
		return run.attach({
			data: () => {},
			exit: code => {
				setExitCode(code);
				if (reported) return;
				reported = true;
				void window.vomp.invoke("providers:invalidate");
				finished.current(code);
			},
		});
	}, [run]);

	const close = () => {
		run?.kill();
		onClose();
	};

	return (
		<Dialog open onOpenChange={open => !open && close()}>
			<DialogContent
				size="xl"
				title={target.name ? t("providers.login.titleOne", { name: target.name }) : t("providers.login.titleAny")}
				description={exitCode === null ? t("providers.login.hint") : t("providers.login.exited")}
				footer={
					<Button variant={exitCode === null ? "secondary" : "primary"} onClick={close}>
						{t("common.close")}
					</Button>
				}
			>
				{error && (
					<p role="alert" className="text-sm text-err">
						{error}
					</p>
				)}
				{!error && !run && (
					<p role="status" className="flex items-center gap-2 text-sm text-fg-muted">
						<Spinner size={12} />
						{t("providers.login.starting")}
					</p>
				)}
				{run && (
					<FadeIn>
						<InlineTerminal run={run} label={t("providers.login.terminalLabel")} className="h-80" screenReader />
					</FadeIn>
				)}
			</DialogContent>
		</Dialog>
	);
}
