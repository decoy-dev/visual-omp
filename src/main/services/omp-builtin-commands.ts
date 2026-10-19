/**
 * omp's builtin slash commands, taken from omp v18.12.2 (`packages/coding-agent/src/slash-commands/`
 * `builtin-*.ts` and `seance.ts`, in `builtin-registry.ts` order). omp's RPC `get_available_commands`
 * lists only the builtins that also run outside its terminal UI, so this list fills in the rest
 * (settings, tree, resume and others). Descriptions are omp's own static text. omp builds three of
 * them at runtime from key bindings (`/loop`, `/switch`, `/effort`); those name the default keys
 * here. The `/effort` and `/compact` subcommands are spelled out from omp's thinking levels and
 * compact modes.
 *
 * When omp is asked, its own entries replace these by name (`mergeSlashCommands`).
 */
import type { SlashCommandInfo } from "@shared/contracts/composer";

interface BuiltinSpec {
	name: string;
	aliases?: string[];
	description: string;
	hint?: string;
	subcommands?: { name: string; description?: string; usage?: string }[];
}

const BUILTINS: readonly BuiltinSpec[] = [
	{
		name: "security",
		description: "Plan, run, inspect, import, and compare OMP-native security scans",
		hint: "<plan|scan|status|cancel|scans|show|import|export|validate|compare|disposition>",
		subcommands: [
			{ name: "plan", description: "Create an immutable security scan plan" },
			{ name: "scan", description: "Start a planned or newly planned native scan" },
			{ name: "status", description: "Show native scan operation status" },
			{ name: "cancel", description: "Cancel a running native scan" },
			{ name: "scans", description: "List stored project security scans" },
			{ name: "show", description: "Render a scan or security:// resource" },
			{ name: "import", description: "Import SARIF or a Codex Security bundle" },
			{ name: "export", description: "Export a canonical bundle, SARIF, or report" },
			{ name: "validate", description: "Validate one finding with OMP-native tools" },
			{ name: "compare", description: "Compare finding lineage across two scans" },
			{ name: "disposition", description: "Set a finding disposition with rationale" },
		],
	},
	{ name: "settings", description: "Open settings menu" },
	{
		name: "setup",
		aliases: ["providers"],
		description: "Open provider setup",
		subcommands: [
			{ name: "providers", description: "Configure sign-in and web search providers" },
		],
	},
	{ name: "plan", description: "Toggle plan mode (agent plans before executing)", hint: "[prompt]" },
	{ name: "plan-review", description: "Re-open the plan review for the latest plan (plan mode only)" },
	{ name: "vibe", description: "Toggle vibe mode (direct persistent fast/good worker sessions; read-only toolset)", hint: "[prompt]" },
	{
		name: "goal",
		description: "Toggle goal mode (persistent autonomous objective for this session)",
		hint: "[objective]",
		subcommands: [
			{ name: "set", description: "Set or replace the goal", usage: "<objective>" },
			{ name: "show", description: "Show current goal details" },
			{ name: "pause", description: "Pause the current goal" },
			{ name: "resume", description: "Resume a paused goal" },
			{ name: "drop", description: "Drop the current goal" },
			{ name: "budget", description: "Adjust the token budget", usage: "<N|off>" },
		],
	},
	{ name: "guided-goal", description: "Have the agent interview you in chat, then set up goal mode", hint: "[rough objective]" },
	{ name: "loop", description: "Toggle loop mode. While enabled, the next prompt you send re-submits after every yield. Bound it with a count/duration, or gate it with `--until '<cmd>'` / `--while '<cmd>'`; the command's exit status decides whether the next iteration runs. Esc suspends the ongoing loop; /loop again to disable.", hint: "[count|duration] [--while|--until '<cmd>'] [prompt]" },
	{ name: "queue", description: "Queue a message for after the agent yields", hint: "<message>" },
	{ name: "model", aliases: ["models"], description: "Switch model for this session" },
	{ name: "switch", description: "Switch model for this session (same as Alt+P); accepts fuzzy ids, provider/id, @role, :level", hint: "[model]" },
	{
		name: "fast",
		description: "Toggle fast service (OpenAI service_tier=priority or ultrafast, Anthropic speed=fast, Google priority)",
		hint: "[on|ultra|off|status]",
		subcommands: [
			{ name: "on", description: "Enable fast mode (priority tier)" },
			{ name: "ultra", description: "Enable Ultrafast (OpenAI API, or Codex models that offer it)" },
			{ name: "off", description: "Disable fast mode" },
			{ name: "status", description: "Show fast mode status" },
		],
	},
	{
		name: "slow",
		description: "Toggle slow mode: flex tier on OpenAI/Google; on Anthropic, continue at low priority after the Claude session limit",
		hint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Flex tier, or Anthropic low priority at the session limit (auto)" },
			{ name: "off", description: "Standard service; stop Anthropic low priority" },
			{ name: "status", description: "Show slow mode status" },
		],
	},
	{
		name: "skillful",
		description: "Toggle listing available skills in the system prompt (session only)",
		hint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "List skills in the prompt for this session" },
			{ name: "off", description: "Omit the skills listing for this session" },
			{ name: "status", description: "Show skill listing status" },
		],
	},
	{
		name: "extended-context",
		description: "Toggle extended context windows",
		hint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Enable larger context windows" },
			{ name: "off", description: "Use default or standard-pricing context windows" },
			{ name: "status", description: "Show extended context status" },
		],
	},
	{
		name: "computer",
		description: "Toggle the native computer-use eval prelude for this session",
		hint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Enable computer use for this session" },
			{ name: "off", description: "Disable computer use for this session" },
			{ name: "status", description: "Show computer use status" },
		],
	},
	{ name: "ratchet", description: "Build (or reuse) an eval for an LLM flow, then hillclimb it unattended", hint: "[flow and goal]" },
	{
		name: "prewalk",
		description: "Arm, restart, or cancel a one-shot model handoff",
		hint: "[restart|off]",
		subcommands: [
			{ name: "restart", description: "Return to @default and re-arm the handoff to @smol" },
			{ name: "off", description: "Cancel this session's handoff without changing the active model" },
		],
	},
	{
		name: "modelpreset",
		description: "Save and switch model presets (role models + thinking level)",
		hint: "[list|save|switch|delete] [name]",
		subcommands: [
			{ name: "list", description: "List saved presets" },
			{ name: "save", description: "Save the current role models and thinking level", usage: "<name>" },
			{ name: "switch", description: "Apply a saved preset", usage: "<name>" },
			{ name: "delete", description: "Delete a saved preset", usage: "<name>" },
		],
	},
	{
		name: "effort",
		description: "Set reasoning effort (thinking level, intelligence) for this session; Shift+Tab cycles levels",
		hint: "[level]",
		subcommands: [
			{ name: "off", description: "No reasoning" },
			{ name: "minimal", description: "Very brief reasoning (~1k tokens)" },
			{ name: "low", description: "Light reasoning (~2k tokens)" },
			{ name: "medium", description: "Moderate reasoning (~8k tokens)" },
			{ name: "high", description: "Deep reasoning (~16k tokens)" },
			{ name: "xhigh", description: "Extended reasoning (~32k tokens)" },
			{ name: "max", description: "Maximum reasoning the model supports" },
			{ name: "auto", description: "Auto-detect per prompt" },
		],
	},
	{
		name: "advisor",
		description: "Toggle the advisor (a second model that reviews each turn and injects notes)",
		hint: "[on|off|status|dump [raw]|configure]",
		subcommands: [
			{ name: "on", description: "Enable the advisor" },
			{ name: "off", description: "Disable the advisor" },
			{ name: "status", description: "Show advisor status" },
			{ name: "dump", description: "Copy the advisor's transcript to clipboard", usage: "[raw]" },
			{ name: "configure", description: "Open the advisor configuration editor (TUI)" },
		],
	},
	{ name: "export", description: "Export session to HTML file", hint: "[--themes] [path]" },
	{ name: "trace", description: "Open this session's trace in the stats dashboard" },
	{
		name: "dump",
		description: "Copy session transcript to clipboard (and write LLM request JSON to tmp)",
		hint: "[all|anon]",
		subcommands: [
			{ name: "all", description: "Write a zip with the main transcript, LLM request JSON, and one file per subagent" },
			{ name: "anon", description: "Write a zip of anonymized session JSONL (contents redacted, metadata kept) plus subagents" },
		],
	},
	{ name: "share", description: "Share session via an encrypted link (share server or secret gist)" },
	{
		name: "collab",
		description: "Share this session live via a relay",
		hint: "[start|view|list|stop|status] [relayUrl]",
		subcommands: [
			{ name: "view", description: "Share a read-only link (guests can watch, not prompt)" },
			{ name: "list", description: "List active local Collab hosts (no links; use `omp collab link`)" },
			{ name: "status", description: "Show link + participants" },
			{ name: "stop", description: "Stop sharing" },
		],
	},
	{ name: "join", description: "Join a shared collab session", hint: "<link>" },
	{ name: "leave", description: "Leave the collab session" },
	{
		name: "browser",
		description: "Toggle browser eval-prelude headless vs visible mode",
		hint: "[headless|visible]",
		subcommands: [
			{ name: "headless", description: "Switch to headless mode" },
			{ name: "visible", description: "Switch to visible mode" },
		],
	},
	{ name: "copy", description: "Pick text or code from the conversation to copy" },
	{ name: "open", description: "Open the last link from the conversation in your browser (or pick one with /copy)" },
	{
		name: "todo",
		description: "View or modify the agent's todo list",
		hint: "<subcommand>",
		subcommands: [
			{ name: "edit", description: "Open todos in $EDITOR (Markdown round-trip)" },
			{ name: "copy", description: "Copy todos as Markdown to clipboard" },
			{ name: "expand", description: "Show every phase and task in the HUD" },
			{ name: "collapse", description: "Restore the bounded HUD preview" },
			{ name: "export", description: "Write todos as Markdown to a file (default: TODO.md)", usage: "[<path>]" },
			{ name: "import", description: "Replace todos from a Markdown file (default: TODO.md)", usage: "[<path>]" },
			{ name: "append", description: "Append a task; phase fuzzy-matched or auto-created", usage: "[<phase>] <task...>" },
			{ name: "start", description: "Mark task in_progress (fuzzy-matched)", usage: "<task>" },
			{ name: "done", description: "Mark task/phase/all completed (fuzzy-matched)", usage: "[<task|phase>]" },
			{ name: "drop", description: "Mark task/phase/all abandoned (fuzzy-matched)", usage: "[<task|phase>]" },
			{ name: "rm", description: "Remove task/phase/all (fuzzy-matched)", usage: "[<task|phase>]" },
		],
	},
	{
		name: "session",
		description: "Session management commands",
		hint: "[info|delete|pin [account]]",
		subcommands: [
			{ name: "info", description: "Show session info and stats" },
			{ name: "delete", description: "Delete current session and return to selector" },
			{ name: "pin", description: "Pin a stored OAuth account to the current provider for this session", usage: "[account]" },
		],
	},
	{
		name: "jobs",
		description: "Show async background jobs status",
		hint: "[full|kill <id>|kill all]",
		subcommands: [
			{ name: "full", description: "Show full, untruncated command lines" },
			{ name: "kill", description: "Cancel a running background job", usage: "<id>|all" },
		],
	},
	{
		name: "usage",
		description: "Show provider usage and limits",
		hint: "[show|reset [provider/credential-id|provider/active]]",
		subcommands: [
			{ name: "show", description: "Show provider usage and limits" },
			{ name: "reset", description: "Spend a saved provider rate-limit reset", usage: "[provider/credential-id|provider/active]" },
		],
	},
	{ name: "stats", description: "Launch the local stats dashboard", hint: "[--port <port>] [--host <host>]" },
	{
		name: "changelog",
		description: "Show changelog entries",
		hint: "[full|last [N]]",
		subcommands: [
			{ name: "full", description: "Show complete changelog" },
			{ name: "last", description: "Show the last N releases (default 1)", usage: "[N]" },
		],
	},
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "tools", description: "Show tools currently visible to the agent" },
	{ name: "context", description: "Show estimated context usage breakdown" },
	{ name: "extensions", aliases: ["status"], description: "Open Extension Control Center dashboard" },
	{ name: "agents", description: "Open the agents hub (per-agent model, prewalk, and advisor)" },
	{ name: "git", description: "Open the git UI (split diff viewer, staging, commit composer)", hint: "[revision]" },
	{ name: "hub", description: "Open the live Agent Hub" },
	{ name: "branch", aliases: ["rewind"], description: "Rewind to a previous message, keeping the old path as a branch" },
	{
		name: "fork",
		description: "Fork this session, or open it in a multiplexer pane or window",
		subcommands: [
			{ name: "pane", description: "Open the fork in a new terminal pane" },
			{ name: "window", description: "Open the fork in a new multiplexer window" },
			{ name: "tab", description: "Alias for window" },
		],
	},
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "login", description: "Login with OAuth provider", hint: "[provider|redirect URL]" },
	{ name: "logout", description: "Logout from OAuth provider", hint: "[provider]" },
	{
		name: "mcp",
		description: "Manage MCP servers (add, list, remove, test)",
		hint: "<subcommand>",
		subcommands: [
			{ name: "add", description: "Add a new MCP server", usage: "<name> [--scope project|user] [--url <url>] [-- <command...>]" },
			{ name: "list", description: "List all configured MCP servers" },
			{ name: "remove", description: "Remove an MCP server", usage: "<name> [--scope project|user]" },
			{ name: "test", description: "Test connection to a server", usage: "<name>" },
			{ name: "reauth", description: "Reauthorize OAuth for a server", usage: "<name>" },
			{ name: "unauth", description: "Remove OAuth auth from a server", usage: "<name>" },
			{ name: "enable", description: "Enable an MCP server", usage: "<name>" },
			{ name: "disable", description: "Disable an MCP server", usage: "<name>" },
			{ name: "smithery-search", description: "Search Smithery registry and deploy an MCP server", usage: "<keyword> [--scope project|user] [--limit <1-100>] [--semantic]" },
			{ name: "smithery-login", description: "Login to Smithery and cache API key" },
			{ name: "smithery-logout", description: "Remove cached Smithery API key" },
			{ name: "reconnect", description: "Reconnect to a specific MCP server", usage: "<name>" },
			{ name: "reload", description: "Force reload MCP runtime tools" },
			{ name: "resources", description: "List available resources from connected servers" },
			{ name: "prompts", description: "List available prompts from connected servers" },
			{ name: "notifications", description: "Show notification capabilities and subscriptions" },
			{ name: "help", description: "Show help message" },
		],
	},
	{
		name: "ssh",
		description: "Manage SSH hosts (add, list, remove)",
		hint: "<subcommand>",
		subcommands: [
			{ name: "add", description: "Add an SSH host", usage: "<name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>] [--scope project|user]" },
			{ name: "list", description: "List all configured SSH hosts" },
			{ name: "remove", description: "Remove an SSH host", usage: "<name> [--scope project|user]" },
			{ name: "help", description: "Show help message" },
		],
	},
	{ name: "new", description: "Start a new session" },
	{ name: "fresh", description: "Reset provider stream state without changing the local transcript" },
	{ name: "clear", description: "Clear the conversation context in place, keeping the session" },
	{ name: "delete", description: "Delete the current session and start a new one" },
	{
		name: "compact",
		description: "Manually compact the session context",
		hint: "[soft|remote|snapcompact] [focus]",
		subcommands: [
			{ name: "soft", description: "Summarize locally with the active model (skip server compaction)", usage: "[focus]" },
			{ name: "remote", description: "Summarize via OpenAI-compatible server compaction, then fall back to a local summary", usage: "[focus]" },
			{ name: "snapcompact", description: "Archive history onto dense bitmap images the model reads back (no LLM call)" },
		],
	},
	{
		name: "shake",
		description: "Drop heavy content from context (tool results, large blocks)",
		hint: "[elide|images|thinking]",
		subcommands: [
			{ name: "elide", description: "Strip tool results + large blocks (default)" },
			{ name: "images", description: "Strip image blocks" },
			{ name: "thinking", description: "Drop all thinking blocks" },
		],
	},
	{ name: "handoff", description: "Summarize the session into a handoff document and compact in place", hint: "[focus instructions]" },
	{ name: "seance", description: "Consult a saved session without resuming it", hint: "[session id|path] [--model selector]" },
	{ name: "resume", description: "Resume a different session", hint: "[session id|@claude|@codex]" },
	{ name: "pin", description: "Pin or unpin a session at the top of the resume list", hint: "[session id]" },
	{ name: "btw", description: "Ask a side question, or browse this session's BTW history", hint: "[question]" },
	{ name: "tan", description: "Run a full background agent on tangential work", hint: "<work>" },
	{ name: "omfg", description: "Forge a TTSR rule from a complaint to stop a recurring behavior", hint: "<complaint>" },
	{ name: "cleanse", description: "Detect and fix project diagnostics with weighted parallel subagents", hint: "[request] [--all]" },
	{ name: "retry", description: "Retry the last failed agent turn" },
	{ name: "debug", description: "Open debug tools selector" },
	{
		name: "memory",
		description: "Inspect and operate memory maintenance",
		hint: "<subcommand>",
		subcommands: [
			{ name: "view", description: "Show current memory injection payload" },
			{ name: "stats", description: "Show memory backend statistics" },
			{ name: "diagnose", description: "Run memory backend diagnostics" },
			{ name: "queue", description: "Show pending memory deltas awaiting consolidation" },
			{ name: "sync", description: "Run memory consolidation now" },
			{ name: "clear", description: "Clear persisted memory data and artifacts" },
			{ name: "reset", description: "Alias for clear" },
			{ name: "enqueue", description: "Enqueue memory consolidation maintenance" },
			{ name: "rebuild", description: "Alias for enqueue" },
			{ name: "mm list", description: "List mental models on the active bank" },
			{ name: "mm show", description: "Show one mental model (id required)" },
			{ name: "mm refresh", description: "Refresh auto-refresh models bank-wide, or one model by id" },
			{ name: "mm history", description: "Diff the change history of a mental model" },
			{ name: "mm seed", description: "Create any built-in mental models that are missing" },
			{ name: "mm delete", description: "Delete a mental model from the bank (id required)" },
			{ name: "mm reload", description: "Re-pull the cached <mental_models> block" },
		],
	},
	{ name: "rename", description: "Rename the current session (omit title to generate)", hint: "[title]" },
	{ name: "move", description: "Move the current session to a different directory", hint: "[<path>]" },
	{ name: "wt", aliases: ["worktree"], description: "Move this session into a new worktree, changes included", hint: "[<branch>]" },
	{ name: "add-dir", description: "Add a workspace directory to this session (multi-root)", hint: "<path>" },
	{ name: "remove-dir", description: "Remove a workspace directory from this session", hint: "<path>" },
	{ name: "dirs", description: "List this session's workspace directories" },
	{ name: "exit", description: "Exit the application" },
	{ name: "restart", description: "Restart omp with the same launch flags, resuming this session" },
	{
		name: "marketplace",
		description: "Manage marketplace plugin sources and installed plugins",
		hint: "<subcommand>",
		subcommands: [
			{ name: "add", description: "Add a marketplace source", usage: "<source>" },
			{ name: "remove", description: "Remove a marketplace source", usage: "<name>" },
			{ name: "update", description: "Update marketplace catalog(s)", usage: "[name]" },
			{ name: "list", description: "List configured marketplaces" },
			{ name: "discover", description: "Browse available plugins", usage: "[marketplace]" },
			{ name: "install", description: "Install a plugin (interactive browser if no args)", usage: "[--force] [name@marketplace]" },
			{ name: "uninstall", description: "Uninstall a plugin (selector if no args)", usage: "[name@marketplace]" },
			{ name: "installed", description: "List installed marketplace plugins" },
			{ name: "upgrade", description: "Upgrade outdated plugins", usage: "[name@marketplace]" },
			{ name: "help", description: "Show usage guide" },
		],
	},
	{
		name: "plugins",
		aliases: ["plugin"],
		description: "View and manage installed plugins",
		hint: "[list|enable|disable]",
		subcommands: [
			{ name: "list", description: "List all installed plugins (npm + marketplace)" },
			{ name: "enable", description: "Enable an installed plugin", usage: "<plugin>" },
			{ name: "disable", description: "Disable an installed plugin", usage: "<plugin>" },
		],
	},
	{ name: "reload-plugins", description: "Reload all plugins (skills, commands, hooks, tools, agents, MCP)" },
	{
		name: "skills",
		description: "Search, install, and update skills from the skills.omp.sh registry",
		subcommands: [
			{ name: "search", description: "Search the skill registry", usage: "<query>" },
			{ name: "install", description: "Install registry skills", usage: "<@scope/name[@range]>… [--global]" },
			{ name: "installed", description: "List installed registry skills" },
			{ name: "update", description: "Update registry skills within their ranges", usage: "[@scope/name…] [--global]" },
		],
	},
	{ name: "force", aliases: ["force:"], description: "Force next turn to use a specific tool", hint: "<tool-name> [prompt]" },
	{ name: "live", description: "Start Codex-backed realtime voice mode" },
	{ name: "record", description: "Start or stop recording this screen to a replayable file (omp play)" },
	{ name: "pause", description: "Freeze all agents (main, subagents, advisor) until resumed" },
	{ name: "quit", aliases: ["q"], description: "Quit the application" },
];

export const OMP_BUILTIN_COMMANDS: readonly SlashCommandInfo[] = BUILTINS.map(spec => ({
	name: spec.name,
	aliases: spec.aliases ?? [],
	description: spec.description,
	hint: spec.hint ?? null,
	subcommands: (spec.subcommands ?? []).map(sub => ({ name: sub.name, description: sub.description ?? null, usage: sub.usage ?? null })),
	source: "builtin",
}));

/**
 * The project's command list: the static builtins first, in omp's order, then builtins omp lists that
 * this catalog lacks (a newer omp), then omp's skill, extension, custom, MCP prompt and file commands.
 * A builtin the catalog knows keeps the catalog's entry: RPC sends the description, hint and
 * subcommands written for ACP clients ("Show current model selection" and `[selector]` for `/model`),
 * while chats here run omp's terminal UI, where `/model` opens the model hub and an argument goes to
 * the model as a prompt. A dynamic command that shares a builtin's name or alias is dropped, because
 * omp's terminal UI runs the builtin first and the dynamic one can't be reached.
 */
export function mergeSlashCommands(builtins: readonly SlashCommandInfo[], rpc: readonly SlashCommandInfo[]): SlashCommandInfo[] {
	const known = new Set(builtins.map(command => command.name));
	const merged = [...builtins, ...rpc.filter(command => command.source === "builtin" && !known.has(command.name))];
	const reserved = new Set(merged.flatMap(command => [command.name, ...command.aliases]));
	for (const command of rpc) {
		if (command.source === "builtin" || reserved.has(command.name)) continue;
		reserved.add(command.name);
		merged.push(command);
	}
	return merged;
}
