import { usePresentationClaim } from "../../state/tsp/presentation-claims";
import { useLiveShell, type LiveShellCommandProps } from "./live";
import { ShellView } from "./ShellView";
import { useObservedShell } from "./observed";

/** A failed or still-loading chunk never claims content it has not rendered. */
export function LiveShellContent({ projection: identity, command, fallback, envPrefix, context }: LiveShellCommandProps) {
	const { projection, act } = useLiveShell(identity.toolCallId);
	const observed = useObservedShell(identity.toolCallId);
	usePresentationClaim(projection ? { hostId: projection.hostId, epoch: projection.epoch, surfaceId: projection.surfaceId, nodeId: projection.nodeId } : null);
	if (!projection) return fallback;
	return <>{envPrefix && <pre className="mb-2 whitespace-pre-wrap break-words font-mono text-code text-fg-muted">{envPrefix}</pre>}<ShellView props={projection.props} context={{ ...context, cdSeparator: observed?.cdSeparator ?? context?.cdSeparator, trace: observed?.trace ?? context?.trace }} command={command} onAction={act} showOutput={false} /></>;
}
