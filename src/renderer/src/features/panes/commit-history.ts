import { useEffect, useRef, useState } from "react";
import type { GitLogCommit } from "@shared/contracts/git";

const PAGE_SIZE = 30;

export interface CommitHistoryState {
	commits: GitLogCommit[];
	loading: boolean;
	error: string | null;
	hasMore: boolean;
	more(): Promise<void>;
	retry(): void;
}

/** Keep loaded pages across clean/dirty views and commit selection, pinned to one immutable HEAD. */
export function useCommitHistory(projectPath: string, head: string | null, ready: boolean, visible: boolean): CommitHistoryState {
	const [commits, setCommits] = useState<GitLogCommit[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [hasMore, setHasMore] = useState(false);
	const [reload, setReload] = useState(0);
	const count = useRef(PAGE_SIZE);
	const generation = useRef(0);
	const snapshot = useRef<string | null | undefined>(undefined);
	const loadedReload = useRef(-1);

	useEffect(() => {
		if (!visible || !ready) return;
		if (snapshot.current === head && loadedReload.current === reload) {
			setLoading(false);
			return () => { generation.current++; };
		}
		const request = ++generation.current;
		setLoading(true);
		const refresh = async () => {
			const next: GitLogCommit[] = [];
			let more = false;
			if (head) {
				for (let skip = 0; skip < count.current; skip += PAGE_SIZE) {
					const page = await window.vomp.invoke("git:log", projectPath, { head, limit: PAGE_SIZE, skip });
					if (request !== generation.current) return;
					next.push(...page);
					more = page.length === PAGE_SIZE;
					if (!more) break;
				}
			}
			if (request !== generation.current) return;
			snapshot.current = head;
			loadedReload.current = reload;
			setCommits(next);
			setHasMore(more);
			setError(null);
		};
		void refresh().catch((reason: unknown) => {
			if (request === generation.current) setError(reason instanceof Error ? reason.message : String(reason));
		}).finally(() => {
			if (request === generation.current) setLoading(false);
		});
		return () => { generation.current++; };
	}, [projectPath, head, ready, visible, reload]);

	const more = async () => {
		if (!snapshot.current || loading) return;
		const request = ++generation.current;
		setLoading(true);
		try {
			const next = await window.vomp.invoke("git:log", projectPath, { head: snapshot.current, limit: PAGE_SIZE, skip: commits.length });
			if (request !== generation.current) return;
			setCommits(previous => [...previous, ...next]);
			count.current += PAGE_SIZE;
			setHasMore(next.length === PAGE_SIZE);
			setError(null);
		} catch (reason) {
			if (request === generation.current) setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			if (request === generation.current) setLoading(false);
		}
	};
	return { commits, loading, error, hasMore, more, retry: () => setReload(value => value + 1) };
}
