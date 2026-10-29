import type { ReactNode } from "react";
import { ResultImages, ResultText } from "../parts";
import { FieldTree } from "../structured";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { argsDigest, detailsRecord, isRecord, normalizeWs, num, str, stripAnsi } from "../util";

export interface McpProgress {
	progress: number;
	total: number | null;
	message: string;
}

/** Match omp's finite-number parsing; an unbounded progress counter is never a percent. */
export function mcpProgressOf(value: unknown): McpProgress | null {
	if (!isRecord(value)) return null;
	const progress = num(value.progress);
	if (progress === null) return null;
	return { progress, total: num(value.total), message: normalizeWs(stripAnsi(str(value.message) ?? "")) };
}

export function McpProgressLine({ value, tool }: { value: McpProgress; tool?: string }): ReactNode {
	const amount = value.total !== null ? `${value.progress}/${value.total}` : String(value.progress);
	return <div className="tv-mcp-progress">{tool && <span>{tool}</span>}{value.message && <span>{value.message}</span>}{amount && <span className="tv-mcp-progress-amount">{amount}</span>}</div>;
}

/** Eval emits coalesced snapshots keyed by the MCP request id. Retain each request's newest event. */
export function evalMcpProgress(events: unknown): Array<{ id: string; tool: string; value: McpProgress }> {
	if (!Array.isArray(events)) return [];
	const latest = new Map<string, { id: string; tool: string; value: McpProgress }>();
	for (const [index, event] of events.entries()) {
		if (!isRecord(event) || event.op !== "mcp_progress") continue;
		const value = mcpProgressOf(event);
		if (!value) continue;
		const id = str(event.id) ?? String(index);
		latest.set(id, { id, tool: str(event.tool) ?? "", value });
	}
	return [...latest.values()];
}

function Summary({ args, result, running }: ToolRenderProps): ReactNode {
	const progress = running ? mcpProgressOf(detailsRecord(result)?.progress) : null;
	return <span>{progress ? [progress.message, progress.total !== null ? `${progress.progress}/${progress.total}` : progress.progress].filter(v => v !== "").join(" · ") : argsDigest(args)}</span>;
}

function Body({ args, result, running }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const progress = running ? mcpProgressOf(details?.progress) : null;
	return <>
		{Object.keys(args).length > 0 && <FieldTree value={args} />}
		{progress ? <McpProgressLine value={progress} /> : <><ResultImages result={result} /><ResultText result={result} maxLines={12} /></>}
	</>;
}

export const mcpRenderer: ToolRenderer = { Summary, Body };

/** Details also identify provider-mounted tools whose wire name has no MCP prefix. */
export function isMcpResult(details: unknown): boolean {
	return isRecord(details) && typeof details.serverName === "string" && typeof details.mcpToolName === "string";
}
