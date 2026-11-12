import { projectShell, type ShellProjection } from "@shared/tsp/shell";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useApp } from "../../state/app";
import { tspHost, type TspHostSource } from "../../state/tsp/hosts";
import { useVisualSnapshot } from "../../state/visualSnapshot";
import { usePresentationClaim, usePresentationVisible } from "../../state/tsp/presentation-claims";
import { LoadFailedNotice, lazyView } from "../../registry/lazy";
import { errorText } from "@shared/errors";
import { toast } from "../../ui/toast";
import { useLiveShellScope } from "./context";
import type { ShellCommandContext } from "../../tool-render/types";

export interface LiveShellCommandProps { projection: ShellProjection; act(value: string): void; command: string; fallback: ReactNode; envPrefix?: string; context?: ShellCommandContext }
const ShellContent = lazyView<LiveShellCommandProps>(
	() => import("./LiveShellContent").then(module => module.LiveShellContent),
	({ fallback }) => fallback,
	({ fallback, retry }) => <>{fallback}<LoadFailedNotice retry={retry} /></>,
);

/** Offscreen cards retain ordinary output while releasing optional presentation consumers. */
export function useShellVisibility(ref: RefObject<HTMLElement | null>, open: boolean): boolean {
	const [visible, setVisible] = useState(true);
	const presentationVisible = usePresentationVisible();
	const [foreground, setForeground] = useState(() => document.visibilityState !== "hidden");
	useEffect(() => {
		const update = () => setForeground(document.visibilityState !== "hidden");
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	useEffect(() => {
		const node = ref.current;
		if (!node || !open) return;
		const observer = new IntersectionObserver(entries => {
			const entry = entries.at(-1);
			if (entry) setVisible(entry.isIntersecting);
		}, { rootMargin: "80px" });
		observer.observe(node);
		return () => observer.disconnect();
	}, [ref, open]);
	return open && visible && foreground && presentationVisible;
}

/** Keep the disclosure's measured geometry while its optional consumer releases resources. */
export function useShellHeight(ref: RefObject<HTMLElement | null>, active: boolean) {
	const height = useRef(0);
	useLayoutEffect(() => {
		const node = ref.current;
		if (!node || !active) return;
		const measure = () => { height.current = node.getBoundingClientRect().height; };
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, [ref, active]);
	return active || height.current === 0 ? undefined : { minHeight: height.current };
}

const absent: TspHostSource = { hostId: "", getSnapshot: () => null, subscribe: () => () => {}, failed: () => false };
function sameTarget(a: ShellProjection, b: ShellProjection): boolean {
	return a.hostId === b.hostId && a.generation === b.generation && a.epoch === b.epoch
		&& a.surfaceId === b.surfaceId && a.nodeId === b.nodeId && a.toolCallId === b.toolCallId;
}

/** One exact call reads the shared document. There is no command-text or most-recent-call fallback. */
export function useLiveShell(toolCallId: string | undefined, identityOnly = false): { projection: ShellProjection | null; act(value: string): void } {
	const scope = useLiveShellScope();
	const store = useMemo(() => scope && toolCallId && !scope.readOnly ? tspHost(scope.hostId) : absent, [scope?.hostId, scope?.readOnly, toolCallId]);
	const readProjection = useMemo(() => {
		let previous: ShellProjection | null = null;
		return () => {
			const snapshot = store.getSnapshot();
			const next = scope && toolCallId && snapshot?.epoch === scope.epoch
				? projectShell(snapshot, scope.hostId, scope.generation, toolCallId) : null;
			if (previous && next && sameTarget(previous, next) && (identityOnly || previous.props === next.props)) return previous;
			return previous = next;
		};
	}, [store, scope?.hostId, scope?.generation, scope?.epoch, toolCallId, identityOnly]);
	const projection = useVisualSnapshot(store.subscribe, readProjection);
	const bound = useMemo(() => scope && !scope.readOnly && projection ? {
		hostId: projection.hostId, generation: projection.generation, epoch: projection.epoch,
		surfaceId: projection.surfaceId, nodeId: projection.nodeId, toolCallId: projection.toolCallId,
	} : null, [scope?.readOnly, projection?.hostId, projection?.generation, projection?.epoch, projection?.surfaceId, projection?.nodeId, projection?.toolCallId]);
	const act = useCallback((value: string) => {
		if (!bound) return;
		const fresh = store.getSnapshot();
		const target = fresh?.epoch === bound.epoch ? projectShell(fresh, bound.hostId, bound.generation, bound.toolCallId) : null;
		if (!target || target.surfaceId !== bound.surfaceId || target.nodeId !== bound.nodeId) return;
		void window.vomp.invoke("host:tsp-event", target.hostId, target.generation,
			{ ev: "action", sf: target.surfaceId, id: target.nodeId, act: "shell-viz", value }, target.epoch).catch(error => {
				const now = store.getSnapshot();
				const stillCurrent = now?.epoch === target.epoch && projectShell(now, target.hostId, target.generation, target.toolCallId);
				if (stillCurrent && stillCurrent.nodeId === target.nodeId) toast({ tone: "err", message: errorText(error) });
			});
	}, [bound, store]);
	return { projection: scope?.readOnly ? null : projection, act };
}

/** Availability suppresses automatic fallback while a matching tool row represents the command. */
export function ShellAvailability({ projection }: { projection: ShellProjection | null }) {
	const covered = useApp(state => !!state.terminalTabId || !!state.sheet);
	usePresentationClaim(projection ? { hostId: projection.hostId, epoch: projection.epoch, surfaceId: projection.surfaceId, nodeId: projection.nodeId } : null, false, !covered);
	return null;
}

/** The heavy view is mounted only inside an open, visible bash body. */
export function LiveShellCommand({ projection, act, command, fallback, envPrefix, context }: LiveShellCommandProps) {
	const ref = useRef<HTMLDivElement>(null);
	const visible = useShellVisibility(ref, true);
	const covered = useApp(state => !!state.terminalTabId || !!state.sheet);
	const active = visible && !covered;
	const style = useShellHeight(ref, active);
	return <div ref={ref} style={style}>{active
		? <ShellContent projection={projection} command={command} act={act} fallback={fallback} envPrefix={envPrefix} context={context} />
		: fallback}</div>;
}
