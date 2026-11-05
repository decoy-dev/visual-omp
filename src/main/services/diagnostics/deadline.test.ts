import { afterEach, expect, it, vi } from "vitest";
import { settleWithin } from "./deadline";

afterEach(() => vi.useRealTimers());
it("settles after a finite deadline when work never settles", async () => {
	vi.useFakeTimers();
	const { promise } = Promise.withResolvers<void>();
	const waiting = settleWithin(promise, 1500);
	await vi.advanceTimersByTimeAsync(1500);
	await expect(waiting).resolves.toEqual({ completed: false });
	expect(vi.getTimerCount()).toBe(0);
});
it("does not run a completion path when timed-out work fulfills later", async () => {
	vi.useFakeTimers();
	const { promise, resolve } = Promise.withResolvers<void>();
	const completed = vi.fn();
	const waiting = settleWithin(promise, 1500).then(result => { if (result.completed) completed(); });
	await vi.advanceTimersByTimeAsync(1500);
	await waiting;
	resolve();
	await Promise.resolve();
	expect(completed).not.toHaveBeenCalled();
});
it("preserves early completion and rejection and clears their deadline timers", async () => {
	vi.useFakeTimers();
	await expect(settleWithin(Promise.resolve(42), 1500)).resolves.toEqual({ completed: true, value: 42 });
	await expect(settleWithin(Promise.reject(new Error("failure")), 1500)).rejects.toThrow("failure");
	expect(vi.getTimerCount()).toBe(0);
});
