/**
 * Slash commands typed in the composer or the palette's ask row.
 *
 * `slashCommands` lists what omp accepts in a project (main's `composer:slashCommands`) for the
 * composer's slash menu. `routeSlash` decides, before anything reaches omp, whether a line opens the
 * app's own UI for it (Settings, the session tree, the model picker…) or is refused because it would
 * break how visual-omp hosts omp (the collab room, moving the session, multiplexer forks). Everything
 * else is typed into omp (`sendSlashCommand`). The rows follow the routing matrix in docs/COMMANDS.md.
 */
import type { SlashCommandListing } from "@shared/contracts/composer";
import type { SkillsSectionProps } from "../extensions/skills/model";
import { toast } from "@/ui";
import { i18n } from "../../i18n";
import type { CommandContext } from "../../registry/commands";
import { focusChatSearch } from "../../shell/Sidebar";
import { useApp } from "../../state/app";
import { openSettings, type SettingsSectionId } from "../../state/navigation";
import type { SessionController } from "../../state/session";
import { runCommand } from "../palette/run";
import { usePickerRequests } from "./pickers";
import { setSessionMode } from "./nativeModes";
import { reportFailure } from "./drive";

// ─── Catalog ───────────────────────────────────────────────────────────────

/** Requests in flight per project; main keeps omp's answers (and drops them on app events). */
const inFlight = new Map<string, Promise<SlashCommandListing>>();

/** Typed lines that can change omp's command list (MCP prompts, skills, plugin commands). */
const CHANGES_COMMANDS: ReadonlySet<string> = new Set(["mcp", "skills", "plugins", "plugin", "marketplace", "reload-plugins"]);

/**
 * When such a line last ran per project. Listings ask omp again for a minute afterwards, because the
 * command may still be installing or reconnecting when the menu opens next.
 */
const changedAt = new Map<string, number>();
const CHANGE_WINDOW_MS = 60_000;

/**
 * Every slash command omp accepts in `projectPath` (builtins first). `complete` is false when omp
 * couldn't be asked; main keeps no such answer, so the next call asks again.
 */
export function slashCommands(projectPath: string): Promise<SlashCommandListing> {
	const pending = inFlight.get(projectPath);
	if (pending) return pending;
	const since = changedAt.get(projectPath);
	const fresh = since !== undefined && Date.now() - since < CHANGE_WINDOW_MS;
	if (!fresh) changedAt.delete(projectPath);
	const started = window.vomp.invoke("composer:slashCommands", projectPath, fresh).finally(() => {
		if (inFlight.get(projectPath) === started) inFlight.delete(projectPath);
	});
	inFlight.set(projectPath, started);
	return started;
}

/**
 * Split a line the way omp does: the name ends at the first whitespace or `:` (`/force:bash` is
 * `/force bash`). Null when the line is not a slash command.
 */
export function parseSlash(line: string): { name: string; args: string } | null {
	const text = line.trim();
	if (!text.startsWith("/") || text.length < 2) return null;
	const body = text.slice(1);
	const end = body.search(/[\s:]/);
	return end === -1 ? { name: body, args: "" } : { name: body.slice(0, end), args: body.slice(end + 1).trim() };
}

// ─── Routing ───────────────────────────────────────────────────────────────

/** Handles a parsed line; true when it was taken care of and must not reach omp. */
type Route = (args: string, session: SessionController, typed: string) => boolean;

const contextOf = (session: SessionController): CommandContext => ({ session, projectPath: session.projectPath });

/** Run a registered app command; false (send to omp) when it isn't available here. */
const command = (id: string) => (session: SessionController) => runCommand(id, contextOf(session));

/** `action` for the bare command, or for one of `forms` (case-insensitive) as its only argument. */
function bare(action: (session: SessionController) => boolean, ...forms: string[]): Route {
	return (args, session) => (args === "" || forms.includes(args.toLowerCase())) && action(session);
}

type GuardReason = "collab" | "join" | "forkTerminal";

/** Refuse the line with a toast that says why and, when there is one, offers the app's way to do it. */
function refuse(reason: GuardReason, typed: string, offer?: () => void): true {
	toast({
		tone: "warn",
		message: i18n.t("composer:slash.guard.notSent", { command: typed }),
		description: i18n.t(`composer:slash.guard.${reason}`),
		action: offer ? { label: i18n.t(`composer:slash.guard.${reason}Action`), onClick: offer } : undefined,
	});
	return true;
}

const hostingGuard = (session: SessionController, typed: string) =>
	refuse("collab", typed, () => useApp.getState().openSheet("share", { tabId: session.tabId, tab: "invite" }));

/**
 * `/collab list` and `/collab status` only report. Everything else starts, restarts or stops the room
 * the app's mirror is joined to: bare `/collab`, `start`, `view`, `stop`, and a relay URL, which omp
 * treats as `start <url>`.
 */
const collabGuard: Route = (args, session, typed) => {
	const verb = args.split(/\s+/)[0]?.toLowerCase() ?? "";
	return verb !== "list" && verb !== "status" && hostingGuard(session, typed);
};

const settingsSection =
	(section: SettingsSectionId, sectionProps?: unknown) =>
	(session: SessionController): boolean => {
		openSettings(section, { projectPath: session.projectPath, sectionProps });
		return true;
	};

const plugins = bare(settingsSection("skills", { tab: "plugins" } satisfies SkillsSectionProps), "install");

/** `/delete`: the sidebar's move-to-trash confirmation for this chat. */
function trash(session: SessionController): boolean {
	if (session.sessionFile) {
		useApp.getState().openSheet("chat-trash", { tabId: session.tabId });
		return true;
	}
	toast({ message: i18n.t("composer:slash.guard.unsaved"), description: i18n.t("composer:slash.guard.unsavedBody") });
	return true;
}

const ROUTES: Record<string, Route> = {
	settings: bare(command("app.settings")),
	setup: bare(command("manage.providers"), "providers"),
	providers: bare(command("manage.providers"), "providers"),
	login: bare(command("manage.providers")),
	logout: bare(command("manage.providers")),
	model: bare(command("manage.roles")),
	models: bare(command("manage.roles")),
	modelpreset: bare(command("manage.roles")),
	switch: bare(command("chat.model")),
	effort: bare(session => {
		usePickerRequests.getState().openThinking(session.tabId);
		return true;
	}),
	usage: bare(command("manage.usage"), "show"),
	agents: bare(command("manage.agents")),
	mcp: bare(command("manage.mcp"), "add"),
	skills: bare(command("manage.skills"), "help"),
	plugins,
	plugin: plugins,
	marketplace: plugins,
	memory: bare(command("manage.memory"), "view"),
	tree: bare(command("chat.tree")),
	branch: bare(command("chat.tree")),
	rewind: bare(command("chat.tree")),
	goal: bare(command("chat.goal")),
	loop: bare(command("chat.loop")),
	plan: bare(command("chat.plan")),
	vibe: bare(command("chat.vibe")),
	advisor: (args, session) => args.toLowerCase() === "configure" && runCommand("chat.advisor", contextOf(session)),
	new: bare(command("chat.new")),
	share: bare(command("chat.share")),
	export: bare(command("chat.export")),
	hotkeys: bare(settingsSection("shortcuts")),
	fork: (args, session, typed) => {
		if (args === "") return runCommand("chat.fork", contextOf(session));
		const target = args.split(/\s+/)[0]?.toLowerCase() ?? "";
		if (!["pane", "window", "tab"].includes(target)) return false;
		return refuse("forkTerminal", typed, () => runCommand("chat.fork", contextOf(session)));
	},
	git: bare(command("panes.show.diff")),
	hub: bare(command("panes.show.tasks")),
	subagents: bare(command("panes.show.tasks")),
	jobs: bare(command("panes.show.tasks")),
	restart: bare(command("chat.restart")),
	exit: bare(command("chat.close")),
	quit: bare(command("chat.close")),
	q: bare(command("chat.close")),
	delete: bare(trash),
	session: (args, session) => args.toLowerCase() === "delete" && trash(session),
	resume: bare(() => {
		focusChatSearch();
		return true;
	}),
	collab: collabGuard,
	join: (_args, _session, typed) => refuse("join", typed),
	leave: (_args, session, typed) => hostingGuard(session, typed),
};

/**
 * Handle `line` in the app when the routing matrix has a native or guarded row for it. Resolves true
 * when the line was handled and must not be sent; false for everything omp should run itself,
 * including argument forms the matrix leaves to omp (`/fast on`, `/goal budget`).
 */
export async function routeSlash(session: SessionController, line: string): Promise<boolean> {
	const parsed = parseSlash(line);
	if (!parsed) return false;
	if (parsed.name === "goal" && ["pause", "resume", "drop"].includes(parsed.args)) {
		try { await setSessionMode(session, { mode: "goal", action: parsed.args as "pause" | "resume" | "drop" }); }
		catch (error) { reportFailure(error); }
		return true;
	}
	const handled = Object.hasOwn(ROUTES, parsed.name) && (ROUTES[parsed.name]?.(parsed.args, session, `/${parsed.name}`) ?? false);
	if (!handled && CHANGES_COMMANDS.has(parsed.name)) changedAt.set(session.projectPath, Date.now());
	return handled;
}
