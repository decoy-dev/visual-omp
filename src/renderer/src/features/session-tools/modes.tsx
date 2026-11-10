/** Session modes and actions for the palette, the session menu (`header` positions) and the composer permission popover. */
import { ArrowBendUpRight, ArrowsClockwise, ArrowsIn, Broom, ChatCircleDots, ClipboardText, ClockCounterClockwise, Cpu, Export, Eye, GitFork, Lightning, PencilSimple, Repeat, ShieldCheck, StopCircle, Target, TreeStructure } from "@phosphor-icons/react";
import { toast } from "@/ui";
import { registerCommand } from "../../registry/commands";
import { isResumeDeclined } from "../../registry/guards";
import { lazyView } from "../../registry/lazy";
import { sheets } from "../../registry/slots";
import { preloadWhenIdle } from "../../registry/idle";
import { useApp } from "../../state/app";
import type { SessionController } from "../../state/session";
import { i18n } from "../../i18n";
import { reportFailure, runAndReport, runCommand } from "./drive";
import { togglePlan } from "./plan";
import { parseStatusLine } from "./screen";
import { usePickerRequests } from "./pickers";
import { sessionModes, setSessionMode } from "./nativeModes";
import { exportChat } from "./export";

/** Rewind and fork parse the session file (zod schemas); that code loads with the first use (or in idle time). */
const navigation = () => import("./navigate");
preloadWhenIdle(navigation);

export interface TabProps { tabId: string; kind?: string; }

/** The mode and action dialogs load on first open or in idle time. */
const modeSheets = () => import("./ModeSheets");

sheets.register({ id: "session-text-action", component: lazyView(() => modeSheets().then(m => m.TextActionSheet)) });
sheets.register({ id: "session-goal", component: lazyView(() => modeSheets().then(m => m.GoalSheet)) });
sheets.register({ id: "session-loop", component: lazyView(() => modeSheets().then(m => m.LoopSheet)) });
sheets.register({ id: "session-auto-confirm", component: lazyView(() => modeSheets().then(m => m.AutoConfirmSheet)) });
sheets.register({ id: "session-plan-exit", component: lazyView(() => modeSheets().then(m => m.PlanExitSheet)) });

function openText(session: SessionController, kind: string): void { useApp.getState().openSheet("session-text-action", { tabId: session.tabId, kind } satisfies TabProps); }
function openGoal(session: SessionController): void { useApp.getState().openSheet("session-goal", { tabId: session.tabId }); }
function openLoop(session: SessionController): void { useApp.getState().openSheet("session-loop", { tabId: session.tabId }); }

const sessionWhen = (ctx: { session: SessionController | null }) => ctx.session !== null;

registerCommand({ id: "chat.restart", title: "session:commands.restart.title", hint: "session:commands.restart.hint", slash: "/restart", group: "modes", icon: ArrowsClockwise, header: 310, when: sessionWhen, run: async ({ session }) => { if (session) await session.restart(); } });
registerCommand({ id: "chat.compact", title: "session:commands.compact.title", hint: "session:commands.compact.hint", slash: "/compact", group: "modes", icon: ArrowsIn, header: 210, when: sessionWhen, run: ({ session }) => { if (session) openText(session, "compact"); } });
registerCommand({ id: "chat.plan", title: "session:commands.plan.title", hint: "session:commands.plan.hint", slash: "/plan", group: "modes", icon: ClipboardText, header: 220, when: sessionWhen, run: async ({ session }) => { if (session) await togglePlan(session); } });
registerCommand({ id: "chat.goal", title: "session:commands.goal.title", hint: "session:commands.goal.hint", slash: "/goal", group: "modes", icon: Target, header: 230, when: sessionWhen, run: ({ session }) => { if (session) openGoal(session); } });
registerCommand({ id: "chat.guidedGoal", title: "session:commands.guided.title", hint: "session:commands.guided.hint", slash: "/guided-goal", group: "modes", icon: ChatCircleDots, header: 240, when: sessionWhen, run: ({ session }) => { if (session) openText(session, "guided"); } });
registerCommand({ id: "chat.vibe", title: "session:commands.vibe.title", hint: "session:commands.vibe.hint", slash: "/vibe", group: "modes", icon: Lightning, header: 260, when: sessionWhen, run: async ({ session }) => {
	if (!session) return;
	try {
		const modes = await sessionModes(session);
		await setSessionMode(session, { mode: "vibe", action: modes.vibe.status === "active" ? "exit" : "enter" });
	} catch (error) { reportFailure(error); }
} });
registerCommand({ id: "chat.loop", title: "session:commands.loop.title", hint: "session:commands.loop.hint", slash: "/loop", group: "modes", icon: Repeat, header: 250, when: sessionWhen, run: ({ session }) => { if (session) openLoop(session); } });
registerCommand({ id: "chat.advisor", title: "session:commands.advisor.title", hint: "session:commands.advisor.hint", slash: "/advisor configure", group: "modes", icon: Eye, header: 270, when: sessionWhen, run: ({ session }) => {
	if (session) useApp.getState().openSheet("session-advisor", { tabId: session.tabId });
} });
registerCommand({ id: "chat.handoff", title: "session:commands.handoff.title", hint: "session:commands.handoff.hint", slash: "/handoff", group: "modes", icon: ArrowBendUpRight, header: 280, when: sessionWhen, run: ({ session }) => { if (session) openText(session, "handoff"); } });
registerCommand({ id: "chat.security", title: "session:commands.security.title", hint: "session:commands.security.hint", slash: "/security scan", group: "modes", icon: ShieldCheck, header: 285, when: sessionWhen, run: async ({ session }) => {
	if (!session) return;
	try {
		const { output } = await runCommand(session, "/security scan", { screenIntent: "request", timeoutMs: 10000, until: (_lines, out) => out.some(line => /security|scan|disabled|error/i.test(line)) });
		if (session.getSnapshot().host?.transport === "tsp") return; // Semantic notices carry the result.
		if (output.some(line => /Security is disabled/i.test(line))) { toast({ tone: "warn", message: i18n.t("session:security.disabled") }); return; }
		const result = await runCommand(session, "/security status", { timeoutMs: 10000, until: (_lines, out) => out.length > 0 });
		toast({ message: result.output.at(-1) ?? i18n.t("session:security.started") });
	} catch (error) { reportFailure(error); }
} });
registerCommand({ id: "chat.cleanse", title: "session:commands.cleanse.title", hint: "session:commands.cleanse.hint", slash: "/cleanse", group: "modes", icon: Broom, header: 290, when: sessionWhen, run: async ({ session }) => { if (session) { const result = await runAndReport(session, "/cleanse", { screenIntent: "request" }); if (session.getSnapshot().host?.transport !== "tsp" && result && !parseStatusLine(result.screen)) useApp.getState().openTerminal(session.tabId); } } });
registerCommand({ id: "chat.export", title: "session:commands.export.title", hint: "session:commands.export.hint", slash: "/export", group: "modes", icon: Export, header: 150, when: sessionWhen, run: async ({ session }) => { if (session) await exportChat(session); } });
registerCommand({ id: "chat.rename", title: "session:commands.rename.title", hint: "session:commands.rename.hint", slash: "/rename", group: "modes", icon: PencilSimple, header: 110, when: sessionWhen, run: ({ session }) => { if (session) openText(session, "rename"); } });
registerCommand({ id: "chat.stop", title: "session:commands.stop.title", hint: "session:commands.stop.hint", slash: "Esc", shortcut: "⌘.", group: "chat", icon: StopCircle, when: ctx => Boolean(ctx.session?.getSnapshot().working), run: ({ session }) => session?.abort() });
registerCommand({ id: "chat.model", title: "session:commands.model.title", hint: "session:commands.model.hint", slash: "/switch", shortcut: "⌘⇧M", group: "modes", icon: Cpu, header: 295, when: sessionWhen, run: ({ session }) => { if (session) usePickerRequests.getState().openModel(session.tabId); } });
registerCommand({ id: "chat.tree", title: "session:commands.tree.title", hint: "session:commands.tree.hint", slash: "/tree", group: "modes", icon: TreeStructure, header: 130, when: sessionWhen, run: ({ session }) => { if (session) useApp.getState().openSheet("session-tree", { tabId: session.tabId }); } });
registerCommand({ id: "chat.fork", title: "session:commands.fork.title", hint: "session:commands.fork.hint", slash: "/fork", group: "modes", icon: GitFork, header: 140, when: sessionWhen, run: async ({ session }) => { if (session) try { await (await navigation()).forkChat(session); } catch (error) { reportFailure(error); } } });
registerCommand({ id: "chat.rewindTo", title: "session:commands.rewind.title", hint: "session:commands.rewind.hint", slash: "/tree", group: "modes", icon: ClockCounterClockwise, when: ctx => Boolean(ctx.session && ctx.entryId), run: async ctx => {
	if (!ctx.session || !ctx.entryId) return;
	try { await (await navigation()).navigateTo(ctx.session, ctx.entryId); } catch (error) { if (!isResumeDeclined(error)) toast({ tone: "warn", message: error instanceof Error ? error.message : String(error), action: { label: i18n.t("session:navigate.openTree"), onClick: () => { useApp.getState().openSheet("session-tree", { tabId: ctx.session!.tabId, entryId: ctx.entryId }); } } }); }
} });
registerCommand({ id: "chat.forkFrom", title: "session:commands.forkFrom.title", hint: "session:commands.forkFrom.hint", slash: "/fork", group: "modes", icon: GitFork, when: ctx => Boolean(ctx.session && ctx.entryId), run: async ctx => { if (ctx.session) try { await (await navigation()).forkChat(ctx.session, ctx.entryId); } catch (error) { reportFailure(error); } } });
