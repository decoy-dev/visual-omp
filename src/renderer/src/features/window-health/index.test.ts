import type { WindowHealthIncident } from "@shared/contracts/window-health";
import { beforeEach, expect, it, vi } from "vitest";

const env = vi.hoisted(() => {
	const listeners = new Map<string, (payload: unknown) => void>();
	const invoked: unknown[][] = [];
	vi.stubGlobal("window", { vomp: { on: (channel: string, listener: (payload: unknown) => void) => { listeners.set(channel, listener); return () => {}; }, invoke: (...args: unknown[]) => { invoked.push(args); return Promise.resolve(); } } });
	return { serial: 0, listeners, invoked, toasts: [] as { id: string; options: Record<string, unknown>; dismissed: boolean }[], closeIdle: vi.fn(async () => 2 as number | null) };
});
vi.mock("../../ui/toast", () => ({
	toast: (options: Record<string, unknown>) => { const id = `t${env.serial++}`; env.toasts.push({ id, options, dismissed: false }); return id; },
	dismissToast: (id: string) => {
		// A toast from an earlier test is already gone.
		const entry = env.toasts.find(item => item.id === id);
		if (!entry) return;
		entry.dismissed = true;
		(entry.options.onDismiss as (() => void) | undefined)?.();
	},
	updateToast: (id: string, patch: Record<string, unknown>) => Object.assign(env.toasts.find(item => item.id === id)!.options, patch),
}));
vi.mock("../../state/app", () => ({
	allControllers: () => [{ hostId: "host-a", tabId: "tab-a", getSnapshot: () => null }],
	closeIdleChats: env.closeIdle,
	useApp: { getState: () => ({ tabs: [{ id: "tab-a", title: "Release notes" }] }) },
}));
import "../../i18n";
import "./index";

const incident = (patch: Partial<WindowHealthIncident>): WindowHealthIncident => ({ id: 1, slow: false, delayed: [], resyncing: [], ...patch });
const health = (value: WindowHealthIncident | null) => env.listeners.get("window:health")!(value);

beforeEach(() => {
	env.toasts.length = 0;
	env.invoked.length = 0;
});

it("names the delayed chat, keeps one warning per slowdown, and removes it once the window keeps up", async () => {
	health(incident({ id: 1, delayed: ["host-a"] }));
	expect(env.toasts).toHaveLength(1);
	expect(env.toasts[0]!.options).toMatchObject({
		tone: "warn", sticky: true, message: "Chat updates are delayed",
		description: "Updates for Release notes are waiting to reach this window. Reloading the window reconnects your open chats.",
	});
	health(incident({ id: 1, delayed: ["host-a", "host-b"] }));
	expect(env.toasts).toHaveLength(1);
	expect(env.toasts[0]!.options.description).toContain("Updates for 2 chats are waiting");
	// A slow window replaces the title, without counting as a dismissal.
	health(incident({ id: 1, slow: true, delayed: ["host-a"] }));
	expect(env.toasts.map(item => [item.options.message, item.dismissed])).toEqual([["Chat updates are delayed", true], ["visual-omp is responding slowly", false]]);
	health(null);
	expect(env.toasts[1]!.dismissed).toBe(true);
});

it("runs Reload window and Close idle chats, and leaves a dismissed slowdown dismissed", async () => {
	health(incident({ id: 2, resyncing: ["host-a"] }));
	const shown = env.toasts[0]!;
	expect(shown.options.description).toContain("The connection for Release notes has restarted repeatedly");
	(shown.options.action as { onClick(): void }).onClick();
	expect(env.invoked).toEqual([["window:reload"]]);
	(shown.options.secondaryAction as { onClick(): void }).onClick();
	await vi.waitFor(() => expect(env.invoked).toContainEqual(["window:healthActed"]));
	// The person closes the warning; the same slowdown does not bring it back, a new one does.
	(shown.options.onDismiss as () => void)();
	health(incident({ id: 2, resyncing: ["host-a"], slow: true }));
	expect(env.toasts).toHaveLength(1);
	health(incident({ id: 3, slow: true }));
	expect(env.toasts).toHaveLength(2);
});

it("answers heartbeats", async () => {
	// Development builds (like this test) answer through dev.ts, which loads after the module.
	await vi.waitFor(() => expect(env.listeners.has("window:ping")).toBe(true));
	env.listeners.get("window:ping")!(7);
	expect(env.invoked).toEqual([["window:heartbeat", 7]]);
});

it("reports an action only when Close idle chats closed something", async () => {
	health(incident({ id: 4, slow: true }));
	env.closeIdle.mockResolvedValueOnce(0);
	(env.toasts[0]!.options.secondaryAction as { onClick(): void }).onClick();
	await Promise.resolve();
	await Promise.resolve();
	expect(env.invoked).toEqual([]);
});
