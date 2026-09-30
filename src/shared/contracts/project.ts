/**
 * Project folders (create / add / remove / recent) and the files omp reads as project
 * instructions: context files (AGENTS.md, CLAUDE.md, …), the sticky `.omp/RULES.md`, and rule files.
 */
import type { ProjectSummary } from "../ipc";

/**
 * Why a project folder name was rejected (stable codes for i18n):
 * - `empty`: blank after trimming.
 * - `tooLong`: more than 255 UTF-8 bytes.
 * - `invalidChars`: contains `/ \ : * ? " < > |` or control characters.
 * - `reserved`: `.`/`..` or a Windows device name (CON, NUL, COM1, …).
 * - `trailingDotOrSpace`: ends with `.` or a space (Windows cannot open it).
 * - `notDirectory`: the target path exists and is a file.
 * - `notEmpty`: the target folder already exists and contains files.
 */
export type ProjectNameProblem =
	| "empty"
	| "tooLong"
	| "invalidChars"
	| "reserved"
	| "trailingDotOrSpace"
	| "notDirectory"
	| "notEmpty";

export interface ProjectNameCheck {
	ok: boolean;
	problem: ProjectNameProblem | null;
	/** Absolute folder path that would be created (`<parentDir>/<trimmed name>`). */
	path: string;
	/** The folder already exists but is empty; creating it just adopts it. */
	existsEmpty: boolean;
}

export interface ProjectCreateOptions {
	name: string;
	/** Parent directory; default `~/Projects` (created when missing). */
	parentDir?: string;
}

export type ProjectCreateResult = { ok: true; path: string } | { ok: false; problem: ProjectNameProblem; path: string };

export interface RecentFolder {
	path: string;
	name: string;
	/** Epoch ms: latest of "opened in the app" and newest session activity. */
	lastUsed: number;
	sessionCount: number;
	exists: boolean;
	/** Registered in prefs `extraProjects` (removable via `project:remove`). */
	registered: boolean;
}

/**
 * omp discovery provider that owns a project context file, in omp's priority order
 * (see oh-my-pi docs/context-files.md): native 100 > claude 80 > agents 70 > gemini 60 >
 * github 30 > agents-md 10 = claude-md 10.
 */
export type InstructionsProvider = "native" | "claude" | "agents" | "gemini" | "github" | "agents-md" | "claude-md";

/** A project-root instruction file omp would discover when a session starts in this folder. */
export interface InstructionFile {
	provider: InstructionsProvider;
	/** Path relative to the project, `/`-separated (e.g. `.omp/AGENTS.md`, `AGENTS.md`). */
	relPath: string;
	path: string;
	exists: boolean;
	/** File content; null when the file does not exist. */
	content: string | null;
	/**
	 * `context`: injected into the opening project context; at the project root only the
	 * highest-priority non-empty context file is loaded, the rest are shadowed.
	 * `sticky`: `.omp/RULES.md`, an always-apply rule carried on every request.
	 */
	kind: "context" | "sticky";
	/** omp loads this file for sessions started at the project root. */
	active: boolean;
}

export interface ProjectInstructions {
	projectDir: string;
	/** Every candidate location, existing or not, in omp priority order (sticky RULES.md last). */
	files: InstructionFile[];
	/** The context file omp loads at the project root; null when none has content. */
	activeRelPath: string | null;
	/**
	 * The file an "Instructions" editor should open: the active context file, else the first
	 * existing one, else `AGENTS.md` (read by omp and most other agent tools).
	 */
	primaryRelPath: string;
}

/** omp-compatible tool whose rule files were found in the project. Only `omp` rules are editable here. */
export type RuleSource = "omp" | "agents" | "cursor" | "windsurf" | "cline" | "github";

export interface ProjectRule {
	/** Rule identity in omp (filename without `.md`/`.mdc`; `.instructions.md` for GitHub). */
	name: string;
	source: RuleSource;
	path: string;
	relPath: string;
	/** True for `.omp/rules/*` — writable via `project:rules:write` / `project:rules:delete`. */
	editable: boolean;
	description: string | null;
	/** File globs the rule applies to (`globs`, or GitHub `applyTo`). */
	globs: string[];
	alwaysApply: boolean;
	/** False when frontmatter has `enabled: false`, which makes omp skip the rule. */
	enabled: boolean;
	/** Markdown body without frontmatter. */
	body: string;
	/** Raw file content. */
	content: string;
	/** Why the YAML frontmatter failed to parse (fields then come from omp's line-by-line fallback). */
	frontmatterError: string | null;
}

/**
 * Fields for a `.omp/rules/<name>.md` rule. Optional fields left `undefined` keep their current
 * value; `description: null`/`""`, `globs: []` and `alwaysApply: false` remove the key. Other
 * frontmatter keys already in the file (condition, scope, agents, …) and YAML comments are
 * preserved; frontmatter that is not valid YAML is replaced.
 */
export interface RuleDraft {
	/** Letters, digits, `.`, `_`, `-`; a trailing `.md`/`.mdc` is ignored. */
	name: string;
	description?: string | null;
	globs?: string[];
	alwaysApply?: boolean;
	/** `false` writes `enabled: false` (omp skips the rule); `true` removes the key. */
	enabled?: boolean;
	body: string;
}

declare module "../ipc" {
	interface IpcInvokeMap {
		/** Default parent directory for new projects (`~/Projects`). */
		"project:defaults": { args: []; result: { parentDir: string } };
		/** Validate a new project folder name (live, as the user types). */
		"project:checkName": { args: [name: string, parentDir?: string]; result: ProjectNameCheck };
		/**
		 * Create an empty project folder (adopting an existing empty one), register it in prefs
		 * `extraProjects` and in recent folders. Refuses names that fail `project:checkName`.
		 */
		"project:create": { args: [options: ProjectCreateOptions]; result: ProjectCreateResult };
		/** Register an existing folder as a project (prefs `extraProjects` + recent + OS recent documents). Rejects if not a directory. */
		"project:add": { args: [path: string]; result: ProjectSummary };
		/**
		 * Forget a folder: removes it from `extraProjects`, `pinnedProjects` and recent folders.
		 * Folders that still have saved omp sessions keep appearing in `sessions:projects` until
		 * those sessions are archived. Never touches the folder on disk.
		 */
		"project:remove": { args: [path: string]; result: void };
		/** Recently used project folders (opened in the app or with session activity), newest first. */
		"project:recent": { args: [limit?: number]; result: RecentFolder[] };
		/** Project-root instruction files with content, which one omp loads, and which to edit. */
		"project:instructions": { args: [projectDir: string]; result: ProjectInstructions };
		/**
		 * Atomically write one instruction file; `relPath` must be one of the candidates listed by
		 * `project:instructions`. Returns the refreshed view. New/changed files apply to the next
		 * session start (or `/new`).
		 */
		"project:instructions:write": {
			args: [projectDir: string, relPath: string, content: string];
			result: ProjectInstructions;
		};
		/** Rule files at the project root: `.omp/rules` plus other tools' conventions omp also reads. */
		"project:rules": { args: [projectDir: string]; result: ProjectRule[] };
		/** Create or update `.omp/rules/<name>.md` (keeps an existing `.mdc` extension). Returns the refreshed list. */
		"project:rules:write": { args: [projectDir: string, draft: RuleDraft]; result: ProjectRule[] };
		/** Delete `.omp/rules/<name>.{md,mdc}`. Returns the refreshed list. */
		"project:rules:delete": { args: [projectDir: string, name: string]; result: ProjectRule[] };
	}
}
