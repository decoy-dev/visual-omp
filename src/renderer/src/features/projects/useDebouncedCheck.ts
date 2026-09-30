import { useEffect, useState } from "react";

export interface DebouncedCheck<T> {
	/** Answer for the current value and context; null while pending, blank, or after a failure. */
	result: T | null;
	pending: boolean;
	/** Why the check itself failed (IPC or filesystem error), for the current value and context. */
	error: string | null;
}

interface Settled<T> {
	value: string;
	context: string;
	result: T | null;
	error: string | null;
}

/** Electron wraps handler errors as "Error invoking remote method 'x': Error: …"; keep the cause. */
function failureText(failure: unknown): string {
	const text = failure instanceof Error ? failure.message : String(failure);
	return text.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "");
}

/**
 * Run `check(value)` `delay` ms after `value` settles; stale answers are dropped. `context` names
 * whatever else the check depends on (e.g. the parent folder): an answer computed for another value
 * or another context is never returned, so it cannot unlock the next step.
 */
export function useDebouncedCheck<T>(value: string, delay: number, check: (value: string) => Promise<T>, context = ""): DebouncedCheck<T> {
	const [state, setState] = useState<Settled<T>>({ value: "", context, result: null, error: null });
	useEffect(() => {
		if (!value.trim()) {
			setState({ value, context, result: null, error: null });
			return;
		}
		let live = true;
		const timer = setTimeout(() => {
			check(value).then(
				result => live && setState({ value, context, result, error: null }),
				(failure: unknown) => live && setState({ value, context, result: null, error: failureText(failure) }),
			);
		}, delay);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [value, delay, check, context]);
	const current = state.value === value && state.context === context;
	return {
		result: current ? state.result : null,
		pending: Boolean(value.trim()) && !current,
		error: current ? state.error : null,
	};
}
