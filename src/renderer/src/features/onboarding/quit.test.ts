import type { AgentSnapshot } from "@oh-my-pi/pi-wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../../i18n/en/onboarding.json";
import { workInFlight } from "../../state/chatWork";
import type { SessionView } from "../../state/session";
import { type CopyKey, closeCopy, quitCopy, rowCopy } from "./quitCopy";

/** A chat the guard can look up: its view can change, and listeners hear of it. */
class FakeChat {
	readonly listeners = new Set<() => void>();
	constructor(
		readonly tabId: string,
		public view: SessionView,
	) {}
	getSnapshot = () => this.view;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	set(view: SessionView): void {
		this.view = view;
		for (const listener of this.listeners) listener();
	}
}

const env = vi.hoisted(() => {
	const storage = new Map<string, string>();
	const quitListeners: (() => void)[] = [];
	const invoked: unknown[][] = [];
	vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => void storage.set(key, value) });
	vi.stubGlobal("window", {
		vomp: {
			on: (channel: string, listener: () => void) => {
				if (channel === "app:quitRequested") quitListeners.push(listener);
				return () => undefined;
			},
			invoke: (...args: unknown[]) => {
				invoked.push(args);
				return Promise.resolve();
			},
		},
	});
	return {
		storage,
		quitListeners,
		invoked,
		controllers: [] as { tabId: string; getSnapshot(): unknown }[],
		/** init()'s adoption of the running omp processes, which the guard waits for. */
		adoption: Promise.withResolvers<void>(),
	};
});

vi.mock("../../ui", () => ({}));
vi.mock("./chat", () => ({ chatTitle: () => null }));
vi.mock("../../state/app", () => ({
	allControllers: () => env.controllers,
	controllerFor: (tabId: string) => env.controllers.find(controller => controller.tabId === tabId) ?? null,
	whenHostsAdopted: () => env.adoption.promise,
}));

const helper = (id: string, status: AgentSnapshot["status"]): AgentSnapshot =>
	({ id, displayName: id, kind: "sub", status, hasSessionFile: true, createdAt: 0, lastActivity: 0 }) as AgentSnapshot;
/** An open chat on a running omp whose room has synced (or is still syncing), replying or not, with these helpers. */
const view = (working: boolean, helpers: AgentSnapshot[], phase = "live") =>
	({
		mode: "live",
		host: { hostId: "h" },
		working,
		readOnly: false,
		follow: null,
		guest: { phase, agents: helpers, progress: new Map(), lifecycle: new Map() },
	}) as unknown as SessionView;
/** A restored chat with no omp attached (yet). */
const saved = { mode: "history", host: null, working: false, readOnly: false, follow: null, guest: null } as unknown as SessionView;

let chats: Record<"neither" | "reply" | "helpers" | "both", FakeChat>;

/** Lets the guard's promise chains and its zero-delay waits run, on the fake clock. */
async function flush(): Promise<void> {
	for (let round = 0; round < 3; round++) await vi.advanceTimersByTimeAsync(0);
}

/** Whether `promise` settled by now, and how: the dialog holds the answer back while it asks. */
async function state<T>(promise: Promise<T>): Promise<{ settled: boolean; value?: T }> {
	const result: { settled: boolean; value?: T } = { settled: false };
	void promise.then(value => {
		result.settled = true;
		result.value = value;
	});
	await flush();
	return result;
}

/** A fresh guard module, so a dialog left asking in one test doesn't answer the next. */
async function loadQuit() {
	vi.resetModules();
	const quit = await import("./quit");
	quit.installQuitGuard();
	return quit;
}

/** Main's quit request (⌘Q, the menu, or the window reopened to ask), as `installQuitGuard` hears it. */
async function nativeQuit(): Promise<void> {
	env.quitListeners.at(-1)?.();
	await flush();
}

const confirmQuits = () => env.invoked.filter(call => call[0] === "app:confirmQuit").map(call => call[1]);

beforeEach(() => {
	vi.useFakeTimers();
	env.storage.clear();
	env.quitListeners.length = 0;
	env.invoked.length = 0;
	env.adoption = Promise.withResolvers<void>();
	env.adoption.resolve();
	chats = {
		neither: new FakeChat("neither", view(false, [helper("Done", "idle")])),
		reply: new FakeChat("reply", view(true, [])),
		helpers: new FakeChat("helpers", view(false, [helper("Atlas", "running"), helper("Bolt", "running")])),
		both: new FakeChat("both", view(true, [helper("Atlas", "running")])),
	};
	env.controllers = Object.values(chats);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("closing a chat", () => {
	it("asks while a reply or helpers work, closes a chat at rest at once, and follows the answer", async () => {
		const { confirmCloseTab, answerQuitRequest, useQuitRequest } = await loadQuit();
		expect(await state(confirmCloseTab("neither"))).toEqual({ settled: true, value: true });
		for (const [id, allow] of [
			["reply", false],
			["helpers", true],
			["both", false],
		] as const) {
			const answer = confirmCloseTab(id);
			expect(await state(answer)).toEqual({ settled: false });
			expect(useQuitRequest.getState().request).toMatchObject({ kind: "tab", tabId: id });
			// Stop and close passes true; Keep waiting, Escape and dismissing the dialog pass false.
			answerQuitRequest(allow);
			expect(await state(answer)).toEqual({ settled: true, value: allow });
			expect(useQuitRequest.getState().request).toBeNull();
		}
	});

	it("shares the answer for the same chat, and asks about another chat after the first is answered", async () => {
		const { confirmCloseTab, answerQuitRequest, useQuitRequest } = await loadQuit();
		const first = confirmCloseTab("helpers");
		const again = confirmCloseTab("helpers");
		const other = confirmCloseTab("reply");
		await flush();
		expect(useQuitRequest.getState().request?.tabId).toBe("helpers");
		answerQuitRequest(true);
		expect(await state(first)).toEqual({ settled: true, value: true });
		expect(await state(again)).toEqual({ settled: true, value: true });
		// Stopping one chat answers nothing about the other: its own dialog follows.
		expect(await state(other)).toEqual({ settled: false });
		expect(useQuitRequest.getState().request?.tabId).toBe("reply");
		answerQuitRequest(false);
		expect(await state(other)).toEqual({ settled: true, value: false });
	});

	it("never lets Stop and close approve a quit asked while its dialog is open", async () => {
		const { confirmCloseTab, answerQuitRequest, useQuitRequest } = await loadQuit();
		// Like closeChat: an approved close removes the chat as soon as the answer comes.
		const close = confirmCloseTab("helpers").then(allow => {
			if (allow) env.controllers = env.controllers.filter(controller => controller !== chats.helpers);
			return allow;
		});
		await flush();
		await nativeQuit();
		expect(useQuitRequest.getState().request?.kind).toBe("tab");
		answerQuitRequest(true);
		expect(await state(close)).toEqual({ settled: true, value: true });
		expect(confirmQuits()).toEqual([]);
		// The quit asks about the chats still at work in its own dialog.
		expect(useQuitRequest.getState().request).toMatchObject({ kind: "quit", tabId: null });
		expect(useQuitRequest.getState().request?.chats.map(chat => chat.controller.tabId)).toEqual(["reply", "both"]);
		answerQuitRequest(false);
		await flush();
		expect(confirmQuits()).toEqual([false]);
	});
});

describe("quitting", () => {
	it("asks while any chat has a reply or helpers at work, follows the answer, and quits at once when none works", async () => {
		const { answerQuitRequest, useQuitRequest } = await loadQuit();
		for (const [working, allow] of [
			[[chats.neither, chats.helpers], false],
			[[chats.reply], true],
			[[chats.both, chats.helpers], false],
		] as const) {
			env.controllers = [...working];
			env.invoked.length = 0;
			await nativeQuit();
			expect(useQuitRequest.getState().request?.kind).toBe("quit");
			expect(confirmQuits()).toEqual([]);
			answerQuitRequest(allow);
			await flush();
			expect(confirmQuits()).toEqual([allow]);
		}
		env.controllers = [chats.neither, new FakeChat("saved", saved)];
		env.invoked.length = 0;
		await nativeQuit();
		expect(useQuitRequest.getState().request).toBeNull();
		expect(confirmQuits()).toEqual([true]);
	});

	it("waits for chats still syncing as the window opens, so their helpers count", async () => {
		const { useQuitRequest } = await loadQuit();
		const restored = new FakeChat("restored", view(false, [], "connecting"));
		env.controllers = [chats.neither, restored];
		await nativeQuit();
		expect(useQuitRequest.getState().request).toBeNull();
		expect(confirmQuits()).toEqual([]);
		restored.set(view(false, [helper("Atlas", "running")]));
		await flush();
		expect(useQuitRequest.getState().request).toMatchObject({ chats: [{ work: { replying: false, helpers: 1 } }], unchecked: [] });
		// Nothing listens once the wait is over.
		expect(restored.listeners.size).toBe(0);
	});

	it("asks about every chat it could not check when the running omp processes are not adopted in 5 seconds", async () => {
		env.adoption = Promise.withResolvers<void>();
		const { answerQuitRequest, useQuitRequest } = await loadQuit();
		const first = new FakeChat("first", saved);
		const second = new FakeChat("second", saved);
		env.controllers = [first, second];
		await nativeQuit();
		await vi.advanceTimersByTimeAsync(4_999);
		expect(useQuitRequest.getState().request).toBeNull();
		expect(confirmQuits()).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		await flush();
		expect(useQuitRequest.getState().request).toMatchObject({ kind: "quit", chats: [], unchecked: [first, second] });
		expect(confirmQuits()).toEqual([]);
		answerQuitRequest(false);
		await flush();
		expect(confirmQuits()).toEqual([false]);
	});

	it("asks about a room that has not synced in 5 seconds beside the work it knows", async () => {
		const { useQuitRequest } = await loadQuit();
		const restored = new FakeChat("restored", view(false, [], "connecting"));
		env.controllers = [chats.helpers, restored];
		await nativeQuit();
		await vi.advanceTimersByTimeAsync(5_000);
		await flush();
		const request = useQuitRequest.getState().request;
		expect(request?.chats.map(chat => chat.controller.tabId)).toEqual(["helpers"]);
		expect(request?.unchecked).toEqual([restored]);
		expect(confirmQuits()).toEqual([]);
		expect(restored.listeners.size).toBe(0);
	});

	it("subscribes to nothing when the adoption finishes after the wait, and still waits for the answer", async () => {
		env.adoption = Promise.withResolvers<void>();
		const { useQuitRequest } = await loadQuit();
		const restored = new FakeChat("restored", saved);
		env.controllers = [restored];
		await nativeQuit();
		await vi.advanceTimersByTimeAsync(5_000);
		await flush();
		expect(useQuitRequest.getState().request?.unchecked).toEqual([restored]);
		// init() attaches the chat's omp after the wait is over.
		restored.view = view(false, [], "connecting");
		env.adoption.resolve();
		await flush();
		expect(restored.listeners.size).toBe(0);
		expect(useQuitRequest.getState().request?.unchecked).toEqual([restored]);
		expect(confirmQuits()).toEqual([]);
	});

	it("keeps the warning it opened with while helpers finish, until the user answers", async () => {
		const { answerQuitRequest, useQuitRequest } = await loadQuit();
		env.controllers = [chats.helpers];
		await nativeQuit();
		chats.helpers.set(view(false, [helper("Atlas", "idle"), helper("Bolt", "parked")]));
		await flush();
		const request = useQuitRequest.getState().request;
		expect(request?.chats.map(chat => chat.work)).toEqual([{ replying: false, helpers: 2 }]);
		// Its row shows the chat as it is now.
		expect(rowCopy(workInFlight(chats.helpers.getSnapshot()))).toEqual({ key: "quit.noWork" });
		expect(confirmQuits()).toEqual([]);
		answerQuitRequest(true);
		await flush();
		expect(confirmQuits()).toEqual([true]);
	});

	it("applies Always stop to known work when quitting only, and saves it only from the quit dialog", async () => {
		const { confirmCloseTab, answerQuitRequest, useQuitRequest } = await loadQuit();
		const close = confirmCloseTab("helpers");
		await flush();
		answerQuitRequest(true, true);
		expect(await state(close)).toEqual({ settled: true, value: true });
		expect(env.storage.has("visual-omp:quit.alwaysStop")).toBe(false);
		await nativeQuit();
		answerQuitRequest(true, true);
		await flush();
		expect(env.storage.get("visual-omp:quit.alwaysStop")).toBe("1");
		// Saved: quitting with known work no longer asks, but closing a working chat still does.
		env.invoked.length = 0;
		await nativeQuit();
		expect(confirmQuits()).toEqual([true]);
		const later = confirmCloseTab("both");
		expect(await state(later)).toEqual({ settled: false });
		expect(useQuitRequest.getState().request?.kind).toBe("tab");
		answerQuitRequest(false);
		await flush();
		// A chat that could not be checked is still asked about.
		env.invoked.length = 0;
		env.controllers = [new FakeChat("restored", view(false, [], "connecting"))];
		await nativeQuit();
		await vi.advanceTimersByTimeAsync(5_000);
		await flush();
		expect(useQuitRequest.getState().request?.unchecked).toHaveLength(1);
		expect(confirmQuits()).toEqual([]);
	});
});

describe("quitAfterConfirm", () => {
	it("keeps the app open on Keep waiting without running the quit", async () => {
		const { quitAfterConfirm, answerQuitRequest } = await loadQuit();
		const quit = vi.fn(async () => undefined);
		const result = quitAfterConfirm(quit);
		await flush();
		answerQuitRequest(false);
		expect(await result).toBe(false);
		expect(quit).not.toHaveBeenCalled();
	});

	it("runs the quit once approved, and main's quit request then needs no second dialog", async () => {
		const { quitAfterConfirm, answerQuitRequest, useQuitRequest } = await loadQuit();
		const quit = vi.fn(async () => undefined);
		const result = quitAfterConfirm(quit);
		await flush();
		answerQuitRequest(true);
		expect(await result).toBe(true);
		expect(quit).toHaveBeenCalledOnce();
		await nativeQuit();
		expect(useQuitRequest.getState().request).toBeNull();
		expect(confirmQuits()).toEqual([true]);
	});

	it("asks again on the next quit when the approved quit failed", async () => {
		const { quitAfterConfirm, answerQuitRequest, useQuitRequest } = await loadQuit();
		const result = quitAfterConfirm(async () => {
			throw new Error("installer missing");
		});
		await flush();
		answerQuitRequest(true);
		await expect(result).rejects.toThrow("installer missing");
		await nativeQuit();
		expect(confirmQuits()).toEqual([]);
		expect(useQuitRequest.getState().request?.kind).toBe("quit");
	});

	it("waits for a chat still syncing before it asks, and never runs the quit unasked", async () => {
		const { quitAfterConfirm, answerQuitRequest, useQuitRequest } = await loadQuit();
		const restored = new FakeChat("restored", view(false, [], "connecting"));
		env.controllers = [restored];
		const quit = vi.fn(async () => undefined);
		const result = quitAfterConfirm(quit);
		await flush();
		expect(useQuitRequest.getState().request).toBeNull();
		restored.set(view(false, [helper("Atlas", "running")]));
		await flush();
		expect(useQuitRequest.getState().request?.chats.map(chat => chat.work)).toEqual([{ replying: false, helpers: 1 }]);
		expect(quit).not.toHaveBeenCalled();
		answerQuitRequest(true);
		expect(await result).toBe(true);
		expect(quit).toHaveBeenCalledOnce();
	});

	it("asks about a chat still syncing after 5 seconds instead of running the quit", async () => {
		const { quitAfterConfirm, useQuitRequest } = await loadQuit();
		const restored = new FakeChat("restored", view(false, [], "connecting"));
		env.controllers = [restored];
		const quit = vi.fn(async () => undefined);
		const result = quitAfterConfirm(quit);
		await vi.advanceTimersByTimeAsync(5_000);
		await flush();
		expect(useQuitRequest.getState().request?.unchecked).toEqual([restored]);
		expect(await state(result)).toEqual({ settled: false });
		expect(quit).not.toHaveBeenCalled();
	});
});

describe("quit and close copy", () => {
	const quit = messages.quit as Record<string, string>;
	/** The English text a key and count render, following i18next's `_one`/`_other` plural keys. */
	const text = ({ key, count }: CopyKey) => {
		const name = key.replace(/^quit\./, "");
		const template = count === undefined ? quit[name] : quit[`${name}_${count === 1 ? "one" : "other"}`];
		return template?.replace("{{count}}", String(count));
	};
	const body = (parts: CopyKey[]) => parts.map(text).join(" ");

	it("states the work recorded when the user chose to close, in one message", () => {
		const cases = [
			{ replying: true, helpers: 0 },
			{ replying: false, helpers: 1 },
			{ replying: false, helpers: 2 },
			{ replying: true, helpers: 3 },
		];
		expect(cases.map(work => [text(closeCopy(work).title), body(closeCopy(work).body)])).toEqual([
			[
				"Close while omp is working?",
				"When you chose to close this chat, omp was replying. Closing stops any work still running. You can reopen the saved chat later.",
			],
			[
				"Close while helpers are working?",
				"When you chose to close this chat, 1 helper was working. Closing stops any helpers still running. You can reopen the saved chat later.",
			],
			[
				"Close while helpers are working?",
				"When you chose to close this chat, 2 helpers were working. Closing stops any helpers still running. You can reopen the saved chat later.",
			],
			[
				"Close while omp and helpers are working?",
				"When you chose to close this chat, omp was replying and 3 helpers were working. Closing stops any work still running. You can reopen the saved chat later.",
			],
		]);
	});

	it("states the work recorded when the user chose to quit, and the chats it could not check", () => {
		const end = "Quitting stops any work still running. You can reopen your saved chats next time.";
		const both = quitCopy(
			[
				{ replying: true, helpers: 0 },
				{ replying: false, helpers: 2 },
				{ replying: true, helpers: 1 },
			],
			0,
		);
		expect(text(both.title)).toBe("Quit while work is running?");
		expect(body(both.body)).toBe(`When you chose to quit, omp was replying in 2 chats. 3 helpers were working as well. ${end}`);
		expect(body(quitCopy([{ replying: false, helpers: 1 }], 0).body)).toBe(`When you chose to quit, 1 helper was working. ${end}`);
		expect(body(quitCopy([{ replying: true, helpers: 0 }], 0).body)).toBe(`When you chose to quit, omp was replying in 1 chat. ${end}`);
		const unchecked = quitCopy([], 2);
		expect(text(unchecked.title)).toBe("Quit while work may be running?");
		expect(body(unchecked.body)).toBe(`visual-omp could not check whether omp is working in 2 chats. ${end}`);
		expect(body(quitCopy([{ replying: false, helpers: 2 }], 1).body)).toBe(
			`When you chose to quit, 2 helpers were working. visual-omp could not check whether omp is working in 1 chat. ${end}`,
		);
	});

	it("says what each chat in the quit list is doing now", () => {
		expect([{ replying: true, helpers: 0 }, { replying: false, helpers: 1 }, { replying: true, helpers: 2 }, null].map(work => text(rowCopy(work)))).toEqual([
			"Working",
			"1 helper working",
			"Working with 2 helpers",
			"No work running",
		]);
		expect(quit.notChecked).toBe("Not checked");
	});
});
