import type { PreviewChange } from "@shared/contracts/preview";
import { useEffect } from "react";
import { controllerFor, useApp } from "../../state/app";
import { liveGuest, type SessionController } from "../../state/session";
import { backgroundJobs, ompRunning } from "../panes/derive";
import { deriveSubjects, namedPaths, relatedPaths, sequencePatterns, type SubjectInput } from "./subjects";
import { EMPTY_CHAT, useLivePreview } from "./store";
import { cancelPreviewRedirect } from "./redirect";

const EMPTY_TOOLS = new Map();
const EMPTY_ENTRIES: SubjectInput["entries"] = [];

/** Snapshot callbacks only schedule work; one derivation per 100 ms covers a chat's latest snapshot. */
export function trackSession(session: SessionController, autoOpen: () => boolean): () => void {
	let alive = true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let watchId: string | null = null;
	const retiring = new Set<string>();
	let starting = false;
	let watching = false;
	let namedKey = "";
	let opened = false;
	let wasWorking = false;
	let changes: PreviewChange[] = [];
	const stopWatch = () => {
		if (!watchId) return;
		const id = watchId;
		retiring.add(id);
		watchId = null;
		void window.vomp.invoke("preview:unwatch", id).catch(() => {}).finally(() => retiring.delete(id));
	};
	const run = () => {
		timer = undefined;
		if (!alive) return;
		const view = session.getSnapshot();
		const guest = liveGuest(view);
		if (view.working && !wasWorking) { opened = false; changes = []; cancelPreviewRedirect(session.tabId); }
		wasWorking = view.working;
		const entries = guest?.entries ?? EMPTY_ENTRIES;
		const input: SubjectInput = {
			stream: guest?.stream ?? null, streamDone: guest?.streamDone ?? true,
			activeTools: guest?.activeTools ?? EMPTY_TOOLS, backgroundTools: guest?.backgroundTools ?? EMPTY_TOOLS,
			entries, changes, working: view.working, folder: session.projectPath, platform: window.vomp.platform, now: Date.now(),
		};
		const before = useLivePreview.getState().chats[session.tabId] ?? EMPTY_CHAT;
		const subjects = deriveSubjects(input, before.subjects);
		useLivePreview.getState().update(session.tabId, subjects, relatedPaths(input));
		if (!opened && subjects.some(subject => subject.state === "writing" || subject.state === "running")) {
			opened = true;
			if (autoOpen()) useApp.getState().showPane("outputs", session.tabId);
		}
		watching = view.working || backgroundJobs(entries, ompRunning(view), input.activeTools, input.backgroundTools, session.projectPath, undefined, view.host?.processStartedAt).some(job => job.state === "running");
		const named = namedPaths(input);
		const sequences = sequencePatterns(input);
		const key = JSON.stringify([named, sequences]);
		if (watching && !watchId && !starting) {
			starting = true;
			namedKey = key;
			void window.vomp.invoke("preview:watch", { folder: session.projectPath, named, sequences }).then(id => {
				if (!alive || !watching) { void window.vomp.invoke("preview:unwatch", id).catch(() => {}); return; }
				watchId = id;
				schedule();
			}).catch(() => {}).finally(() => { starting = false; });
		} else if (watchId && watching && key !== namedKey) {
			namedKey = key;
			void window.vomp.invoke("preview:watchNamed", watchId, named, sequences).catch(() => {});
		} else if (!watching) stopWatch();
	};
	const schedule = () => { timer ??= setTimeout(run, 100); };
	const offSnapshot = session.subscribe(schedule);
	const offChange = window.vomp.on("preview:changed", change => {
		if (change.watchId !== watchId && !retiring.has(change.watchId)) return;
		const pattern = change.sequence ? JSON.stringify(change.sequence.pattern) : null;
		changes = [...changes.filter(item => pattern ? JSON.stringify(item.sequence?.pattern) !== pattern : item.path !== change.path), change];
		schedule();
	});
	run();
	return () => { alive = false; clearTimeout(timer); offSnapshot(); offChange(); stopWatch(); cancelPreviewRedirect(session.tabId); useLivePreview.getState().forget(session.tabId); };
}

export function Tracker() {
	useEffect(() => {
		const subscriptions = new Map<string, () => void>();
		const sync = () => {
			const app = useApp.getState();
			const enabled = app.prefs?.livePreview === true;
			const ids = new Set(enabled ? app.tabs.map(tab => tab.id) : []);
			for (const [id, stop] of subscriptions) if (!ids.has(id)) { stop(); subscriptions.delete(id); }
			for (const id of ids) {
				const session = controllerFor(id);
				if (session && !subscriptions.has(id)) subscriptions.set(id, trackSession(session, () => useApp.getState().prefs?.livePreviewOpenOutputs === true));
			}
		};
		const offApp = useApp.subscribe(sync);
		sync();
		return () => { offApp(); for (const stop of subscriptions.values()) stop(); };
	}, []);
	return null;
}
