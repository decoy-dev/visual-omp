import type { TspHostSnapshot, TspRendererEvent } from "@shared/tsp-host";
import { commandOutcome } from "@shared/tsp/command-result";
import { hookDialogTarget, nodeHasLeft } from "@shared/tsp/dialogs";
import { TSP_ACTIONS, TSP_TREE } from "@shared/tsp/roles";
import { assertTreeEntry, treeSelector } from "@shared/tsp/tree-navigation";
import { useComposerDrafts } from "../../chat/composer/drafts";
import type { SessionController } from "../../state/session";
import { screenActivity } from "../../state/tsp/screen-activity";
import { TspEditorWatch } from "./drive";
import type { TreeEntry } from "./tree";

function current(watch: TspEditorWatch): TspHostSnapshot {
	if (watch.ended || !watch.snapshot || watch.snapshot.closing || watch.session.getSnapshot().readOnly) throw new Error("The chat changed before omp confirmed navigation. Try again.");
	return watch.snapshot;
}
function waitFor(watch: TspEditorWatch, done: () => boolean, reason: string): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let off = () => {};
	const timer = setTimeout(() => { off(); reject(new Error(reason)); }, 8000);
	const check = () => {
		try {
			current(watch);
			if (!done()) return;
			clearTimeout(timer); off(); resolve();
		} catch (error) { clearTimeout(timer); off(); reject(error); }
	};
	off = watch.subscribe(check); check();
	return promise;
}
async function send(watch: TspEditorWatch, event: TspRendererEvent): Promise<void> {
	const snapshot = current(watch);
	await window.vomp.invoke("host:tsp-event", snapshot.hostId, snapshot.generation, event, snapshot.epoch);
}

/** Go here consumes omp's entry keys and transfers only the text its editor restores. */
export async function navigateSemantic(session: SessionController, entry: TreeEntry, assertCurrent = () => {}, confirmLeaf: (leaf: string | null) => void = () => {}): Promise<{ draft: string | null }> {
	const watch = new TspEditorWatch(session);
	let releaseDrive = () => {};
	const offDrive = watch.subscribe(() => {
		if (watch.ended || watch.snapshot?.closing || session.getSnapshot().readOnly) releaseDrive();
	});
	try {
		await watch.ready();
		const before = current(watch);
		releaseDrive = screenActivity.hold(before, "drive");
		await session.command("/tree", assertCurrent);
		await waitFor(watch, () => !!treeSelector(current(watch).surfaces), "omp did not open its session tree selector.");
		let target = treeSelector(current(watch).surfaces)!;
		if (target.node.k === "picker" && !target.node.p?.items?.some(item => item.id === entry.id && !item.disabled)) assertTreeEntry(target.node, entry.id);
		// Filters affect which entries omp accepts. Ask its declared All tab rather than predicting rows.
		if (target.node.k === "picker" && target.node.p?.order && !target.node.p.order.includes(entry.id)) {
			if (!target.node.p.tabs?.some(tab => tab.id === "all") || !target.node.p.actions?.some(action => action.id === TSP_ACTIONS.switch)) throw new Error("This entry is hidden by omp's tree filter. Open the omp screen to change the filter.");
			const surfaceId = target.surface.open.id;
			const selectorId = target.node.id;
			const filteredTarget = () => {
				const next = treeSelector(current(watch).surfaces);
				if (!next || next.surface.open.id !== surfaceId || next.node.id !== selectorId) throw new Error("omp's session tree selector changed while changing its filter. Open the tree again.");
				return next;
			};
			assertCurrent();
			await send(watch, { ev: "action", sf: surfaceId, id: selectorId, act: TSP_ACTIONS.tab, value: "all" });
			await waitFor(watch, () => {
				const node = filteredTarget().node;
				return node.k === "picker" && node.p?.order?.includes(entry.id) === true;
			}, "omp did not make this session entry available in its tree.");
			target = filteredTarget();
		}
		assertTreeEntry(target.node, entry.id);
		const snapshot = current(watch);
		assertCurrent();
		await window.vomp.invoke("host:tsp-tree-activate", snapshot.hostId, snapshot.generation, snapshot.epoch, target.surface.open.id, target.node.id, entry.id);
		const outcome = () => commandOutcome(before, current(watch), { success: new RegExp(`^(?:${TSP_TREE.navigated}|${TSP_TREE.already})\\.?$`) });
		await waitFor(watch, () => !!outcome() || !!hookDialogTarget(current(watch).surfaces), "omp did not confirm session tree navigation.");
		const question = hookDialogTarget(current(watch).surfaces);
		if (question) {
			const dialog = question.dialog;
			if (dialog.title !== TSP_TREE.summaryTitle || dialog.body.kind !== "select") throw new Error("omp opened another question during navigation. Answer it before trying again.");
			const option = dialog.body.options.find(option => option.label === TSP_TREE.noSummary && !option.disabled);
			if (!option) throw new Error("omp's branch question no longer offers No summary.");
			await waitFor(watch, () => {
				const match = current(watch).questionMatches?.find(match => match.surfaceId === question.surface.open.id && match.nodeId === question.node.id);
				return match?.status === "unmatched" || match?.status === "matched" || nodeHasLeft(current(watch).surfaces, question.surface.open.id, question.node.id);
			}, "The branch question is unavailable or ambiguous. Answer it using the chat's question controls.");
			const latest = current(watch);
			assertCurrent();
			if (!nodeHasLeft(latest.surfaces, question.surface.open.id, question.node.id)) {
				const match = latest.questionMatches?.find(match => match.surfaceId === question.surface.open.id && match.nodeId === question.node.id);
				if (match?.status === "matched" && match.reqId !== undefined) session.answer(match.reqId, option.label);
				else await window.vomp.invoke("host:tsp-answer", latest.hostId, latest.generation, { kind: "choose", sf: question.surface.open.id, id: question.node.id, target: dialog.body.target, item: option.id }, latest.epoch);
			}
		}
		await waitFor(watch, () => !!outcome() && watch.available, "omp did not restore its editor after tree navigation.");
		assertCurrent();
		const already = outcome()!.lines.some(line => line.startsWith(TSP_TREE.already));
		const leaf = entry.userTurn ? entry.parentId : entry.id;
		if (!already && leaf) { confirmLeaf(leaf); session.setDisplayLeaf(leaf); }
		const restored = current(watch);
		const editor = restored.composer;
		if (already || !editor?.text) return { draft: null };
		if (!editor.surfaceId || !editor.editorId) throw new Error("omp's restored editor is unavailable. Its text was left unchanged.");
		assertCurrent();
		await window.vomp.invoke("host:take-editor-restore", restored.hostId, restored.generation, restored.epoch, editor.surfaceId, editor.editorId, editor.text);
		useComposerDrafts.getState().focus(session.tabId);
		return { draft: editor.text };
	} finally { offDrive(); releaseDrive(); watch.dispose(); }
}
