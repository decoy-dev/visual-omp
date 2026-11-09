import { createContext, type PropsWithChildren, useContext, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import type { TspPresentationClaims } from "@shared/tsp/view-state";

export interface PresentationTarget { hostId: string; epoch: number; surfaceId: string; nodeId: string }
const visiblePresentation = createContext(true);
const tabVisibility = new Map<object, { tabId: string; visible: boolean }>();
const visibilityListeners = new Set<() => void>();
const subscribeVisibility = (listener: () => void) => { visibilityListeners.add(listener); return () => visibilityListeners.delete(listener); };

/** Global screen opening follows the same hidden-pane state as native presentation claims. */
export function currentTabPresentationVisible(tabId: string): boolean {
	let known = false;
	for (const item of tabVisibility.values()) if (item.tabId === tabId) {
		known = true;
		if (item.visible) return true;
	}
	// Non-ChatArea hosts and composition harnesses retain their existing visibility contract.
	return !known;
}
export function useTabPresentationVisible(tabId: string): boolean {
	return useSyncExternalStore(subscribeVisibility, () => currentTabPresentationVisible(tabId));
}

/** Layout owners explicitly propagate hidden/inert state, including nested split panes. */
export function PresentationVisibility({ visible, tabId, children }: PropsWithChildren<{ visible: boolean; tabId?: string }>) {
	const parent = useContext(visiblePresentation);
	useLayoutEffect(() => {
		if (!tabId) return;
		const owner = {};
		tabVisibility.set(owner, { tabId, visible: parent && visible });
		for (const listener of visibilityListeners) listener();
		return () => {
			tabVisibility.delete(owner);
			for (const listener of visibilityListeners) listener();
		};
	}, [parent, visible, tabId]);
	return <visiblePresentation.Provider value={parent && visible}>{children}</visiblePresentation.Provider>;
}

/** Renderer-only ownership. Multiple visible consumers share one target until the last releases it. */
class PresentationClaimRegistry {
	#owners = new Map<string, { target: PresentationTarget; count: number }>();
	#snapshot: readonly PresentationTarget[] = [];
	#listeners = new Set<() => void>();
	getSnapshot = () => this.#snapshot;
	subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
	acquire(target: PresentationTarget): () => void {
		const key = JSON.stringify([target.hostId, target.epoch, target.surfaceId, target.nodeId]);
		const owner = this.#owners.get(key);
		if (owner) owner.count++;
		else { this.#owners.set(key, { target, count: 1 }); this.#publish(); }
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const current = this.#owners.get(key);
			if (current && --current.count === 0) { this.#owners.delete(key); this.#publish(); }
		};
	}
	#publish() {
		this.#snapshot = [...this.#owners.values()].map(owner => owner.target);
		for (const listener of this.#listeners) listener();
	}
}
export const presentationClaims = new PresentationClaimRegistry();
const availableConsumers = new PresentationClaimRegistry();
const consumerRegistries = [presentationClaims, availableConsumers] as const;

/** Read at an automatic-opening decision, after consumers have registered in layout effects. */
export function currentPresentationConsumers(hostId: string | null, epoch: number | undefined): TspPresentationClaims {
	const surfaces = new Map<string, Set<string>>();
	for (const registry of consumerRegistries) for (const target of registry.getSnapshot()) {
		if (target.hostId !== hostId || target.epoch !== epoch) continue;
		let nodes = surfaces.get(target.surfaceId);
		if (!nodes) surfaces.set(target.surfaceId, nodes = new Set());
		nodes.add(target.nodeId);
	}
	return surfaces;
}

/**
 * Active presentation suppresses the generic screen. Availability may remain true while a sheet
 * covers an otherwise visible consumer, so Escape can close that sheet without answering its node.
 * Hidden layout ancestors and unmount release both registrations.
 */
export function usePresentationClaim(target: PresentationTarget | null, active = true, available = active): void {
	const visible = useContext(visiblePresentation);
	const hostId = target?.hostId, epoch = target?.epoch, surfaceId = target?.surfaceId, nodeId = target?.nodeId;
	useLayoutEffect(() => {
		if (!visible || !active || hostId === undefined || epoch === undefined || surfaceId === undefined || nodeId === undefined) return;
		return presentationClaims.acquire({ hostId, epoch, surfaceId, nodeId });
	}, [visible, active, hostId, epoch, surfaceId, nodeId]);
	useLayoutEffect(() => {
		if (!visible || !available || hostId === undefined || epoch === undefined || surfaceId === undefined || nodeId === undefined) return;
		return availableConsumers.acquire({ hostId, epoch, surfaceId, nodeId });
	}, [visible, available, hostId, epoch, surfaceId, nodeId]);
}

/** Exact host/epoch scope; shared projections receive only the current surface/node ownership. */
export function usePresentationClaims(hostId: string | null, epoch: number | undefined): TspPresentationClaims {
	return useScopedClaims(presentationClaims, hostId, epoch);
}
/** Available consumers do not suppress fallback content or grant any input authority. */
export function usePresentationAvailability(hostId: string | null, epoch: number | undefined): TspPresentationClaims {
	return useScopedClaims(availableConsumers, hostId, epoch);
}
function useScopedClaims(registry: PresentationClaimRegistry, hostId: string | null, epoch: number | undefined): TspPresentationClaims {
	const claims = useSyncExternalStore(registry.subscribe, registry.getSnapshot);
	return useMemo(() => {
		const surfaces = new Map<string, Set<string>>();
		for (const target of claims) if (target.hostId === hostId && target.epoch === epoch) {
			let nodes = surfaces.get(target.surfaceId);
			if (!nodes) surfaces.set(target.surfaceId, nodes = new Set());
			nodes.add(target.nodeId);
		}
		return surfaces;
	}, [claims, hostId, epoch]);
}
