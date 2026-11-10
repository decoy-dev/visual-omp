import { useSyncExternalStore } from "react";
import type { TspHostSnapshot } from "@shared/tsp-host";

export type ScreenActivityScope = Pick<TspHostSnapshot, "hostId" | "generation"> & { epoch: number | null };
export type ScreenActivityKind = "drive" | "request";
interface PendingRequest extends ScreenActivityScope { id: number; revision: number; key: string; finish(): void }
function sameScope(left: ScreenActivityScope, right: ScreenActivityScope): boolean {
	return left.hostId === right.hostId && left.generation === right.generation && left.epoch === right.epoch;
}

/** Presentation intent only. Leases never claim native content or grant input authority. */
export class ScreenActivityRegistry {
	readonly #leases = new Set<ScreenActivityScope & { kind: ScreenActivityKind; id: number; opened: boolean }>();
	readonly #requests = new Set<PendingRequest>();
	#next = 0;
	readonly #listeners = new Set<() => void>();
	readonly subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => { this.#listeners.delete(listener); };
	};
	hold(scope: ScreenActivityScope, kind: ScreenActivityKind): () => void {
		const lease = { hostId: scope.hostId, generation: scope.generation, epoch: scope.epoch, kind, id: ++this.#next, opened: false };
		this.#leases.add(lease);
		this.#notify();
		return () => {
			if (this.#leases.delete(lease)) this.#notify();
		};
	}
	requestOnce(scope: Pick<TspHostSnapshot, "hostId" | "generation" | "epoch">, revision: number, key: string): { cancel(): void; done: Promise<void> } {
		const { promise, resolve } = Promise.withResolvers<void>();
		const request = { hostId: scope.hostId, generation: scope.generation, epoch: scope.epoch, revision, key, id: ++this.#next, finish: resolve };
		this.#requests.add(request); this.#notify();
		return { done: promise, cancel: () => { if (this.#requests.delete(request)) { request.finish(); this.#notify(); } } };
	}
	version(scope: ScreenActivityScope | null, kind: ScreenActivityKind): number {
		if (!scope) return 0;
		let version = 0;
		for (const lease of this.#leases) if (lease.kind === kind && sameScope(lease, scope)) version = Math.max(version, lease.id);
		if (kind === "request") for (const request of this.#requests) if (sameScope(request, scope)) version = Math.max(version, request.id);
		return version;
	}
	has(scope: ScreenActivityScope | null, kind: ScreenActivityKind): boolean { return this.version(scope, kind) !== 0; }
	allowsRequest(scope: ScreenActivityScope, revision: number, key: string): boolean {
		for (const lease of this.#leases) if (lease.kind === "request" && !lease.opened && sameScope(lease, scope)) return true;
		for (const request of this.#requests) if (sameScope(request, scope) && request.revision <= revision && request.key === key) return true;
		return false;
	}
	/** A command may remain active after its screen closes; that is not a new opening request. */
	markOpened(scope: ScreenActivityScope): void {
		for (const lease of this.#leases) if (lease.kind === "request" && sameScope(lease, scope)) lease.opened = true;
	}
	/** Called only after the renderer's current native frame has completed layout registration. */
	consumeRequests(scope: ScreenActivityScope, revision: number): void {
		let changed = false;
		for (const request of this.#requests) if (sameScope(request, scope) && request.revision <= revision) {
			this.#requests.delete(request); request.finish(); changed = true;
		}
		if (changed) this.#notify();
	}
	#notify(): void { for (const listener of this.#listeners) listener(); }
}

export const screenActivity = new ScreenActivityRegistry();

export function useScreenActivity(scope: ScreenActivityScope | null, kind: ScreenActivityKind): number {
	return useSyncExternalStore(screenActivity.subscribe, () => screenActivity.version(scope, kind));
}
