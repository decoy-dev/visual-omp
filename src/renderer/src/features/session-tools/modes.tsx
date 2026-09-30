/** Session modes and actions exposed to the palette, header, and menus. */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownToLine, Bot, Brain, CircleStop, Copy, Download, GitBranch, Goal, Repeat2, MessageSquarePlus, RefreshCw, ScanSearch, ShieldCheck, Sparkles, TreeDeciduous, WandSparkles, X } from "lucide-react";
import { Button, Dialog, DialogContent, Input, Menu, MenuContent, MenuItem, MenuTrigger, Textarea, toast } from "@/ui";
import { registerCommand } from "../../registry/commands";
import type { SheetProps } from "../../registry/slots";
import { sheets } from "../../registry/slots";
import { controllerFor, useApp } from "../../state/app";
import type { SessionController } from "../../state/session";
import { i18n } from "../../i18n";
import { setApprovalMode, acknowledgeAuto } from "./approval";
import { reportFailure, runAndReport, runCommand, waitForScreen, press } from "./drive";
import { forkChat, navigateTo } from "./navigate";
import { exitPlan, togglePlan } from "./plan";
import { useOmpScreen, useSessionView } from "./status";
import { parseStatusLine } from "./screen";
import { HeaderChips, ModelButton, PermissionPill, ThinkingButton, usePickerRequests } from "./pickers";

interface TabProps { tabId: string; kind?: string; }

function TextActionSheet({ props, close }: SheetProps<TabProps>) {
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
			const result = await runCommand(session, command, { timeoutMs: 10000, until: (_screen, output) => output.length > 0 });
			if (result.output.length) toast({ message: result.output.at(-1) ?? t(`${key}.title`) });
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

function GoalSheet({ props, close }: SheetProps<TabProps>) {
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
	const run = async (command: string) => {
		setBusy(true);
		try { await runAndReport(session, command, { timeoutMs: 10000 }); }
		finally { setBusy(false); }
	};
	const start = async (guided: boolean) => {
		if (guided) { close(); await runAndReport(session, "/guided-goal"); return; }
		if (!objective.trim()) return;
		close(); await runAndReport(session, `/goal set ${objective.trim()}`);
		if (budget.trim()) await runAndReport(session, `/goal budget ${budget.trim()}`);
	};
	return (
		<Dialog open onOpenChange={open => !open && close()}>
			<DialogContent title={t("goal.title")} description={t("goal.description")} size="md" footer={<><Button variant="ghost" onClick={close}>{t("common.cancel")}</Button>{active || paused ? <><Button variant="secondary" loading={busy} onClick={() => void run(`/goal ${paused ? "resume" : "pause"}`)}>{t(paused ? "goal.resume" : "goal.pause")}</Button><Button variant="danger-ghost" loading={busy} onClick={() => void run("/goal drop")}>{t("goal.drop")}</Button></> : <Button variant="primary" loading={busy} disabled={!objective.trim()} onClick={() => void start(false)}>{t("goal.start")}</Button>}</>}>
				{active || paused ? <p className="rounded-md border border-border bg-inset p-3 text-md text-fg-muted">{t(paused ? "goal.pausedBody" : "goal.activeBody")}</p> : <div className="space-y-3"><Textarea autoFocus rows={4} label={t("goal.objective")} value={objective} onChange={event => setObjective(event.currentTarget.value)} /><Input label={t("goal.budget")} description={t("goal.budgetHint")} inputMode="numeric" value={budget} onChange={event => setBudget(event.currentTarget.value)} /><Button variant="ghost" onClick={() => void start(true)}>{t("goal.guided")}</Button></div>}
			</DialogContent>
		</Dialog>
	);
}

function LoopSheet({ props, close }: SheetProps<TabProps>) {
	const { t } = useTranslation("session");
	const session = controllerFor(props.tabId);
	const [kind, setKind] = useState<"count" | "duration" | "until" | "while">("count");
	const [limit, setLimit] = useState("5");
	const [check, setCheck] = useState("");
	const [prompt, setPrompt] = useState("");
	const [busy, setBusy] = useState(false);
	if (!session) return null;
	const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
	const submit = async () => {
		const args = kind === "count" ? limit.trim() : kind === "duration" ? limit.trim() : `${kind === "until" ? "--until" : "--while"} ${quote(check.trim())}`;
		if ((kind === "until" || kind === "while") && !check.trim()) return;
		setBusy(true);
		close();
		await runAndReport(session, `/loop ${args}${prompt.trim() ? ` ${prompt.trim()}` : ""}`, { timeoutMs: 8000 });
		setBusy(false);
	};
	return <Dialog open onOpenChange={open => !open && close()}><DialogContent title={t("loop.title")} description={t("loop.description")} size="md" footer={<><Button variant="ghost" onClick={close}>{t("common.cancel")}</Button><Button variant="primary" loading={busy} onClick={() => void submit()}>{t("loop.start")}</Button></>}>
		<div className="space-y-3"><label className="block text-md font-medium">{t("loop.bound")}<select className="mt-1 block h-9 w-full rounded-md border border-border-strong bg-panel px-2 text-fg" value={kind} onChange={event => setKind(event.currentTarget.value as typeof kind)}><option value="count">{t("loop.count")}</option><option value="duration">{t("loop.duration")}</option><option value="until">{t("loop.until")}</option><option value="while">{t("loop.while")}</option></select></label>{kind === "until" || kind === "while" ? <Input label={t("loop.check")} value={check} onChange={event => setCheck(event.currentTarget.value)} placeholder="npm test" /> : <Input label={t(kind === "count" ? "loop.countLabel" : "loop.durationLabel")} value={limit} onChange={event => setLimit(event.currentTarget.value)} placeholder={kind === "count" ? "5" : "10m"} />}<Textarea rows={3} label={t("loop.prompt")} description={t("loop.promptHint")} value={prompt} onChange={event => setPrompt(event.currentTarget.value)} /></div>
	</DialogContent></Dialog>;
}

function AutoConfirmSheet({ props, close }: SheetProps<{ cwd: string }>) {
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

function PlanExitSheet({ props, close }: SheetProps<TabProps>) {
	const { t } = useTranslation("session");
	const session = controllerFor(props.tabId);
	if (!session) return null;
	return <Dialog open onOpenChange={open => !open && close()}><DialogContent title={t("plan.exitTitle")} description={t("plan.exitDescription")} footer={<><Button variant="ghost" onClick={close}>{t("common.cancel")}</Button><Button variant="danger-ghost" onClick={() => { close(); void exitPlan(session); }}>{t("plan.exitConfirm")}</Button></>} /></Dialog>;
}

sheets.register({ id: "session-text-action", component: TextActionSheet });
sheets.register({ id: "session-goal", component: GoalSheet });
sheets.register({ id: "session-loop", component: LoopSheet });
sheets.register({ id: "session-auto-confirm", component: AutoConfirmSheet });
sheets.register({ id: "session-plan-exit", component: PlanExitSheet });

function openText(session: SessionController, kind: string): void { useApp.getState().openSheet("session-text-action", { tabId: session.tabId, kind } satisfies TabProps); }
function openGoal(session: SessionController): void { useApp.getState().openSheet("session-goal", { tabId: session.tabId }); }
function openLoop(session: SessionController): void { useApp.getState().openSheet("session-loop", { tabId: session.tabId }); }

const sessionWhen = (ctx: { session: SessionController | null }) => ctx.session !== null;

registerCommand({ id: "chat.restart", title: "session:commands.restart.title", hint: "session:commands.restart.hint", slash: "/restart", group: "modes", icon: RefreshCw, header: 10, when: sessionWhen, run: async ({ session }) => { if (session) await session.restart(); } });
registerCommand({ id: "chat.compact", title: "session:commands.compact.title", hint: "session:commands.compact.hint", slash: "/compact", group: "modes", icon: Copy, header: 20, when: sessionWhen, run: ({ session }) => { if (session) openText(session, "compact"); } });
registerCommand({ id: "chat.plan", title: "session:commands.plan.title", hint: "session:commands.plan.hint", slash: "/plan", group: "modes", icon: Brain, header: 30, when: sessionWhen, run: async ({ session }) => { if (session) await togglePlan(session); } });
registerCommand({ id: "chat.goal", title: "session:commands.goal.title", hint: "session:commands.goal.hint", slash: "/goal", group: "modes", icon: Goal, when: sessionWhen, run: ({ session }) => { if (session) openGoal(session); } });
registerCommand({ id: "chat.guidedGoal", title: "session:commands.guided.title", hint: "session:commands.guided.hint", slash: "/guided-goal", group: "modes", icon: WandSparkles, when: sessionWhen, run: ({ session }) => { if (session) openText(session, "guided"); } });
registerCommand({ id: "chat.vibe", title: "session:commands.vibe.title", hint: "session:commands.vibe.hint", slash: "/vibe", group: "modes", icon: Sparkles, when: sessionWhen, run: ({ session }) => { if (session) void runAndReport(session, "/vibe"); } });
registerCommand({ id: "chat.loop", title: "session:commands.loop.title", hint: "session:commands.loop.hint", slash: "/loop", group: "modes", icon: Repeat2, when: sessionWhen, run: ({ session }) => { if (session) openLoop(session); } });
registerCommand({ id: "chat.advisor", title: "session:commands.advisor.title", hint: "session:commands.advisor.hint", slash: "/advisor on|off|status", group: "modes", icon: Bot, when: sessionWhen, run: async ({ session }) => {
	if (!session) return;
	try {
		const { output } = await runCommand(session, "/advisor status", { until: (_lines, lines) => lines.some(line => /Advisor is disabled|Advisor Status/.test(line)) });
		const enabled = output.some(line => line.includes("Advisor Status"));
		await runAndReport(session, `/advisor ${enabled ? "off" : "on"}`);
	} catch (error) { reportFailure(error); }
} });
registerCommand({ id: "chat.handoff", title: "session:commands.handoff.title", hint: "session:commands.handoff.hint", slash: "/handoff", group: "modes", icon: ArrowDownToLine, when: sessionWhen, run: ({ session }) => { if (session) openText(session, "handoff"); } });
registerCommand({ id: "chat.security", title: "session:commands.security.title", hint: "session:commands.security.hint", slash: "/security scan", group: "modes", icon: ShieldCheck, when: sessionWhen, run: async ({ session }) => {
	if (!session) return;
	try {
		const { output } = await runCommand(session, "/security scan", { timeoutMs: 10000, until: (_lines, out) => out.some(line => /security|scan|disabled|error/i.test(line)) });
		if (output.some(line => /Security is disabled/i.test(line))) { toast({ tone: "warn", message: i18n.t("session:security.disabled") }); return; }
		const result = await runCommand(session, "/security status", { timeoutMs: 10000, until: (_lines, out) => out.length > 0 });
		toast({ message: result.output.at(-1) ?? i18n.t("session:security.started") });
	} catch (error) { reportFailure(error); }
} });
registerCommand({ id: "chat.cleanse", title: "session:commands.cleanse.title", hint: "session:commands.cleanse.hint", slash: "/cleanse", group: "modes", icon: ScanSearch, when: sessionWhen, run: async ({ session }) => { if (session) { const result = await runAndReport(session, "/cleanse"); if (result && !parseStatusLine(result.screen)) useApp.getState().openTerminal(session.tabId); } } });
registerCommand({ id: "chat.export", title: "session:commands.export.title", hint: "session:commands.export.hint", slash: "/export", group: "modes", icon: Download, when: sessionWhen, run: async ({ session }) => { if (session) { const result = await runCommand(session, "/export", { timeoutMs: 10000, until: (_lines, out) => out.some(line => /Session exported to/i.test(line)) }); const path = result.output.find(line => /Session exported to/i.test(line)); if (path) toast({ tone: "ok", message: path, action: { label: i18n.t("session:export.show"), onClick: () => void window.vomp.invoke("app:showItem", path.split(":").at(-1)?.trim() ?? path) } }); } } });
registerCommand({ id: "chat.rename", title: "session:commands.rename.title", hint: "session:commands.rename.hint", slash: "/rename", group: "modes", icon: MessageSquarePlus, when: sessionWhen, run: ({ session }) => { if (session) openText(session, "rename"); } });
registerCommand({ id: "chat.stop", title: "session:commands.stop.title", hint: "session:commands.stop.hint", slash: "Esc", shortcut: "⌘.", group: "chat", icon: CircleStop, when: ctx => Boolean(ctx.session?.getSnapshot().working), run: ({ session }) => session?.abort() });
registerCommand({ id: "chat.model", title: "session:commands.model.title", hint: "session:commands.model.hint", slash: "/switch", shortcut: "⌘⇧M", group: "modes", icon: Brain, when: sessionWhen, run: ({ session }) => { if (session) usePickerRequests.getState().openModel(session.tabId); } });
registerCommand({ id: "chat.tree", title: "session:commands.tree.title", hint: "session:commands.tree.hint", slash: "/tree", group: "modes", icon: TreeDeciduous, when: sessionWhen, run: ({ session }) => { if (session) useApp.getState().openSheet("session-tree", { tabId: session.tabId }); } });
registerCommand({ id: "chat.fork", title: "session:commands.fork.title", hint: "session:commands.fork.hint", slash: "/fork", group: "modes", icon: GitBranch, when: sessionWhen, run: async ({ session }) => { if (session) try { await forkChat(session); } catch (error) { reportFailure(error); } } });
registerCommand({ id: "chat.rewindTo", title: "session:commands.rewind.title", hint: "session:commands.rewind.hint", slash: "/tree", group: "modes", icon: X, when: ctx => Boolean(ctx.session && ctx.entryId), run: async ctx => {
	if (!ctx.session || !ctx.entryId) return;
	try { await navigateTo(ctx.session, ctx.entryId); } catch (error) { toast({ tone: "warn", message: error instanceof Error ? error.message : String(error), action: { label: i18n.t("session:navigate.openTree"), onClick: () => { useApp.getState().openSheet("session-tree", { tabId: ctx.session!.tabId, entryId: ctx.entryId }); } } }); }
} });
registerCommand({ id: "chat.forkFrom", title: "session:commands.forkFrom.title", hint: "session:commands.forkFrom.hint", slash: "/fork", group: "modes", icon: GitBranch, when: ctx => Boolean(ctx.session && ctx.entryId), run: async ctx => { if (ctx.session) try { await forkChat(ctx.session, ctx.entryId); } catch (error) { reportFailure(error); } } });

export function ComposerTools(props: { session: SessionController }) {
	const view = useSessionView(props.session);
	if (view.mode === "history" && !view.guest) return null;
	return <div className="flex min-w-0 items-center gap-1"><PermissionPill session={props.session} /><span className="min-w-0 flex-1" /><ModelButton session={props.session} /><ThinkingButton session={props.session} /></div>;
}

export function SessionModeHeader({ session }: { session: SessionController }) {
	const { t } = useTranslation("session");
	const { status } = useOmpScreen(session);
	const view = useSessionView(session);
	return <div className="flex items-center gap-1">{status && status.plan !== "off" && <Button size="sm" variant="ghost" icon={<Brain />} onClick={() => void togglePlan(session)}>{t(status.plan === "paused" ? "modes.chip.planPaused" : "modes.chip.plan")}</Button>}{view.working && <Button size="sm" variant="danger-ghost" icon={<CircleStop />} onClick={() => session.abort()}>{t("commands.stop.title")}</Button>}</div>;
}
