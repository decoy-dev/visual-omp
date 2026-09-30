import { type FSWatcher, watch as fsWatch } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { repoPaths } from "./repo";
import { runGit } from "./run";

/** Quiet period before a burst of file events becomes one `git:changed`. */
const DEBOUNCE_MS = 300;
/** Upper bound on how long continuous writes (a build, an install) can postpone the event. */
const MAX_WAIT_MS = 2000;

/** Files inside a git dir whose change means status/branches changed. Objects, logs and locks are noise. */
const GIT_DIR_FILE_RE =
	/^(?:index|HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|packed-refs|refs\/.+|rebase-merge(?:\/.*)?|rebase-apply(?:\/.*)?)$/;

interface RepoWatch {
	root: string;
	/** Watched `cwd`s (as the renderer passed them) → reference count. */
	cwds: Map<string, number>;
	watchers: FSWatcher[];
	timer: NodeJS.Timeout | undefined;
	firstEventAt: number;
	/** Work-tree paths seen during the debounce window, checked against .gitignore before emitting. */
	paths: Set<string>;
	gitChanged: boolean;
}

const repos = new Map<string, RepoWatch>();

function toPosix(path: string): string {
	return sep === "/" ? path : path.split(sep).join("/");
}

/** `path` relative to `dir` when inside it, else null. */
function inside(dir: string, path: string): string | null {
	const rel = relative(dir, path);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
	return toPosix(rel);
}

async function flush(repo: RepoWatch, emit: (cwd: string, root: string) => void): Promise<void> {
	repo.timer = undefined;
	const paths = [...repo.paths];
	const gitChanged = repo.gitChanged;
	repo.paths.clear();
	repo.gitChanged = false;
	let relevant = gitChanged;
	if (!relevant && paths.length > 0) {
		// Exit 0 lists ignored paths, 1 means none are ignored. check-ignore rejects literal pathspecs.
		const result = await runGit(["--no-literal-pathspecs", "check-ignore", "--no-index", "-z", "--stdin"], {
			cwd: repo.root,
			input: `${paths.join("\0")}\0`,
		}).catch(() => null);
		const ignored = new Set(result?.code === 0 ? result.stdout.split("\0") : []);
		relevant = paths.some(path => !ignored.has(path));
	}
	if (!relevant || repos.get(repo.root) !== repo) return;
	for (const cwd of repo.cwds.keys()) emit(cwd, repo.root);
}

/**
 * Start watching the repo containing `cwd`. `emit` fires (debounced) when the work tree, index,
 * HEAD or refs change. Ignored files are filtered out. Reference-counted per `cwd`.
 */
export async function watchRepo(cwd: string, emit: (cwd: string, root: string) => void): Promise<void> {
	const paths = await repoPaths(cwd);
	if (!paths) throw new Error(`Not a git repository: ${cwd}`);
	const existing = repos.get(paths.root);
	if (existing) {
		existing.cwds.set(cwd, (existing.cwds.get(cwd) ?? 0) + 1);
		return;
	}
	const repo: RepoWatch = {
		root: paths.root,
		cwds: new Map([[cwd, 1]]),
		watchers: [],
		timer: undefined,
		firstEventAt: 0,
		paths: new Set(),
		gitChanged: false,
	};
	repos.set(paths.root, repo);

	const schedule = () => {
		const now = Date.now();
		if (!repo.timer) repo.firstEventAt = now;
		clearTimeout(repo.timer);
		const wait = Math.max(0, Math.min(DEBOUNCE_MS, repo.firstEventAt + MAX_WAIT_MS - now));
		repo.timer = setTimeout(() => void flush(repo, emit), wait);
	};
	const onEvent = (dir: string) => (_event: string, filename: string | Buffer | null) => {
		if (filename === null) {
			repo.gitChanged = true;
			schedule();
			return;
		}
		const absolute = `${dir}${sep}${filename.toString()}`;
		const gitRel = inside(paths.gitDir, absolute);
		const commonRel = gitRel === null ? inside(paths.commonDir, absolute) : null;
		if (gitRel !== null || commonRel !== null) {
			const rel = gitRel ?? commonRel ?? "";
			const matters = gitRel !== null ? GIT_DIR_FILE_RE.test(rel) : /^(?:refs\/.+|packed-refs)$/.test(rel);
			if (!matters || rel.endsWith(".lock")) return;
			repo.gitChanged = true;
			schedule();
			return;
		}
		const workRel = inside(paths.root, absolute);
		if (!workRel || workRel === ".git" || workRel.split("/").includes("node_modules")) return;
		repo.paths.add(workRel);
		schedule();
	};

	const add = (dir: string, recursive: boolean) => {
		const watcher = fsWatch(dir, { recursive, persistent: false }, onEvent(dir));
		watcher.on("error", () => watcher.close());
		repo.watchers.push(watcher);
	};
	add(paths.root, true);
	// Linked worktrees keep their git dir (and the shared refs) outside the work tree.
	if (inside(paths.root, paths.commonDir) === null) add(paths.commonDir, true);
}

export async function unwatchRepo(cwd: string): Promise<void> {
	const paths = await repoPaths(cwd);
	const repo = paths ? repos.get(paths.root) : [...repos.values()].find(entry => entry.cwds.has(cwd));
	if (!repo) return;
	const count = (repo.cwds.get(cwd) ?? 0) - 1;
	if (count > 0) repo.cwds.set(cwd, count);
	else repo.cwds.delete(cwd);
	if (repo.cwds.size > 0) return;
	clearTimeout(repo.timer);
	for (const watcher of repo.watchers) watcher.close();
	repos.delete(repo.root);
}
