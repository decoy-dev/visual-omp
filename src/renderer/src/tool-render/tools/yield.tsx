/** Structured data handed back by a helper, with omp's normalized result or rejection. */
import type { ReactNode } from "react";
import { Markdown } from "../../transcript/Markdown";
import { Badge, Output, ResultText } from "../parts";
import { FieldTree } from "../structured";
import type { ToolRenderer, ToolRenderProps, ToolResultLike } from "../types";
import { argsDigest, detailsRecord, resultTextOf, str } from "../util";

export function yieldSubmission(args: Record<string, unknown>, result?: ToolResultLike) {
	const details = result?.isError ? null : detailsRecord(result);
	const type = details?.type ?? args.type;
	const labels = typeof type === "string" ? [type] : Array.isArray(type) ? type.filter((label): label is string => typeof label === "string") : [];
	const data = details?.data !== undefined ? details.data : args.data;
	const text = resultTextOf(result).trim();
	const error = result?.isError ? text || str(args.error) : details?.status === "aborted" ? str(details.error) || text || str(args.error) : details ? str(details.error) : str(args.error);
	return { labels, data, error };
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const submission = yieldSubmission(args, result);
	return <>{submission.labels.map((label, index) => <Badge key={index}>{label}</Badge>)}<span>{argsDigest(submission.data ?? submission.error)}</span></>;
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const submission = yieldSubmission(args, result);
	return <>
		{submission.labels.length > 0 && <div>{submission.labels.map((label, index) => <Badge key={index}>{label}</Badge>)}</div>}
		{submission.error && <Output text={submission.error} error maxLines={12} />}
		{submission.data !== undefined && (typeof submission.data === "string" ? <Markdown text={submission.data} /> : <FieldTree value={submission.data} />)}
		{submission.data === undefined && !submission.error && <ResultText result={result} maxLines={6} />}
	</>;
}

export const yieldRenderer: ToolRenderer = { Summary, Body };
