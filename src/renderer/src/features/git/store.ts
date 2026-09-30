/**
 * Live git state per project folder, shared by the status-bar items and the git dialogs. A tracker
 * starts when the first component for a folder mounts (`useGit`) and stops with the last one: it
 * watches the repo (`git:watch` → `git:changed`), re-reads status on every change, and follows the
 * branch's pull request, polling its checks every minute while one exists.
 */
import type { GhPullRequest, GitRepoInfo, GitStatus } from "@shared/contracts/git";
import { useEffect, useSyncExternalStore } from "react";

export interface GitView {
	/** First load still running. */
	loading: boolean;
	repo: GitRepoInfo | null;
	status: GitStatus | null;
	/** The current branch's PR; null when there is none (or GitHub can't be asked). */
	pr: GhPullRequest | null;
	error: string | null;
}

const PR_POLL_MS = 60_000;
/** Bursts of file events (an omp edit, a checkout) collapse into one status read. */
const CHANGE_DEBOUNCE_MS = 250;

const INITIAL: GitView = { loading: true, repo: null, status: null, pr: null, error: null };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

class GitTracker {
	#view: GitView = INITIAL;
	#listeners = new Set<() => void>();
	#refs = 0;
	#watching = false;
	#changeTimer: number | null = null;
	#prTimer: number | null = null;
	/** Branch the PR lookup last ran for, and when; git events re-ask at most once a minute. */
	#prBranch: string | null = null;
	#prCheckedAt = 0;
	#seq = 0;

	constructor(readonly cwd: string) {}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = (): GitView => this.#view;

	#set(patch: Partial<GitView>): void {
		this.#view = { ...this.#view, ...patch };
		for (const listener of this.#listeners) listener();
	}

	acquire(): void {
		this.#refs++;
		if (this.#refs > 1) return;
		void this.refresh();
	}

	release(): void {
		this.#refs = Math.max(0, this.#refs - 1);
		if (this.#refs > 0) return;
		if (this.#watching) void window.vomp.invoke("git:unwatch", this.cwd).catch(() => {});
		this.#watching = false;
		if (this.#changeTimer !== null) window.clearTimeout(this.#changeTimer);
		this.#changeTimer = null;
		this.#stopPrPoll();
		this.#prBranch = null;
		this.#view = INITIAL;
	}

	/** Called for `git:changed`. */
	changed(): void {
		if (this.#changeTimer !== null) window.clearTimeout(this.#changeTimer);
		this.#changeTimer = window.setTimeout(() => {
			this.#changeTimer = null;
			void this.refresh();
		}, CHANGE_DEBOUNCE_MS);
	}

	/** Re-read repo info and status; follows up with the PR when the branch changed or a minute passed. */
	async refresh(): Promise<void> {
		const seq = ++this.#seq;
		try {
			const repo = await window.vomp.invoke("git:repo", this.cwd);
			if (seq !== this.#seq || this.#refs === 0) return;
			if (!repo.isRepo) {
				this.#stopPrPoll();
				this.#set({ loading: false, repo, status: null, pr: null, error: null });
				return;
			}
			if (!this.#watching) {
				this.#watching = true;
				void window.vomp.invoke("git:watch", this.cwd).catch(() => {
					this.#watching = false;
				});
			}
			const status = await window.vomp.invoke("git:status", this.cwd);
			if (seq !== this.#seq || this.#refs === 0) return;
			this.#set({ loading: false, repo, status, error: null });
			const branch = status.branch;
			const branchChanged = branch !== this.#prBranch;
			if (!repo.github || !branch) {
				this.#prBranch = branch;
				this.#stopPrPoll();
				if (this.#view.pr) this.#set({ pr: null });
			} else if (branchChanged || Date.now() - this.#prCheckedAt >= PR_POLL_MS) {
				if (branchChanged) this.#set({ pr: null });
				void this.refreshPr();
			}
		} catch (error) {
			if (seq === this.#seq) this.#set({ loading: false, error: errorText(error) });
		}
	}

	/** Look up the branch's PR now (after creating one, or from "Check again"). */
	async refreshPr(): Promise<void> {
		const branch = this.#view.status?.branch ?? null;
		this.#prBranch = branch;
		this.#prCheckedAt = Date.now();
		let pr: GhPullRequest | null = null;
		try {
			pr = await window.vomp.invoke("gh:prStatus", this.cwd);
		} catch {
			// gh missing or signed out: the chip just stays hidden; the PR dialog explains how to connect.
		}
		if (this.#refs === 0 || (this.#view.status?.branch ?? null) !== branch) return;
		this.#set({ pr });
		if (pr?.state === "open") this.#startPrPoll();
		else this.#stopPrPoll();
	}

	#startPrPoll(): void {
		if (this.#prTimer !== null) return;
		this.#prTimer = window.setInterval(() => void this.refreshPr(), PR_POLL_MS);
	}

	#stopPrPoll(): void {
		if (this.#prTimer !== null) window.clearInterval(this.#prTimer);
		this.#prTimer = null;
	}
}

const trackers = new Map<string, GitTracker>();
let listening = false;

export function gitTracker(cwd: string): GitTracker {
	if (!listening) {
		listening = true;
		window.vomp.on("git:changed", event => trackers.get(event.cwd)?.changed());
	}
	let tracker = trackers.get(cwd);
	if (!tracker) {
		tracker = new GitTracker(cwd);
		trackers.set(cwd, tracker);
	}
	return tracker;
}

const NO_REPO_SUBSCRIBE = () => () => {};
const NO_VIEW = () => null;

/** Live git state for a project folder (null when there is no folder). */
export function useGit(cwd: string | null): GitView | null {
	const tracker = cwd ? gitTracker(cwd) : null;
	useEffect(() => {
		if (!tracker) return;
		tracker.acquire();
		return () => tracker.release();
	}, [tracker]);
	return useSyncExternalStore(tracker?.subscribe ?? NO_REPO_SUBSCRIBE, tracker?.getSnapshot ?? NO_VIEW);
}

/** Re-read git state for a folder now (e.g. right after a commit, before the watcher fires). */
export function refreshGit(cwd: string, options?: { pr?: boolean }): void {
	const tracker = trackers.get(cwd);
	if (!tracker) return;
	void tracker.refresh();
	if (options?.pr) void tracker.refreshPr();
}
