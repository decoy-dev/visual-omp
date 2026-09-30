/** Long-running install / update / remove operations whose output streams over `*:progress`. */
import { useCallback, useState } from "react";
import { errorText } from "../format";
import { useIpcEvent } from "../shared";

export interface Operation {
	opId: string;
	/** What the operation is about (skill id, plugin name), for inline progress next to it. */
	subject: string;
	/** i18n key of the verb ("installing", "updating", "removing"). */
	verb: string;
	lines: string[];
	running: boolean;
	error: string | null;
}

/** Keep the log bounded; omp installs can print thousands of npm lines. */
const MAX_LINES = 400;

export interface Operations {
	/** Newest first. */
	list: Operation[];
	/** The running operation for `subject`, if any. */
	runningFor(subject: string): Operation | undefined;
	/** Start `run(opId)` and track its streamed output; resolves with its result. */
	start<R extends { ok: boolean; error: string | null }>(subject: string, verb: string, run: (opId: string) => Promise<R>): Promise<R>;
	dismiss(opId: string): void;
}

export function useOperations(channel: "skills:progress" | "plugins:progress"): Operations {
	const [list, setList] = useState<Operation[]>([]);
	useIpcEvent(channel, ({ opId, line }) => {
		setList(prev =>
			prev.map(op => (op.opId === opId ? { ...op, lines: [...op.lines, line].slice(-MAX_LINES) } : op)),
		);
	});
	const start = useCallback(
		async <R extends { ok: boolean; error: string | null }>(subject: string, verb: string, run: (opId: string) => Promise<R>) => {
			const opId = crypto.randomUUID();
			setList(prev => [{ opId, subject, verb, lines: [], running: true, error: null }, ...prev.filter(op => op.running || op.subject !== subject)]);
			const finish = (error: string | null) =>
				setList(prev => prev.map(op => (op.opId === opId ? { ...op, running: false, error } : op)));
			try {
				const result = await run(opId);
				finish(result.ok ? null : (result.error ?? "Failed"));
				return result;
			} catch (err) {
				finish(errorText(err));
				throw err;
			}
		},
		[],
	);
	return {
		list,
		runningFor: subject => list.find(op => op.running && op.subject === subject),
		start,
		dismiss: opId => setList(prev => prev.filter(op => op.opId !== opId)),
	};
}
