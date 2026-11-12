import { useRef, useState, type ReactNode } from "react";
import { LoadFailedNotice, lazyView } from "../../registry/lazy";
import { useApp } from "../../state/app";
import { useShellHeight, useShellVisibility } from "./live";
import type { ShellCommandContext } from "../../tool-render/types";

export interface SavedShellCommandProps {
	file?: string;
	observedCallId?: string;
	identity: string;
	toolCallId: string;
	cwd?: string;
	command: string;
	fallback: ReactNode;
	envPrefix?: string;
	context?: ShellCommandContext;
}
export interface SavedShellContentProps extends SavedShellCommandProps { active: boolean; onReady?(ready: boolean): void }
const SavedContent = lazyView<SavedShellContentProps>(
	() => import("./SavedShellContent").then(module => module.SavedShellContent),
	({ fallback }) => fallback,
	({ fallback, retry, active }) => <>{fallback}{active && <LoadFailedNotice retry={retry} />}</>,
);

/** The card body owns this boundary; closed cards never mount a restore consumer. */
export function SavedShellCommand(props: SavedShellCommandProps) {
	const ref = useRef<HTMLDivElement>(null);
	const visible = useShellVisibility(ref, true);
	const covered = useApp(state => !!state.terminalTabId || !!state.sheet);
	const active = visible && !covered;
	const [ready, setReady] = useState(false);
	const style = useShellHeight(ref, active && ready);
	const mounted = useRef(false);
	if (active) mounted.current = true;
	// Keep a failed attempt until explicit retry, including across temporary view hiding.
	return <div ref={ref} style={style}>{mounted.current ? <SavedContent {...props} active={active} onReady={setReady} /> : props.fallback}</div>;
}
