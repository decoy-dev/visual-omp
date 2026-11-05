import { ArrowSquareOut, Copy } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import type { AppInstallSwitchInfo, AppInstallSwitchRun } from "@shared/contracts/updates";
import { Button, Dialog, DialogContent, Expand, toast, WorkingIndicator } from "../../ui";
import { focusRing } from "../../ui/styles";
import { ipcErrorMessage, useResource } from "../manage/shared";
import { InlineTerminal } from "./InlineTerminal";
import { quitAfterConfirm } from "./quit";
import { CommandRun } from "./terminal";
import { useUpdates } from "./updates";

const COMMANDS = {
	brew: "brew update\nbrew tap decoy-dev/tap https://github.com/decoy-dev/visual-omp\nbrew install --cask decoy-dev/tap/visual-omp",
	scoop: "scoop install git\nscoop bucket add decoy-dev https://github.com/decoy-dev/visual-omp\nscoop install decoy-dev/visual-omp",
};

interface SwitchState {
	run: AppInstallSwitchRun | null;
	terminal: CommandRun | null;
	phase: "idle" | "preparing" | "running" | "ready" | "failed";
	error: string | null;
}
const useSwitch = create<SwitchState>(() => ({ run: null, terminal: null, phase: "idle", error: null }));

/** Direct copies retain a guide until the corresponding package manager is available. */
function PackageManagerGuide({ manager }: { manager: "brew" | "scoop" }) {
	const { t } = useTranslation("onboarding");
	const [open, setOpen] = useState(false);
	const key = manager === "brew" ? "brewSwitch" : "scoopSwitch";
	const copy = () => void navigator.clipboard.writeText(COMMANDS[manager]).then(
		() => toast({ tone: "ok", message: t(`update.app.${key}.copied`) }),
		error => toast({ tone: "err", message: t(`update.app.${key}.copyFailed`), description: ipcErrorMessage(error) }),
	);
	return <div className="mt-stack text-sm">
		<p className="text-fg-muted">{t(`update.app.${key}.intro`)}{" "}
			<button type="button" aria-expanded={open} className={`rounded-sm text-accent underline-offset-2 hover:underline ${focusRing}`} onClick={() => setOpen(value => !value)}>
				{t(`update.app.${key}.${open ? "hide" : "show"}`)}
			</button>
		</p>
		<Expand open={open}>
			<ol className="mt-stack flex list-decimal flex-col gap-stack pl-5 text-fg">
				<li>{t(`update.app.${key}.install`)}
					<Button size="sm" variant="ghost" icon={<ArrowSquareOut aria-hidden />} className="ml-1" onClick={() => void window.vomp.invoke("app:openExternal", manager === "brew" ? "https://brew.sh" : "https://scoop.sh")}>
						{t(`update.app.${key}.${manager === "brew" ? "openBrew" : "openScoop"}`)}
					</Button>
				</li>
				<li>{t(`update.app.${key}.commands`)}
					<code className="mt-2 block select-all whitespace-pre-wrap break-all rounded-md border border-border bg-inset px-3 py-2 font-mono text-sm text-fg">{COMMANDS[manager]}</code>
					<Button size="sm" variant="ghost" icon={<Copy aria-hidden />} className="mt-2" onClick={copy}>{t(`update.app.${key}.copy`)}</Button>
				</li>
				<li>{t(`update.app.${key}.remove`)}</li>
			</ol>
		</Expand>
	</div>;
}

/** Windows transfers remain a manual guide, including when Scoop is already installed. */
export function ScoopSuggestion() {
	return <PackageManagerGuide manager="scoop" />;
}

export function PackageManagerSuggestion() {
	const info = useResource(() => window.vomp.invoke("updates:app:switchInfo"), []);
	return info.data && !info.data.available ? <PackageManagerGuide manager={info.data.manager} /> : null;
}

/** The terminal run survives closing the dialog or navigating away from About. */
export function PackageManagerSwitch({ busy = false }: { busy?: boolean }) {
	const { t } = useTranslation("onboarding");
	const info = useResource(() => window.vomp.invoke("updates:app:switchInfo"), []);
	const [confirmation, setConfirmation] = useState<AppInstallSwitchInfo | null>(null);
	const [completing, setCompleting] = useState(false);
	const cancel = useRef<HTMLButtonElement>(null);
	const action = useRef<HTMLButtonElement>(null);
	const operation = useUpdates(value => value.operation);
	const conflicting = busy || (operation !== null && operation !== "switch");
	const state = useSwitch();
	const working = state.phase === "preparing" || state.phase === "running" || completing;
	const manager = "Homebrew";
	const start = async () => {
		if (working || conflicting || operation) return;
		useSwitch.setState({ phase: "preparing", error: null, terminal: null, run: null });
		let acquired = false;
		useUpdates.setState({ operation: "switch" });
		try {
			const run = await window.vomp.invoke("updates:app:switchStart");
			useSwitch.setState({ run });
			if (!run.command) { useUpdates.setState({ operation: null }); useSwitch.setState({ phase: "ready" }); return; }
			acquired = true;
			const { homeDir } = await window.vomp.invoke("app:info");
			const terminal = await CommandRun.start({ command: run.command, cwd: homeDir, cols: 96, rows: 14 });
			useSwitch.setState({ terminal, phase: "running" });
			terminal.attach({ data: () => {}, exit: code => {
				void window.vomp.invoke("updates:app:switchSettled").then(() => {
					useUpdates.setState({ operation: null });
					useSwitch.setState({ phase: code === 0 ? "ready" : "failed", error: code === 0 ? null : t("update.installSwitch.commandFailed", { code }) });
				});
			} });
		} catch (error) {
			if (acquired) await window.vomp.invoke("updates:app:switchSettled");
			useUpdates.setState({ operation: await window.vomp.invoke("updates:app:operation") ?? null });
			useSwitch.setState({ phase: "failed", error: ipcErrorMessage(error) });
		}
	};
	const complete = async (trash: boolean) => {
		if (conflicting || operation) return;
		setCompleting(true);
		useSwitch.setState({ error: null });
		try { await quitAfterConfirm(() => window.vomp.invoke("updates:app:switchComplete", trash)); }
		catch (error) { useSwitch.setState({ error: ipcErrorMessage(error) }); }
		finally { setCompleting(false); }
	};
	if (info.loading) return <p role="status" className="mt-stack text-sm text-fg-muted">{t("update.installSwitch.checking")}</p>;
	if (info.error) return <div className="mt-stack text-sm text-fg-muted"><p role="status">{t("update.installSwitch.checkFailed", { reason: info.error })}</p><Button size="sm" variant="ghost" onClick={() => void info.reload()}>{t("update.reinstall.checkAgain")}</Button></div>;
	if (!info.data) return null;
	if (!info.data.available) return <><PackageManagerGuide manager={info.data.manager} /><Button size="sm" variant="ghost" onClick={() => void info.reload()}>{t("update.installSwitch.checkManager")}</Button></>;
	return <>
		<div className="mt-stack flex flex-wrap items-center gap-toolbar">
			<Button ref={action} size="sm" disabled={conflicting} onClick={() => setConfirmation(info.data)}>{t(working || state.phase === "ready" ? "update.installSwitch.showProgress" : "update.installSwitch.action", { manager })}</Button>
		</div>
		<Dialog open={!!confirmation} onOpenChange={open => { if (!open && !completing) setConfirmation(null); }}>
			<DialogContent size="lg" title={t("update.installSwitch.title", { manager })} onOpenAutoFocus={event => { event.preventDefault(); cancel.current?.focus(); }} onCloseAutoFocus={event => { event.preventDefault(); action.current?.focus(); }} footer={<div className="flex w-full flex-wrap justify-end gap-toolbar [&>button]:h-auto [&>button]:min-h-8 [&>button]:max-w-full [&>button]:whitespace-normal [&>button]:py-1.5">
				<Button ref={cancel} variant="ghost" disabled={completing} onClick={() => setConfirmation(null)}>{t(state.phase === "idle" || state.phase === "failed" ? "update.rollback.cancel" : "update.app.close")}</Button>
				{state.phase === "idle" || state.phase === "failed" ? <Button variant="primary" disabled={conflicting} loading={working} onClick={() => void start()}>{t("update.installSwitch.action", { manager })}</Button> : state.phase === "ready" && <>
					{state.run?.canTrash && <Button disabled={completing || conflicting} onClick={() => void complete(true)}>{t("update.installSwitch.trashRestart")}</Button>}
					<Button variant="primary" disabled={conflicting} loading={completing} onClick={() => void complete(false)}>{t("update.installSwitch.restart")}</Button>
				</>}
			</div>}>
				<div className="flex flex-col gap-stack text-md text-fg-muted">
					<p>{t(confirmation?.existing ? "update.installSwitch.existing" : "update.installSwitch.brewBody", { manager })}</p>
					<p>{t("update.installSwitch.preserved")}</p>
					{(state.run?.target ?? confirmation?.target) && <p className="break-all font-mono text-sm">{state.run?.target ?? confirmation?.target}</p>}
					{state.phase === "preparing" && <WorkingIndicator label={t("update.installSwitch.preparing")} />}
					{state.phase === "running" && <WorkingIndicator label={t("update.installSwitch.running", { manager })} />}
					{state.terminal && <InlineTerminal run={state.terminal} label={t("update.installSwitch.terminalLabel")} className="h-60" screenReader />}
					{state.phase === "ready" && state.run?.canTrash && <p>{t("update.installSwitch.trashOffer")}</p>}
					{state.error && <p role="alert" className="text-err">{state.error}</p>}
				</div>
			</DialogContent>
		</Dialog>
	</>;
}
