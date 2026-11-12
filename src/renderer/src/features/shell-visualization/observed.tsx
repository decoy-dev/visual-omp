import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { GuestSnapshot } from "../../collab/lib/client";
import { useVisualSnapshot } from "../../state/visualSnapshot";

type TraceGuest = Pick<GuestSnapshot, "activeTools" | "backgroundTools">;
export interface ObservedShellStore {
	subscribe(listener: () => void): () => void;
	getSnapshot(): TraceGuest | null;
}
interface Scope { store: ObservedShellStore; identity: string; cwd: string }
export interface ObservedShellTrace { sourceId: string; cwd: string; executionCwd?: string; cdSeparator?: ";"; trace: object }
const ObservedShellContext = createContext<Scope | null>(null);
const absent: ObservedShellStore = { subscribe: () => () => {}, getSnapshot: () => null };

/** Observed data grants only local presentation capability, including for an externally owned chat. */
export function ObservedShellProvider({ store, identity, cwd, children }: Scope & { children: ReactNode }) {
	const value = useMemo(() => ({ store, identity, cwd }), [store, identity, cwd]);
	return <ObservedShellContext.Provider value={value}>{children}</ObservedShellContext.Provider>;
}

/** Call-specific selectors keep active and detached background revisions below the outer tool card. */
export function useObservedShell(toolCallId: string | undefined, identityOnly = false): ObservedShellTrace | null {
	const scope = useContext(ObservedShellContext);
	const store = scope && toolCallId ? scope.store : absent;
	const getSnapshot = useMemo(() => {
		let previous: ObservedShellTrace | null = null;
		return () => {
			const guest = store.getSnapshot();
			const partial = toolCallId ? (guest?.backgroundTools.get(toolCallId) ?? guest?.activeTools.get(toolCallId))?.partialResult : undefined;
			const details = partial && typeof partial === "object" && "details" in partial ? partial.details : undefined;
			const trace = details && typeof details === "object" && "trace" in details ? details.trace : undefined;
			if (!scope || !trace || typeof trace !== "object" || !("v" in trace) || trace.v !== 1) return previous = null;
			const executionCwd = details && typeof details === "object" && "cwd" in details && typeof details.cwd === "string" ? details.cwd : undefined;
			const cdSeparator = details && typeof details === "object" && "cdSeparator" in details && details.cdSeparator === ";" ? ";" : undefined;
			if (previous && (identityOnly || previous.trace === trace && previous.executionCwd === executionCwd && previous.cdSeparator === cdSeparator)) return previous;
			return previous = { sourceId: JSON.stringify([scope.identity, toolCallId]), cwd: scope.cwd, executionCwd, cdSeparator, trace };
		};
	}, [scope, store, toolCallId, identityOnly]);
	return useVisualSnapshot(store.subscribe, getSnapshot);
}
