/** Git actions shared by the status bar, branch menu, commands and dialogs. Each reports through toasts. */
import { i18n } from "@/i18n";
import { controllerFor, focusedController, useApp } from "@/state/app";
import { dismissToast, toast } from "@/ui";
import { runInTerminal, useTerminals } from "../panes/terminal";
import { worktreeLocation } from "./format";
import { refreshGit } from "./store";

const t = i18n.t.bind(i18n);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function switchBranch(cwd: string, branch: string): Promise<void> {
	try {
		await window.vomp.invoke("git:switch", cwd, branch);
		toast({ tone: "ok", message: t("git:switch.done", { name: branch.replace(/^[^/]+\//, "") }) });
	} catch (error) {
		toast({ tone: "err", message: t("git:switch.failed"), description: errorText(error) });
	}
	refreshGit(cwd, { pr: true });
}

export async function createBranch(cwd: string, name: string): Promise<boolean> {
	try {
		await window.vomp.invoke("git:branchCreate", cwd, name);
		toast({ tone: "ok", message: t("git:newBranch.done", { name: name.trim() }) });
		refreshGit(cwd, { pr: true });
		return true;
	} catch (error) {
		toast({ tone: "err", message: t("git:newBranch.failed"), description: errorText(error) });
		return false;
	}
}

export async function initGit(cwd: string): Promise<void> {
	try {
		await window.vomp.invoke("git:init", cwd);
		toast({ tone: "ok", message: t("git:init.done") });
	} catch (error) {
		toast({ tone: "err", message: t("git:init.failed"), description: errorText(error) });
	}
	refreshGit(cwd);
}

/** Opens a chat in `path` and lists the folder in the sidebar even before it has sessions. */
async function openChatIn(path: string): Promise<void> {
	const app = useApp.getState();
	const extra = app.prefs?.extraProjects ?? [];
	if (!extra.includes(path) && !app.projects.some(project => project.path === path)) {
		await app.setPrefs({ extraProjects: [...extra, path] });
	}
	app.newChat(path);
}

/** "Work in a separate copy": `omp worktree add` next to the project, then a new chat inside it. */
export async function startWorktree(cwd: string): Promise<void> {
	const repo = await window.vomp.invoke("git:repo", cwd);
	if (!repo.isRepo || !repo.root) {
		toast({ tone: "warn", message: t("git:worktree.notRepo") });
		return;
	}
	const pending = toast({ tone: "info", message: t("git:worktree.creating"), sticky: true });
	try {
		const { path } = worktreeLocation(repo.root, new Date());
		const { worktree } = await window.vomp.invoke("git:worktreeAdd", repo.root, { path });
		await openChatIn(worktree.path);
		toast({
			tone: "ok",
			message: t("git:worktree.done"),
			description: t("git:worktree.doneDescription", { path: worktree.path, branch: worktree.branch ?? "—" }),
			sticky: true,
		});
	} catch (error) {
		toast({ tone: "err", message: t("git:worktree.failed"), description: errorText(error) });
	} finally {
		dismissToast(pending);
	}
}

/** From inside a separate copy: open a chat in the main checkout again. */
export async function backToMainCopy(cwd: string): Promise<void> {
	const main = (await window.vomp.invoke("git:worktrees", cwd)).find(entry => entry.isMain);
	if (!main) return;
	await openChatIn(main.path);
	toast({ tone: "info", message: t("git:worktree.back") });
}

/** "Fix CI": the failing checks' log summary goes to the focused chat (or a new one) as a prompt. */
export async function fixCi(cwd: string): Promise<void> {
	const pending = toast({ tone: "info", message: t("git:fixCi.loading"), sticky: true });
	try {
		const failures = await window.vomp.invoke("gh:ciFailures", cwd);
		const prompt = t("git:fixCi.prompt", { number: failures.pr, url: failures.url, summary: failures.text.trim() });
		const session = focusedController() ?? controllerFor(useApp.getState().newChat(cwd));
		if (!session) throw new Error("No chat to send to");
		await session.send(prompt);
		toast({ tone: "ok", message: t("git:fixCi.sent") });
	} catch (error) {
		toast({ tone: "err", message: t("git:fixCi.failed"), description: errorText(error) });
	} finally {
		dismissToast(pending);
	}
}

/**
 * "Connect GitHub": runs `gh auth login` in the dock terminal so the user can follow gh's steps.
 * When it succeeds the Create PR dialog comes back; until then the toast's action reopens it.
 */
export async function connectGitHub(cwd: string): Promise<void> {
	const termId = await runInTerminal(cwd, "gh auth login --hostname github.com --git-protocol https --web");
	const reopen = () => useApp.getState().openSheet("git-pr", { cwd });
	const pending = toast({
		tone: "info",
		message: t("git:createPr.terminalOpened"),
		sticky: true,
		action: { label: t("git:createPr.checkAgain"), onClick: reopen },
	});
	const stop = useTerminals.subscribe(state => {
		const tab = state.tabs.find(entry => entry.termId === termId);
		if (!tab) {
			stop();
			return;
		}
		const exitCode = tab.exitCode;
		if (exitCode === null) return;
		stop();
		if (exitCode !== 0) return;
		dismissToast(pending);
		toast({ tone: "ok", message: t("git:createPr.connected") });
		reopen();
	});
}
