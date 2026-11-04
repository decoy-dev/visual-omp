import type { TspNode } from "@shared/tsp";
import { useApp } from "../../state/app";
import { usePresentationClaim } from "../../state/tsp/presentation-claims";
import { LoadFailedNotice, lazyView } from "../../registry/lazy";
import type { NodeContext } from "../../features/tsp/nodes/context";
import { RunOutput, RunRow } from "./RunRow";
import { nativeRunBody, nativeRunOutput, type NativeRun } from "./localRuns";

// If the node views do not load, the transcript row shows a compact failure notice with Try again.
const NodeView = lazyView(() => import("../../features/tsp/nodes/NodeView").then(module => module.NodeView), null, LoadFailedNotice);

/** Matched nodes are claimed only while their saved row is part of the rendered transcript window. */
function NativeRunConsumer({ item, visibleEntries, visible }: { item: NativeRun; visibleEntries: ReadonlySet<string>; visible: boolean }) {
	const rendered = item.entryId === undefined || visibleEntries.has(item.entryId);
	usePresentationClaim(rendered ? item.target : null, visible && rendered);
	if (item.entryId !== undefined) return null;
	const context: NodeContext = { sf: item.target.surfaceId, hostId: item.target.hostId, readOnly: true, send() {}, keys() {}, render: (node: TspNode) => <NodeView key={node.id} node={node} context={context} /> };
	return <div data-row><RunRow run={item.run}><div className="tv-body space-y-2"><RunOutput text={nativeRunOutput(item.node)} />{item.node.c?.flatMap(nativeRunBody).map(node => context.render(node))}</div></RunRow></div>;
}

export function NativeRunRows({ items, visibleEntries, tabId, hidden }: { items: readonly NativeRun[]; visibleEntries: ReadonlySet<string>; tabId: string; hidden: boolean }) {
	const covered = useApp(state => state.terminalTabId === tabId);
	return items.map(item => <NativeRunConsumer key={JSON.stringify(item.target)} item={item} visibleEntries={visibleEntries} visible={!hidden && !covered} />);
}
