import type { ReactNode } from "react";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord } from "../util";
import { ircRenderer } from "./irc";
import { jobRenderer } from "./job";

/**
 * A wait that news cut short (`interrupted`): omp 18.18.9 delivers the message that ended it as its own turn right
 * after the wait instead of in its result, so the card only says why it ended, as omp's own renderer does.
 */
function interrupted(props: ToolRenderProps): boolean {
	return detailsRecord(props.result)?.interrupted === true && props.result?.isError !== true;
}

/** A consumed peer message renders as IRC; otherwise show the job snapshot. */
function Summary(props: ToolRenderProps): ReactNode {
	if (interrupted(props)) return <span className="tv-muted">interrupted by message</span>;
	return detailsRecord(props.result)?.waited ? (
		<ircRenderer.Summary {...props} args={{ op: "wait" }} />
	) : (
		<jobRenderer.Summary {...props} args={{ poll: [] }} />
	);
}

function Body(props: ToolRenderProps): ReactNode {
	if (interrupted(props)) return null;
	return detailsRecord(props.result)?.waited ? (
		ircRenderer.Body ? (
			<ircRenderer.Body {...props} args={{ op: "wait" }} />
		) : null
	) : jobRenderer.Body ? (
		<jobRenderer.Body {...props} args={{ poll: [] }} />
	) : null;
}

export const waitRenderer: ToolRenderer = { Summary, Body };
