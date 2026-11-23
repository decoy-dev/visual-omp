/** `bash` — shell command execution: prompt line with env prefix, badges, output tail. */
import type { ReactNode } from "react";
import { formatBytes } from "../../features/projects/format";
import { fmtDuration } from "../../collab/lib/format";
import { Badge, InvalidArg, PathText, ResultImages, ResultText, Row } from "../parts";
import { genericRenderer } from "../generic";
import { lookupToolRenderer } from "../lookup";
import { isSoleInvocation, partitionToolCommandImages, toolCommandRecords } from "../toolCommands";
import type { ToolRenderer, ToolRenderProps, ToolResultLike } from "../types";
import { detailsRecord, display, isRecord, normalizeWs, num, resultTextOf, str, truncate } from "../util";

/** Values safe to show unquoted in a `NAME=value` shell prefix. */
const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

/** Footer appended by the bash tool when long output was spilled: `artifact://N` before omp 19, `local://N.log` from 19.0. */
const ARTIFACT_NOTICE = /\[raw output: (?:artifact:\/\/([\w-]+)|local:\/\/([\w-]+)\.log)\]/;

function envPrefix(env: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const k in env) {
		const v = display(env[k]);
		parts.push(`${k}=${SHELL_SAFE.test(v) ? v : JSON.stringify(v)}`);
	}
	return parts.join(" ");
}

interface BashAsyncDetails {
	state: string;
	jobId: string | null;
}

function asyncDetailsOf(details: Record<string, unknown> | null): BashAsyncDetails | null {
	if (!details || !isRecord(details.async)) return null;
	const state = str(details.async.state);
	return state ? { state, jobId: str(details.async.jobId) } : null;
}

/** omp 18.16 records the rewrite separately from truncation and the raw-output footer. */
function minimizedDetailsOf(details: Record<string, unknown> | null): string | null {
	if (!isRecord(details?.meta) || !isRecord(details.meta.minimized)) return null;
	const { filter, inputBytes, outputBytes } = details.meta.minimized;
	if (typeof filter !== "string" || !filter.trim() || /[\u0000-\u001f\u007f]/.test(filter)) return null;
	if (typeof inputBytes !== "number" || !Number.isSafeInteger(inputBytes) || inputBytes < 0) return null;
	if (typeof outputBytes !== "number" || !Number.isSafeInteger(outputBytes) || outputBytes < 0) return null;
	return `omp's ${filter.trim()} filter changed this output from ${formatBytes(inputBytes)} to ${formatBytes(outputBytes)}.`;
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const command = args.command === undefined ? "…" : str(args.command);
	if (command === null) return <InvalidArg what="command" />;
	const text = truncate(normalizeWs(command) || "…", 80);
	return result?.isError ? <span className="tv-err-text">{text}</span> : <span>{text}</span>;
}

function Body({ args, result, running, host }: ToolRenderProps): ReactNode {
	const command = args.command === undefined ? "…" : str(args.command);
	const prefix = isRecord(args.env) ? envPrefix(args.env) : "";
	const cwd = str(args.cwd);
	const head = num(args.head);
	const tail = num(args.tail);

	const details = detailsRecord(result);
	const exitCode = num(details?.exitCode);
	const wallTimeMs = num(details?.wallTimeMs);
	const timeoutSeconds = num(args.timeout) ?? num(details?.timeoutSeconds);
	const requestedTimeoutSeconds = num(details?.requestedTimeoutSeconds);
	const job = asyncDetailsOf(details);
	const minimized = minimizedDetailsOf(details);
	const notice = ARTIFACT_NOTICE.exec(resultTextOf(result));
	const artifactId = notice?.[1] ?? notice?.[2] ?? null;

	const stats: string[] = [];
	if (wallTimeMs !== null) {
		stats.push(`Duration ${fmtDuration(wallTimeMs)}`);
	}
	if (requestedTimeoutSeconds !== null && requestedTimeoutSeconds !== timeoutSeconds) {
		stats.push(`Requested timeout ${requestedTimeoutSeconds}s was clamped`);
	}
	if (job?.jobId) stats.push(`Job ${job.jobId}`);
	if (artifactId) stats.push(`Artifact ${artifactId}`);

	const plainCommand = (
		<div className="tv-cmd">
			<span className="tv-cmd-prompt">$</span>
			<span className="tv-cmd-text">
				{prefix && <span className="tv-cmd-env">{`${prefix} `}</span>}
				{command ?? <InvalidArg what="command" />}
			</span>
		</div>
	);

	const toolCommands = toolCommandRecords(result);
	const { byIndex: commandImages, remaining: remainingImages } = partitionToolCommandImages(command, result, toolCommands);
	const textBlocks = result ? result.content.filter(block => isRecord(block) && block.type === "text") : [];
	const soleExecute = toolCommands.length === 1 && toolCommands[0]?.mode === "execute" && isSoleInvocation(command, toolCommands[0].tool);
	const soleSpecialized = soleExecute && lookupToolRenderer(toolCommands[0]!.tool, toolCommands[0]!.inner) !== genericRenderer;
	const remainingImageResult: ToolResultLike | undefined = remainingImages.length > 0
		? { content: remainingImages, details: result?.details, isError: result?.isError }
		: undefined;
	// A sole call with its own renderer shows the text itself; a live command shows a chosen step's output instead.
	const resultText = toolCommands.length > 0 && soleSpecialized && result?.isError !== true ? null : <ResultText result={result} maxLines={12} />;
	const output = host?.renderShellOutput ? host.renderShellOutput(resultText) : resultText;

	return (
		<>
			{command !== null ? host?.renderShellCommand?.(command, plainCommand, prefix, { cwd: str(details?.cwd) ?? cwd ?? undefined, cdSeparator: details?.cdSeparator === ";" ? ";" : undefined, trace: isRecord(details?.trace) ? details.trace : undefined }) ?? plainCommand : plainCommand}
			<div className="tv-bash-meta">
				{cwd && <Badge>Folder <PathText path={cwd} kind="folder" /></Badge>}
				{timeoutSeconds !== null && <Badge>Timeout {timeoutSeconds}s</Badge>}
				{args.pty === true && <Badge tone="accent">Terminal</Badge>}
				{!job && args.async === true && <Badge tone="accent">Background requested</Badge>}
				{head !== null && <Badge>First {head} {head === 1 ? "line" : "lines"}</Badge>}
				{tail !== null && <Badge>Last {tail} {tail === 1 ? "line" : "lines"}</Badge>}
				{exitCode !== null && <Badge tone={exitCode === 0 ? "ok" : "err"}>Exit {exitCode}</Badge>}
				{job && <Badge tone={job.state === "failed" ? "err" : job.state === "running" ? "accent" : job.state === "completed" ? "ok" : undefined}>Background {job.state}</Badge>}
			</div>
			{toolCommands.length > 0 ? (
				<>
					{toolCommands.map((record, index) => {
						const recordRunning = running === true && index === toolCommands.length - 1;
						const recordFailed = !recordRunning && record.exitCode !== 0;
						if (record.mode === "help") {
							return (
								<Row key={`cmd-${index}`} k="help">
									<code>{record.tool} --help</code>
									{recordFailed && <> <Badge tone="err">Exit {record.exitCode}</Badge></>}
								</Row>
							);
						}
						const nestedRenderer = lookupToolRenderer(record.tool, record.inner);
						const nestedResult: ToolResultLike = {
							content: [...(commandImages.get(index) ?? []), ...(soleExecute ? textBlocks : [])],
							details: record.inner,
							isError: recordFailed || (!recordRunning && soleExecute && result?.isError === true),
						};
						const nestedProps: ToolRenderProps = {
							name: record.tool,
							args: record.args,
							result: nestedResult,
							running: recordRunning,
							host,
						};
						return (
							<div key={`cmd-${index}`} className="tv-list">
								<Row k={record.tool}>
									<nestedRenderer.Summary {...nestedProps} />
									{recordFailed && <> <Badge tone="err">Exit {record.exitCode}</Badge></>}
								</Row>
								{nestedRenderer.Body ? <nestedRenderer.Body {...nestedProps} /> : null}
							</div>
						);
					})}
					{remainingImageResult && <ResultImages result={remainingImageResult} />}
					{output}
				</>
			) : (
				<>
					<ResultImages result={result} />
					{output}
				</>
			)}
			{minimized && <Row><span className="tv-bash-minimized">{minimized}</span></Row>}
			{stats.length > 0 && <Row><span className="tv-bash-meta">{stats.join(" · ")}</span></Row>}
		</>
	);
}

export const bashRenderer: ToolRenderer = { Summary, Body };
