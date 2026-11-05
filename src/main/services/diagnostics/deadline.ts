export type DeadlineResult<T> = { completed: true; value: T } | { completed: false };

/** Stop waiting without allowing late fulfillment to run the caller's completion path. */
export function settleWithin<T>(work: Promise<T>, milliseconds: number): Promise<DeadlineResult<T>> {
	const { promise, resolve, reject } = Promise.withResolvers<DeadlineResult<T>>();
	const timer = setTimeout(() => resolve({ completed: false }), milliseconds);
	work.then(value => resolve({ completed: true, value }), reject);
	return promise.finally(() => clearTimeout(timer));
}
