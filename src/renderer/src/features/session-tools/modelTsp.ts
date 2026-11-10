import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { ModelInfo } from "@shared/contracts/config";
import type { TspHostSnapshot, TspRendererEvent } from "@shared/tsp-host";
import { nodeHasLeft } from "@shared/tsp/dialogs";
import { TSP_ACTIONS, TSP_ROLES } from "@shared/tsp/roles";
import { walkNodes } from "@shared/tsp/view-state";
import { displayedEntries } from "../../chat/branch";
import { i18n } from "../../i18n";
import { isApprovalRequest, type SessionController } from "../../state/session";
import { screenActivity } from "../../state/tsp/screen-activity";
import { OmpBusyError, TspEditorWatch } from "./drive";
import { THINKING_LEVELS, type ThinkingLevel } from "./screen";
import { configuredThinking } from "./thinking";

/** Only the current main composer's controls can change this chat's model or effort. */
function composerNodes(snapshot: TspHostSnapshot | null) {
	const surfaces = snapshot?.surfaces.filter(surface => !surface.closed && !surface.suspended && surface.documentGeneration === snapshot.generation && surface.open.mode === "inline") ?? [];
	if (surfaces.length !== 1) return null;
	const surface = surfaces[0]!;
	const composers = [...walkNodes(surface.document)].filter(node => node.p?.role === TSP_ROLES.editor);
	if (composers.length !== 1) return null;
	return { sf: surface.open.id, nodes: [...walkNodes(composers[0]!)] };
}

/** omp's effort node can show Auto's resolved effort; collab preserves the configured selector. */
export function semanticThinking(
	snapshot: TspHostSnapshot | null,
	selector: string | null | undefined,
	entries: readonly SessionEntry[],
): ThinkingLevel | null {
	const displayed = semanticThinkingEffort(snapshot);
	if (displayed === null) return null;
	return configuredThinking(selector, entries, displayed);
}

/** omp uses `auto` here until its classifier reports an effort. */
export function semanticThinkingEffort(snapshot: TspHostSnapshot | null): ThinkingLevel | null {
	const effort = composerNodes(snapshot)?.nodes.find(node => node.k === "effort");
	return effort?.k === "effort" ? THINKING_LEVELS.find(level => level === effort.p?.level) ?? null : null;
}

export function refuseApproval(session: SessionController): void {
	const guest = session.getSnapshot().guest;
	if (guest?.pendingUiRequests?.some(isApprovalRequest) || (guest?.uiRequest && isApprovalRequest(guest.uiRequest))) {
		throw new Error(i18n.t("session:model.approvalPending"));
	}
}

/** Subscription waits include collab updates, and always terminate on a host/room/epoch change. */
function waitFor(watch: TspEditorWatch, done: () => boolean, timeoutMs?: number): Promise<boolean> {
	const { promise, resolve, reject } = Promise.withResolvers<boolean>();
	let off = () => {};
	const timer = timeoutMs === undefined ? undefined : setTimeout(() => { off(); resolve(false); }, timeoutMs);
	const check = () => {
		try {
			refuseApproval(watch.session);
			if (watch.ended || watch.snapshot?.closing) throw new Error(i18n.t("session:model.sessionChanged"));
			if (!done()) return;
			clearTimeout(timer); off(); resolve(true);
		} catch (error) { clearTimeout(timer); off(); reject(error); }
	};
	off = watch.subscribe(check);
	check();
	return promise;
}
async function send(watch: TspEditorWatch, event: TspRendererEvent): Promise<void> {
	refuseApproval(watch.session);
	if (watch.ended || !watch.snapshot || watch.snapshot.closing || watch.session.getSnapshot().readOnly) {
		throw new Error(i18n.t("session:model.sessionChanged"));
	}
	await window.vomp.invoke("host:tsp-event", watch.snapshot.hostId, watch.snapshot.generation, event, watch.snapshot.epoch);
}

function sessionPicker(snapshot: TspHostSnapshot | null) {
	for (const surface of snapshot?.surfaces ?? []) {
		if (surface.closed || surface.suspended || surface.documentGeneration !== snapshot?.generation) continue;
		for (const node of walkNodes(surface.document)) {
			if (node.k === "picker" && node.p?.noun === "models") {
				return { sf: surface.open.id, node };
			}
		}
	}
	return null;
}

/** A missing picker route falls back to omp's documented session-only slash command. */
export async function switchModelSemantic(session: SessionController, model: ModelInfo): Promise<boolean> {
	const watch = new TspEditorWatch(session);
	let releaseDrive: (() => void) | undefined;
	let offOutcome = () => {};
	const endDrive = () => { releaseDrive?.(); releaseDrive = undefined; };
	let openedPickerAction = false;
	let pickerClosed = false;
	let closeAttempted = false;
	const closeOwnedPicker = async (lateMs = 0) => {
		if (!openedPickerAction || pickerClosed || closeAttempted || watch.ended || watch.snapshot?.closing || session.getSnapshot().readOnly) return;
		if (!sessionPicker(watch.snapshot) && lateMs) await waitFor(watch, () => sessionPicker(watch.snapshot) !== null, lateMs);
		const picker = sessionPicker(watch.snapshot);
		if (!picker) return;
		closeAttempted = true;
		if (!picker.node.p?.actions?.some(action => action.id === TSP_ACTIONS.close)) throw new OmpBusyError();
		releaseDrive ??= screenActivity.hold(watch.snapshot!, "drive");
		await send(watch, { ev: "action", sf: picker.sf, id: picker.node.id, act: TSP_ACTIONS.close });
		if (!await waitFor(watch, () => !sessionPicker(watch.snapshot), 2500)) throw new OmpBusyError();
		pickerClosed = true;
	};
	const offDrive = watch.subscribe(() => {
		if (watch.ended || watch.snapshot?.closing || session.getSnapshot().readOnly) endDrive();
	});
	try {
		refuseApproval(session);
		await watch.ready();
		// A picker the user already opened never belongs to this operation.
		if (sessionPicker(watch.snapshot)) throw new OmpBusyError();
		const beforeErrors = new Set(watch.snapshot?.surfaces.flatMap(surface => [...walkNodes(surface.document)].filter(node => node.p?.role === TSP_ROLES.noticeError).map(node => `${node.id}:${JSON.stringify(node.p)}`)));
		const composer = composerNodes(watch.snapshot);
		const modelNode = composer?.nodes.find(node => node.p?.role === TSP_ROLES.composerModel && node.p.actions?.click === TSP_ACTIONS.model);
		let pickerId: string | null = null;
		let pickerSurfaceId: string | null = null;
		let usedPicker = false;
		if (modelNode && composer) {
			releaseDrive = screenActivity.hold(watch.snapshot!, "drive");
			openedPickerAction = true;
			await send(watch, { ev: "action", sf: composer.sf, id: modelNode.id, act: TSP_ACTIONS.model });
			await waitFor(watch, () => sessionPicker(watch.snapshot) !== null, 2500);
			const picker = sessionPicker(watch.snapshot);
			if (picker) {
				pickerId = picker.node.id;
				pickerSurfaceId = picker.sf;
				const item = picker.node.p?.items?.find(item => item.id === `${model.provider}/${model.id}`);
				if (item?.disabled) throw new Error(typeof item.disabled === "string" ? item.disabled : i18n.t("session:model.unavailable"));
				if (item && !item.disabled && picker.node.p?.actions?.some(action => action.id === TSP_ACTIONS.use)) {
					usedPicker = true;
					await send(watch, { ev: "activate", sf: picker.sf, id: picker.node.id, item: item.id });
				} else {
					await closeOwnedPicker();
				}
			}
		}
		if (!usedPicker) {
			refuseApproval(session);
			if (!watch.available) throw new OmpBusyError();
			releaseDrive ??= screenActivity.hold(watch.snapshot!, "drive");
			await session.command(`/switch ${model.selector}`);
		}
		let watchForLatePicker = openedPickerAction && !usedPicker && !pickerClosed;
		const latePickerPresent = () => watchForLatePicker && !pickerClosed && !closeAttempted && sessionPicker(watch.snapshot) !== null;
		const confirmed = () => {
			const current = session.getSnapshot().guest?.state?.model;
			return current?.provider === model.provider && current.id === model.id;
		};
		let failed = false;
		const compactionActive = () => watch.snapshot?.surfaces.some(surface =>
			!surface.closed && !surface.suspended && surface.documentGeneration === watch.snapshot?.generation
			&& [...walkNodes(surface.document)].some(node => node.p?.role === TSP_ROLES.working && node.c?.some(child => child.k === "progress"))) ?? false;
		const outcome = () => {
			// Once the internal picker leaves, compaction can wait without hiding unrelated native UI.
			if (watch.snapshot && pickerId && pickerSurfaceId && nodeHasLeft(watch.snapshot.surfaces, pickerSurfaceId, pickerId)) {
				pickerClosed = true; endDrive();
			}
			for (const surface of watch.snapshot?.surfaces ?? []) for (const node of walkNodes(surface.document)) {
				if (node.p?.role === TSP_ROLES.noticeError && !beforeErrors.has(`${node.id}:${JSON.stringify(node.p)}`)) failed = true;
			}
			return (!compactionActive() && confirmed()) || failed;
		};
		offOutcome = watch.subscribe(outcome);
		while (true) {
			const changed = await waitFor(watch, () => outcome() || compactionActive() || latePickerPresent(), 8000);
			if (!changed || outcome()) {
				await closeOwnedPicker(watchForLatePicker ? 1000 : 0);
				watchForLatePicker = false;
				if (outcome() || !compactionActive()) break;
			}
			if (latePickerPresent()) await closeOwnedPicker();
			if (!compactionActive()) continue;
			// An action that timed out may still open its picker after typed fallback.
			await closeOwnedPicker(watchForLatePicker ? 1000 : 0);
			watchForLatePicker = false;
			if (!sessionPicker(watch.snapshot)) endDrive();
			// Compaction has no fixed deadline. Scope changes and error rows still end this wait.
			await waitFor(watch, () => outcome() || !compactionActive());
			// Its progress row has gone; allow collab one bounded confirmation interval.
		}
		return !failed && confirmed();
	} finally {
		try { await closeOwnedPicker(); }
		finally { offOutcome(); offDrive(); endDrive(); watch.dispose(); }
	}
}

export async function setThinkingSemantic(session: SessionController, target: ThinkingLevel): Promise<boolean> {
	const watch = new TspEditorWatch(session);
	let releaseDrive: (() => void) | undefined;
	const offDrive = watch.subscribe(() => {
		if (watch.ended || watch.snapshot?.closing || session.getSnapshot().readOnly) releaseDrive?.();
	});
	try {
		refuseApproval(session);
		await watch.ready();
		const read = () => {
			const view = session.getSnapshot();
			return semanticThinking(watch.snapshot, view.guest?.thinkingSelector, displayedEntries(view));
		};
		const visited = new Set<ThinkingLevel>();
		while (true) {
			const current = read();
			const beforeSelector = session.getSnapshot().guest?.thinkingSelector ?? null;
			if (current === target) return true;
			if (current === null) throw new Error(i18n.t("session:thinking.unavailable"));
			if (visited.has(current)) throw new Error(i18n.t("session:thinking.unsupportedLevel", { level: i18n.t(`session:thinking.levels.${target}.label`) }));
			visited.add(current);
			const composer = composerNodes(watch.snapshot);
			const effort = composer?.nodes.find(node => node.p?.actions?.click === TSP_ACTIONS.thinkingCycle);
			if (!effort || !composer || !watch.available) throw new OmpBusyError();
			releaseDrive ??= screenActivity.hold(watch.snapshot!, "drive");
			await send(watch, { ev: "action", sf: composer.sf, id: effort.id, act: TSP_ACTIONS.thinkingCycle });
			// An unset selector can paint Off; its first cycle initializes Off without moving the glyph.
			const firstReceipt = () => beforeSelector === null && session.getSnapshot().guest?.thinkingSelector === current;
			if (!await waitFor(watch, () => read() !== current || firstReceipt(), 2500)) throw new Error(i18n.t("session:thinking.failed"));
			if (firstReceipt()) visited.delete(current);
		}
	} finally { offDrive(); releaseDrive?.(); watch.dispose(); }
}
