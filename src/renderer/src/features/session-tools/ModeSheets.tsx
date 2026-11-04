/** Session mode and action dialogs, loaded on first open or in idle time (`./modes` registers them). */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dialog, DialogContent, Input, Textarea, toast } from "@/ui";
import type { SheetProps } from "../../registry/slots";
import { controllerFor } from "../../state/app";
import type { SessionController } from "../../state/session";
import { i18n } from "../../i18n";
import { setApprovalMode, acknowledgeAuto } from "./approval";
import { reportFailure, reportOutput, runAndReport, runCommand } from "./drive";
import type { TabProps } from "./modes";
import { setSessionMode } from "./nativeModes";
import { goalBudget, loopRequest } from "./modeInputs";
import { exitPlan } from "./plan";
import { useOmpScreen } from "./status";

export function TextActionSheet({ props, close }: SheetProps<TabProps>) {
	const { t } = useTranslation("session");
	const session = controllerFor(props.tabId);
	const kind = props.kind ?? "compact";
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const key = kind === "rename" ? "rename" : kind === "handoff" ? "handoff" : kind === "guided" ? "guided" : "compact";
	if (!session) return null;
	const submit = async () => {
		setBusy(true);
		try {
			const command = kind === "rename" ? `/rename ${value.trim()}` : kind === "handoff" ? `/handoff${value.trim() ? ` ${value.trim()}` : ""}` : kind === "guided" ? `/guided-goal${value.trim() ? ` ${value.trim()}` : ""}` : `/compact${value.trim() ? ` ${value.trim()}` : ""}`;
			await runCommand(session, command, {
				timeoutMs: 10000, until: (_screen, output) => output.length > 0,
				present: result => {
					if (!result.output.length) return false;
					if (result.status) return reportOutput(result.output, undefined, result.status);
					toast({ message: result.output.at(-1) ?? t(`${key}.title`) });
					return true;
				},
			});
			close();
		} catch (error) {
			reportFailure(error);
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={open => !open && close()}>
			<DialogContent title={t(`${key}.title`)} description={t(`${key}.description`)} size="md" footer={<><Button variant="ghost" onClick={close}>{t("common.cancel")}</Button><Button variant="primary" loading={busy} onClick={() => void submit()}>{t(`${key}.action`)}</Button></>}>
				{kind === "rename" ? <Input autoFocus label={t("rename.label")} value={value} onChange={event => setValue(event.currentTarget.value)} onKeyDown={event => event.key === "Enter" && void submit()} /> : <Textarea autoFocus rows={4} label={t(`${key}.label`)} value={value} onChange={event => setValue(event.currentTarget.value)} />}
			</DialogContent>
		</Dialog>
	);
}

export function GoalSheet({ props, close }: SheetProps<TabProps>) {
	const session = controllerFor(props.tabId);
	return session ? <GoalDialog session={session} close={close} /> : null;
}

function GoalDialog({ session, close }: { session: SessionController; close(): void }) {
	const { t } = useTranslation("session");
	const status = useOmpScreen(session).status;
	const active = status?.goal === "active";
	const paused = status?.goal === "paused";
	const [objective, setObjective] = useState("");
	const [budget, setBudget] = useState("");
	const [busy, setBusy] = useState(false);
	const run = async (action: "pause" | "resume" | "drop") => {
		setBusy(true);
		try { await setSessionMode(session, { mode: "goal", action }); }
		catch (error) { reportFailure(error); }
		finally { setBusy(false); }
	};
	const start = async (guided: boolean) => {
		if (guided) { close(); await runAndReport(session, "/guided-goal"); return; }
		if (!objective.trim()) return;
		setBusy(true);
		try {
			let tokenBudget: number | undefined;
			try { tokenBudget = goalBudget(budget); }
			catch { throw new Error(i18n.t("advisor:mode.budget")); }
			await setSessionMode(session, { mode: "goal", action: "enter", objective: objective.trim(), tokenBudget });
			close();
		} catch (error) { reportFailure(error); }
		finally { setBusy(false); }
	};
	return (
		<Dialog open onOpenChange={open => !open && close()}>
			<DialogContent title={t("goal.title")} description={t("goal.description")} size="md" footer={<><Button variant="ghost" onClick={close}>{t("common.cancel")}</Button>{active || paused ? <><Button variant="secondary" loading={busy} onClick={() => void run(paused ? "resume" : "pause")}>{t(paused ? "goal.resume" : "goal.pause")}</Button><Button variant="danger-ghost" loading={busy} onClick={() => void run("drop")}>{t("goal.drop")}</Button></> : <Button variant="primary" loading={busy} disabled={!objective.trim()} onClick={() => void start(false)}>{t("goal.start")}</Button>}</>}>
				{active || paused ? <p className="text-md text-fg-muted">{t(paused ? "goal.pausedBody" : "goal.activeBody")}</p> : <div className="space-y-3"><Textarea autoFocus rows={4} label={t("goal.objective")} value={objective} onChange={event => setObjective(event.currentTarget.value)} /><Input label={t("goal.budget")} description={t("goal.budgetHint")} inputMode="numeric" value={budget} onChange={event => setBudget(event.currentTarget.value)} /><Button variant="ghost" onClick={() => void start(true)}>{t("goal.guided")}</Button></div>}
			</DialogContent>
		</Dialog>
	);
}

export function LoopSheet({ props, close }: SheetProps<TabProps>) {
	const { t } = useTranslation("session");
	const session = controllerFor(props.tabId);
	const [kind, setKind] = useState<"count" | "duration" | "until" | "while">("count");
	const [limit, setLimit] = useState("5");
	const [check, setCheck] = useState("");
	const [prompt, setPrompt] = useState("");
	const [busy, setBusy] = useState(false);
	if (!session) return null;
	const submit = async () => {
		setBusy(true);
		try {
			let request;
			try { request = loopRequest(kind, limit, check, prompt); }
			catch { throw new Error(i18n.t(`advisor:mode.${kind}`)); }
			await setSessionMode(session, request);
			if (request.prompt) await session.send(request.prompt);
			close();
		} catch (error) { reportFailure(error); }
		finally { setBusy(false); }
	};
	return <Dialog open onOpenChange={open => !open && close()}><DialogContent title={t("loop.title")} description={t("loop.description")} size="md" footer={<><Button variant="ghost" onClick={close}>{t("common.cancel")}</Button><Button variant="primary" loading={busy} onClick={() => void submit()}>{t("loop.start")}</Button></>}>
		<div className="space-y-3"><label className="block text-md font-medium">{t("loop.bound")}<select className="mt-1 block h-9 w-full rounded-md border border-border-strong bg-panel px-2 text-fg" value={kind} onChange={event => setKind(event.currentTarget.value as typeof kind)}><option value="count">{t("loop.count")}</option><option value="duration">{t("loop.duration")}</option><option value="until">{t("loop.until")}</option><option value="while">{t("loop.while")}</option></select></label>{kind === "until" || kind === "while" ? <Input label={t("loop.check")} value={check} spellCheck={false} onChange={event => setCheck(event.currentTarget.value)} placeholder="npm test" /> : <Input label={t(kind === "count" ? "loop.countLabel" : "loop.durationLabel")} value={limit} spellCheck={false} onChange={event => setLimit(event.currentTarget.value)} placeholder={kind === "count" ? "5" : "10m"} />}<Textarea rows={3} label={t("loop.prompt")} description={t("loop.promptHint")} value={prompt} onChange={event => setPrompt(event.currentTarget.value)} /></div>
	</DialogContent></Dialog>;
}

export function AutoConfirmSheet({ props, close }: SheetProps<{ cwd: string }>) {
	const { t } = useTranslation("session");
	const [busy, setBusy] = useState(false);
	const confirm = async () => {
		setBusy(true);
		try { acknowledgeAuto(); await setApprovalMode(props.cwd, "yolo"); close(); }
		catch (error) { reportFailure(error); }
		finally { setBusy(false); }
	};
	return <Dialog open onOpenChange={open => !open && close()}><DialogContent title={t("permission.autoConfirm.title")} description={t("permission.autoConfirm.description")} destructive size="sm" footer={<><Button variant="ghost" onClick={close}>{t("common.cancel")}</Button><Button variant="primary" loading={busy} onClick={() => void confirm()}>{t("permission.autoConfirm.confirm")}</Button></>} /></Dialog>;
}

export function PlanExitSheet({ props, close }: SheetProps<TabProps>) {
	const { t } = useTranslation("session");
	const session = controllerFor(props.tabId);
	if (!session) return null;
	return <Dialog open onOpenChange={open => !open && close()}><DialogContent title={t("plan.exitTitle")} description={t("plan.exitDescription")} footer={<><Button variant="ghost" onClick={close}>{t("common.cancel")}</Button><Button variant="danger-ghost" onClick={() => { close(); void exitPlan(session); }}>{t("plan.exitConfirm")}</Button></>} /></Dialog>;
}

