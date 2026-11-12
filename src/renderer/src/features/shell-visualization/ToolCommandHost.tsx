import { useContext, useMemo, type ReactNode } from "react";
import type { ToolRenderHost } from "../../tool-render/types";
import { FileRefContext } from "../../chat/transcript/fileRefScope";
import { SavedToolOutputContext } from "../../chat/transcript/savedBashOutput";
import { SavedShellCommand } from "./SavedShellCommand";
import { LiveShellCommand, ShellAvailability, useLiveShell } from "./live";
import { useObservedShell } from "./observed";

export interface ToolCommandHost {
	host: ToolRenderHost | undefined;
	availability: ReactNode;
}

/** Extend the embedding capability without replacing saved-output recovery or ordinary bash output. */
export function useShellCommandHost(name: string, toolCallId: string | undefined, original: ToolRenderHost | undefined, running = false, hasResult = false): ToolCommandHost {
	// Only endpoint availability belongs to the outer card. Presentation revisions stay in its command consumer.
	const { projection, act } = useLiveShell(name === "bash" ? toolCallId : undefined, true);
	const observed = useObservedShell(name === "bash" ? toolCallId : undefined, true);
	const saved = useContext(SavedToolOutputContext);
	const cwd = useContext(FileRefContext)?.bases[0];
	const identity = saved?.identity;
	const file = name === "bash" && !running && hasResult && toolCallId && identity ? saved?.file : null;
	const host = useMemo<ToolRenderHost | undefined>(() => projection ? {
		...original,
		renderShellCommand: (command, fallback, envPrefix, context) => <LiveShellCommand
			key={`${projection.hostId}:${projection.generation}:${projection.epoch}:${projection.surfaceId}:${projection.nodeId}`}
			projection={projection} act={act} command={command} fallback={fallback} envPrefix={envPrefix} context={context}
		/>,
	} : observed && toolCallId ? {
		...original,
		renderShellCommand: (command, fallback, envPrefix, context) => <SavedShellCommand
			key={observed.sourceId} observedCallId={toolCallId} identity={observed.sourceId}
			toolCallId={toolCallId} cwd={observed.cwd}
			command={command} fallback={fallback} envPrefix={envPrefix} context={context}
		/>,
	} : file && toolCallId && identity ? {
		...original,
		renderShellCommand: (command, fallback, envPrefix, context) => <SavedShellCommand
			key={JSON.stringify([file, identity, toolCallId, cwd])}
			file={file} identity={identity} toolCallId={toolCallId} cwd={cwd}
			command={command} fallback={fallback} envPrefix={envPrefix} context={context}
		/>,
	} : original, [original, projection, act, observed, file, toolCallId, identity, cwd]);
	return { host, availability: <ShellAvailability projection={projection} /> };
}
