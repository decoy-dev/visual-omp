/**
 * omp-missing setup screen (DESIGN §4.1). Replaces the whole window while omp is missing, won't
 * start, or is older than visual-omp needs. The installer runs visibly in an inline terminal.
 */
import { ArrowClockwise, ArrowRight, Check, Copy, Play, Square } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OmpStatus } from "@shared/ipc";
import type { ScreenProps } from "../../registry/slots";
import { useApp } from "../../state/app";
import { Button, cn, Expand, Mark, PresenceSwap, toast } from "../../ui";
import { focusRing } from "../../ui/styles";
import { HelpDialog } from "./HelpSheet";
import { InlineTerminal } from "./InlineTerminal";
import { CommandRun } from "./terminal";

/** DESIGN §4.1: the done state shows both checkmarks briefly before the app takes over. */
const DONE_DELAY_MS = 600;

type Install = { state: "idle" } | { state: "running" | "succeeded" | "failed" | "cancelled"; run: CommandRun; code: number | null };
type Check = "idle" | "checking" | "missing" | "done";

export function SetupScreen(_props: ScreenProps) {
	const { t } = useTranslation("onboarding");
	const omp = useApp(state => state.omp);
	const [install, setInstall] = useState<Install>({ state: "idle" });
	const [copied, setCopied] = useState(false);
	const [check, setCheck] = useState<Check>("idle");
	// Help stays mounted after closing until its exit finishes, then unmounts so it opens fresh next time.
	const [helpOpen, setHelpOpen] = useState(false);
	const [helpMounted, setHelpMounted] = useState(false);
	const helpButton = useRef<HTMLButtonElement>(null);
	const windows = window.vomp.platform === "win32";

	const tooOld = Boolean(omp?.found && !omp.supported);
	const done = check === "done";
	const installing = install.state === "running";

	const runCheck = async () => {
		setCheck("checking");
		const status: OmpStatus = await window.vomp.invoke("omp:status", true);
		if (status.found && status.supported) {
			setCheck("done");
			// Let the checkmarks land, then hand over to the app (the shell swaps screens on refresh).
			setTimeout(() => void useApp.getState().refreshOmp(), DONE_DELAY_MS);
		} else {
			setCheck("missing");
			// Surface a changed problem (e.g. now found but too old) without leaving this screen.
			void useApp.getState().refreshOmp();
		}
	};

	const startInstall = async () => {
		if (!omp) return;
		setCheck("idle");
		const { homeDir } = await window.vomp.invoke("app:info");
		const run = await CommandRun.start({ command: omp.installCommand, cwd: homeDir, cols: 80, rows: 12 });
		setInstall({ state: "running", run, code: null });
	};

	useEffect(() => {
		if (install.state !== "running") return;
		const { run } = install;
		return run.attach({
			data: () => {},
			exit: code =>
				setInstall(previous =>
					previous.state === "idle" || previous.run !== run
						? previous
						: { state: previous.state === "cancelled" ? "cancelled" : code === 0 ? "succeeded" : "failed", run, code },
				),
		});
	}, [install]);

	// A clean installer exit goes straight to the check the user would do next.
	useEffect(() => {
		if (install.state === "succeeded") void runCheck();
	}, [install.state]);

	const cancel = () => {
		if (install.state !== "running") return;
		setInstall({ ...install, state: "cancelled" });
		install.run.kill();
	};

	const copy = async () => {
		if (!omp) return;
		await navigator.clipboard.writeText(omp.installCommand);
		setCopied(true);
		toast({ tone: "ok", message: t("setup.step1.copied"), description: t("setup.step1.copiedBody") });
	};

	const heading = done ? "done" : tooOld ? "tooOld" : "missing";
	const step1Done = done || install.state === "succeeded";
	const step2Ready = step1Done || copied || install.state === "failed" || install.state === "cancelled" || tooOld;
	const installStatus: Record<Install["state"], string | null> = {
		idle: null,
		running: t("setup.step1.running"),
		succeeded: t("setup.step1.succeeded"),
		failed: t("setup.step1.failed", { code: install.state === "idle" ? 0 : install.code }),
		cancelled: t("setup.step1.cancelled"),
	};

	return (
		<main className="relative flex min-h-screen w-full items-start justify-center overflow-y-auto bg-bg px-6 pb-16 pt-[max(64px,12vh)]">
			{/* Frameless window: keep the top strip draggable. */}
			<div aria-hidden className="absolute inset-x-0 top-0 h-10 [-webkit-app-region:drag]" />
			<div className="relative flex w-full max-w-[560px] flex-col items-center text-center">
				<Mark size={56} className="mb-6" />
				<PresenceSwap swapKey={heading} variant="rise" className="flex flex-col items-center">
					<h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-fg">{t(`setup.${heading}.title`)}</h1>
					<p className="mt-3 max-w-[440px] text-base text-fg-muted">{t(`setup.${heading}.body`)}</p>
				</PresenceSwap>
				{tooOld && omp && !done && (
					<dl className="mt-4 flex items-center gap-6 font-mono text-sm">
						<div className="flex gap-2">
							<dt className="text-fg-faint">{t("setup.tooOld.installed")}</dt>
							<dd className="text-err">{omp.version}</dd>
						</div>
						<div className="flex gap-2">
							<dt className="text-fg-faint">{t("setup.tooOld.required")}</dt>
							<dd className="text-fg">{omp.minVersion}+</dd>
						</div>
					</dl>
				)}

				{omp && !omp.found && omp.path && !done && (
					<p className="mt-3 max-w-[440px] font-mono text-sm text-fg-faint">{omp.problem}</p>
				)}
				<ol className="mt-8 w-full divide-y divide-border overflow-hidden rounded-lg border border-border bg-panel text-left">
					<StepRow
						number={1}
						done={step1Done}
						title={tooOld ? t("setup.step1.update") : t("setup.step1.install")}
						body={windows ? t("setup.step1.bodyWindows") : t("setup.step1.body")}
					>
						{omp && (
							<code className="mt-3 block select-all break-all rounded-md border border-border bg-inset px-3 py-2 font-mono text-sm text-fg">
								{windows && <span className="mr-2 text-fg-faint">PS&gt;</span>}
								{omp.installCommand}
							</code>
						)}
						<Expand open={install.state !== "idle"} className="pt-3">
							{install.state !== "idle" && (
								<>
									<InlineTerminal run={install.run} label={t("setup.step1.terminalLabel")} className="h-60" />
									<p
										role="status"
										className={cn(
											"mt-2 text-sm transition-colors duration-(--dur)",
											install.state === "failed" ? "text-err" : "text-fg-muted",
										)}
									>
										{installStatus[install.state]}
									</p>
								</>
							)}
						</Expand>
						<div className="mt-3 flex flex-wrap items-center gap-2">
							{installing ? (
								<Button variant="secondary" icon={<Square aria-hidden />} onClick={cancel}>
									{t("setup.step1.cancel")}
								</Button>
							) : (
								<Button
									variant="primary"
									icon={<Play aria-hidden />}
									onClick={() => void startInstall()}
									disabled={!omp || done}
								>
									{tooOld ? t("setup.step1.runUpdate") : t("setup.step1.run")}
								</Button>
							)}
							<Button
								variant="ghost"
								icon={<Copy aria-hidden />}
								onClick={() => void copy()}
								disabled={!omp}
								title={t("setup.step1.copyHint")}
							>
								{t("setup.step1.copy")}
							</Button>
						</div>
					</StepRow>
					<StepRow number={2} done={done} disabled={!step2Ready} title={t("setup.step2.title")} body={t("setup.step2.body")}>
						<div className="mt-3">
							<Button
								variant="secondary"
								icon={<ArrowClockwise aria-hidden />}
								onClick={() => void runCheck()}
								loading={check === "checking"}
								disabled={!step2Ready || installing || done}
							>
								{t("setup.step2.check")}
							</Button>
						</div>
						<Expand open={check === "missing"} className="pt-3">
							<div role="status" className="rounded-md border border-border bg-warn-bg px-3 py-2 text-sm">
								<p className="font-medium text-fg">{omp?.problem ?? t("setup.step2.stillMissing")}</p>
								<p className="mt-0.5 text-fg-muted">{t("setup.step2.stillMissingBody")}</p>
							</div>
						</Expand>
					</StepRow>
				</ol>

				<p className="mt-5 text-md text-fg-muted">
					{t("setup.trouble")}{" "}
					<button
						ref={helpButton}
						type="button"
						onClick={() => {
							setHelpMounted(true);
							setHelpOpen(true);
						}}
						className={cn("inline-flex items-center gap-1 rounded-sm font-medium text-accent hover:underline", focusRing)}
					>
						{t("setup.openHelp")}
						<ArrowRight className="size-3.5" aria-hidden />
					</button>
				</p>
			</div>
			{helpMounted && (
				<HelpDialog
					limited
					open={helpOpen}
					onClose={() => setHelpOpen(false)}
					onExited={() => {
						setHelpMounted(false);
						helpButton.current?.focus();
					}}
				/>
			)}
		</main>
	);
}

function StepRow({
	number,
	title,
	body,
	done,
	disabled = false,
	children,
}: {
	number: number;
	title: string;
	body: string;
	done: boolean;
	disabled?: boolean;
	children: ReactNode;
}) {
	const { t } = useTranslation("onboarding");
	return (
		<li className={cn("flex gap-4 p-4 transition-opacity duration-(--dur) ease-(--ease-out-quart)", disabled && "opacity-60")}>
			<span
				className={cn(
					"relative inline-flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full border font-mono text-sm font-semibold tabular-nums transition-colors duration-(--dur)",
					done ? "border-ok bg-ok text-fg-inverse" : "border-border-strong text-fg-muted",
				)}
			>
				<PresenceSwap swapKey={done ? "done" : "todo"} variant="rise" className="inline-flex items-center justify-center">
					{done ? <Check className="size-4" weight="bold" aria-label={t("setup.stepDone")} /> : number}
				</PresenceSwap>
			</span>
			<div className="min-w-0 flex-1">
				<h2 className="text-md font-semibold text-fg">{title}</h2>
				<p className="mt-0.5 text-md text-fg-muted">{body}</p>
				{children}
			</div>
		</li>
	);
}
