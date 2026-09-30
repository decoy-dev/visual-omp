/**
 * Recognising omp's own full-screen screens from their painted text (`host:screen` lines).
 *
 * - `screenName` gives the terminal sheet a title users recognise ("Settings", "Pick a session").
 * - Features that draw an omp screen natively (Plan Review, questions…) register a matcher with
 *   `registerNativeOverlay`, so the terminal sheet does not pop open on top of their UI.
 *
 * Titles are painted inset into the screen's top rule (`╭─ Settings ───╮`); the corner glyphs vary
 * by theme, so matching keys on "a horizontal rule, then the title".
 */

export type ScreenKey =
	| "settings"
	| "models"
	| "switchModel"
	| "tree"
	| "summarizeBranch"
	| "resume"
	| "importSession"
	| "deleteSession"
	| "rewind"
	| "copy"
	| "login"
	| "logout"
	| "account"
	| "usage"
	| "usageReset"
	| "extensions"
	| "agentHub"
	| "agents"
	| "advisor"
	| "sessionInfo"
	| "planReview"
	| "exitPlan"
	| "plugins"
	| "mcpAdd"
	| "history"
	| "debug"
	| "git"
	| "setup"
	| "pause"
	| "move"
	| "btw"
	| "annotate"
	| "goal"
	| "ask";

const RULE = "[\\u2500\\u2501\\u2504\\u2505\\u2508\\u2509\\u254C\\u254D\\u2550]";

/** A title inset in a horizontal rule: `─ Title ─`, `─ Title (…)`, `─ Title · …`. */
function boxed(title: string): RegExp {
	const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`${RULE}\\s*${escaped}(?=$|\\s|${RULE}|[(·])`);
}

/** Most specific first: the first pattern found on screen names it. */
const SCREENS: ReadonlyArray<readonly [ScreenKey, RegExp]> = [
	["planReview", boxed("Plan Review")],
	["resume", boxed("Resume Session")],
	["importSession", /Import \S+ Session/],
	["deleteSession", /This will permanently delete the current session/],
	["tree", boxed("Session Tree")],
	["summarizeBranch", /Summarize branch\?/],
	["sessionInfo", boxed("Session Info")],
	["switchModel", /Switch (Task )?Model/],
	["rewind", /pick the point to continue from/],
	["copy", /pick what to put on the clipboard/],
	["login", /Select provider to login|Login to \S/],
	["logout", /Select provider to logout|account to log out/],
	["account", /account for this session/],
	["usageReset", /Spend a saved rate-limit reset/],
	["extensions", /Extension Control Center/],
	["agentHub", /Agent Hub/],
	["advisor", /Advisor configuration/],
	["exitPlan", /Exit plan mode\?/],
	["mcpAdd", /Add MCP Server/],
	["debug", /Debug Tools|Recent Logs|Raw Provider Stream/],
	["git", / (Un)?[Ss]tage File |no file selected/],
	["setup", /Sign in to your providers|Setup step \d/],
	["pause", /P A U S E D/],
	["move", /Move to directory/],
	["btw", /BTW history/],
	["annotate", /Code Review|Annotate Text/],
	["goal", /Goal objective/],
	["settings", boxed("Settings")],
	["models", boxed("Models")],
	["usage", boxed("Usage")],
	["agents", boxed("Agents")],
	["plugins", boxed("Plugins")],
	["history", boxed("History")],
	["ask", boxed("Ask")],
];

/** Which omp screen is showing, or null when it is not one we know by name. */
export function screenName(lines: readonly string[]): ScreenKey | null {
	for (const [key, pattern] of SCREENS) {
		if (lines.some(line => pattern.test(line))) return key;
	}
	return null;
}

const nativeMatchers: Array<(lines: string[]) => boolean> = [];

/** Declare an omp screen your feature draws natively; the terminal sheet then stays closed for it. */
export function registerNativeOverlay(match: (lines: string[]) => boolean): void {
	nativeMatchers.push(match);
}

export function isNativeOverlay(lines: string[]): boolean {
	return nativeMatchers.some(match => {
		try {
			return match(lines);
		} catch {
			return false;
		}
	});
}
