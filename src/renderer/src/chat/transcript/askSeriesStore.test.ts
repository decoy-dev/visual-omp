import type { CollabUiRequest, CollabUiRequestDraft, SessionEntry } from "@oh-my-pi/pi-wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import "../../i18n";
import type { GuestClient, GuestSnapshot } from "../../collab/lib/client";
import type { SessionController, SessionView } from "../../state/session";
import { ASK_CHAT, ASK_NEXT, ASK_OTHER } from "./askSeries";
import { AskSeriesDriver, type AskSeriesSession, askSeriesFor } from "./askSeriesStore";
import { usePendingQuestion } from "./QuestionCard";

const ARGS = {
	questions: [
		{ id: "db", question: "Which db?", options: [{ label: "SQLite" }, { label: "Postgres" }], recommended: 1 },
		{ id: "lang", question: "Which languages?", options: [{ label: "TS" }, { label: "Go" }], multi: true },
	],
};

/** omp's first request for ARGS (the shape `#runGuestAskQuestion` sends for a single choice). */
const FIRST: CollabUiRequestDraft = {
	kind: "select",
	title: "Which db?",
	options: ["SQLite", "Postgres", ASK_OTHER, ASK_CHAT],
	initialIndex: 1,
	selectionMarker: "radio",
	markableCount: 2,
};

const langSelect = (checked: number[]): CollabUiRequestDraft => ({
	kind: "select",
	title: "Which languages?",
	options: ["TS", "Go", ASK_OTHER, ...(checked.length ? [ASK_NEXT] : []), ASK_CHAT],
	selectionMarker: "checkbox",
	checkedIndices: checked,
	markableCount: 2,
});

const askResult = {
	type: "message",
	id: "r-1",
	parentId: null,
	timestamp: "",
	message: { role: "toolResult", toolCallId: "call-1", toolName: "ask", content: [], isError: false, timestamp: 0 },
} as SessionEntry;

const runningAsk = () => new Map([["call-1", { toolCallId: "call-1", toolName: "ask", args: ARGS, startedAt: 0 }]]);

/** A step of omp's script: the next request, the last request again (same id), or the end of the ask. */
type Frame = CollabUiRequestDraft | "repeat";

/**
 * A chat joined to an omp room that runs the `ask` call above. Each reply takes the next scripted
 * frame; `run` delivers frames the way they arrive over the socket, after the driver's replies.
 */
class FakeChat implements AskSeriesSession {
	view: SessionView;
	sent: [number, string | undefined][] = [];
	#client = { getSnapshot: () => this.view.guest };
	#listeners = new Set<() => void>();
	#inbox: Partial<GuestSnapshot>[] = [];
	#reqId = 1;
	#last: CollabUiRequest = { ...FIRST, reqId: 1 };
	#script: Frame[];

	constructor(script: Frame[]) {
		this.#script = script;
		const guest = { phase: "live", entries: [], stream: null, working: true, readOnly: false, loading: null, activeTools: runningAsk(), uiRequest: this.#last } as unknown as GuestSnapshot;
		this.view = { mode: "live", readOnly: false, host: { hostId: "h1", generation: 1, phase: "live" }, guest } as SessionView;
	}

	subscribe = (listener: () => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = () => this.view;

	guestClient = () => this.#client as unknown as GuestClient;

	answer(reqId: number, value: string | undefined): void {
		this.sent.push([reqId, value]);
		this.update({ uiRequest: null });
		const next = this.#script.shift();
		if (next === "repeat") this.#inbox.push({ uiRequest: this.#last });
		else if (next) {
			this.#last = { ...next, reqId: ++this.#reqId } as CollabUiRequest;
			this.#inbox.push({ uiRequest: this.#last });
		} else this.#inbox.push({ activeTools: new Map(), entries: [askResult] });
	}

	/** Lets the driver's queued replies go out, then delivers omp's frames until none are left. */
	async run(): Promise<void> {
		for (let round = 0; round < 50; round++) {
			await settle();
			const frame = this.#inbox.shift();
			if (!frame) return;
			this.update(frame);
		}
		throw new Error("omp kept asking");
	}

	update(patch: Partial<GuestSnapshot>): void {
		this.view = { ...this.view, guest: { ...(this.view.guest as GuestSnapshot), ...patch } };
		this.#emit();
	}

	setView(patch: Partial<SessionView>): void {
		this.view = { ...this.view, ...patch };
		this.#emit();
	}

	/** omp opened a new room: a new client whose request ids start over. */
	newRoom(uiRequest: CollabUiRequest | null): void {
		this.#client = { getSnapshot: () => this.view.guest };
		this.setView({ host: { ...(this.view.host as NonNullable<SessionView["host"]>), generation: 2 } });
		this.update({ uiRequest, activeTools: new Map(), entries: [] });
	}

	#emit(): void {
		for (const listener of this.#listeners) listener();
	}
}

/** Lets queued microtasks (the driver's replies) run. */
async function settle(): Promise<void> {
	for (let round = 0; round < 4; round++) await null;
}

describe("AskSeriesDriver", () => {
	it("starts on question 1, keeps answers while moving back, and replays them after the last question", async () => {
		const chat = new FakeChat([langSelect([]), langSelect([1])]);
		const driver = new AskSeriesDriver(chat);
		expect(driver.getSnapshot()).toMatchObject({ toolCallId: "call-1", heldReqId: 1, phase: "editing", index: 0, answers: [{ selected: [1] }, { selected: [] }] });

		driver.setAnswer(0, { selected: [0], custom: "" });
		driver.show(1);
		driver.submit(); // question 2 has no answer yet
		expect(driver.getSnapshot()?.phase).toBe("editing");
		driver.setAnswer(1, { selected: [0, 1], custom: "" });
		driver.show(0);
		expect(driver.getSnapshot()?.answers[1]?.selected).toEqual([0, 1]);
		driver.show(1);
		driver.setAnswer(1, { selected: [1], custom: "" }); // TS unchecked again on the way back
		expect(chat.sent).toEqual([]);

		driver.submit();
		expect(driver.getSnapshot()?.phase).toBe("sending");
		await chat.run();
		expect(chat.sent).toEqual([
			[1, "SQLite"],
			[2, "Go"],
			[3, ASK_NEXT],
		]);
		// omp finished the ask, so the series ends.
		expect(driver.getSnapshot()).toBeNull();
	});

	it("sends Chat about this at once, for the whole ask", () => {
		const chat = new FakeChat([]);
		const driver = new AskSeriesDriver(chat);
		driver.setAnswer(0, { selected: [0], custom: "" });
		driver.show(1);
		driver.chat();
		expect(chat.sent).toEqual([[1, ASK_CHAT]]);
		expect(driver.getSnapshot()).toBeNull();
	});

	it("falls back to answering by hand when omp asks something unexpected", async () => {
		const chat = new FakeChat([{ kind: "editor", title: "Something else" }]);
		const driver = new AskSeriesDriver(chat);
		driver.setAnswer(1, { selected: [0], custom: "" });
		driver.submit();
		await chat.run();
		expect(chat.sent).toEqual([[1, "Postgres"]]);
		expect(driver.getSnapshot()).toMatchObject({ phase: "fallback", fallbackWhileSending: true });
		expect(driver.getSnapshot()?.fallbackReason).toBeTruthy();
	});

	it("sends nothing while the mirror is away, then resumes only at the expected request", async () => {
		const chat = new FakeChat([langSelect([]), langSelect([1])]);
		const driver = new AskSeriesDriver(chat);
		driver.setAnswer(1, { selected: [1], custom: "" });
		driver.submit();
		// The connection drops before the queued reply goes out.
		chat.update({ phase: "reconnecting", uiRequest: null });
		await settle();
		expect(chat.sent).toEqual([]);
		// Same room, welcome again: omp hands out question 1 again.
		chat.update({ phase: "live", uiRequest: { ...FIRST, reqId: 1 } });
		await chat.run();
		expect(chat.sent.map(([, value]) => value)).toEqual(["Postgres", "Go", ASK_NEXT]);

		const stale = new FakeChat([]);
		const other = new AskSeriesDriver(stale);
		other.setAnswer(1, { selected: [1], custom: "" });
		other.submit();
		stale.update({ phase: "reconnecting", uiRequest: null });
		await settle();
		// After the reconnect omp is at question 2, which is not where the replay is.
		stale.update({ phase: "live", uiRequest: { ...langSelect([]), reqId: 7 } as CollabUiRequest });
		await settle();
		expect(stale.sent).toEqual([]);
		expect(other.getSnapshot()?.phase).toBe("fallback");
	});

	it("does not answer a request again when omp repeats it", async () => {
		const chat = new FakeChat([langSelect([]), "repeat"]);
		const driver = new AskSeriesDriver(chat);
		driver.setAnswer(1, { selected: [0, 1], custom: "" });
		driver.submit();
		await chat.run();
		// The toggle for TS went out once; the repeated request is not toggled again.
		expect(chat.sent).toEqual([
			[1, "Postgres"],
			[2, "TS"],
		]);
		expect(driver.getSnapshot()?.phase).toBe("fallback");
	});

	it("drops the series when a new room reuses the request ids", async () => {
		const chat = new FakeChat([]);
		const driver = new AskSeriesDriver(chat);
		driver.setAnswer(1, { selected: [1], custom: "" });
		driver.submit();
		chat.newRoom({ ...FIRST, reqId: 1 });
		await settle();
		expect(chat.sent).toEqual([]);
		expect(driver.getSnapshot()).toBeNull();
	});

	it("drops the series when omp exits", async () => {
		const chat = new FakeChat([]);
		const driver = new AskSeriesDriver(chat);
		driver.setAnswer(1, { selected: [1], custom: "" });
		driver.submit();
		chat.setView({ mode: "exited", host: { ...(chat.view.host as NonNullable<SessionView["host"]>), phase: "exited" } });
		await settle();
		expect(chat.sent).toEqual([]);
		expect(driver.getSnapshot()).toBeNull();
	});

	it("drops the series when the ask ends early, while answering or sending", async () => {
		const chat = new FakeChat([]);
		const driver = new AskSeriesDriver(chat);
		chat.update({ uiRequest: null, activeTools: new Map(), entries: [askResult] });
		expect(driver.getSnapshot()).toBeNull();

		const sending = new FakeChat([]);
		const other = new AskSeriesDriver(sending);
		other.setAnswer(1, { selected: [1], custom: "" });
		other.submit();
		sending.update({ activeTools: new Map(), entries: [askResult] });
		await settle();
		expect(sending.sent).toEqual([]);
		expect(other.getSnapshot()).toBeNull();
	});

	it.each([
		["Approve", "Deny"],
		["Approve", "Approve bash for this session", "Deny"],
		["Approve Directory: /tmp/project", "Approve File", "Always Approve File", "Approve Once", "Approve read for this session", "Deny"],
	])("shows a replacing approval with options %j on the usual card, unanswered", async (...options) => {
		const chat = new FakeChat([]);
		const driver = askSeriesFor(chat);
		expect(driver.getSnapshot()?.phase).toBe("editing");
		const approval: CollabUiRequest = { reqId: 5, kind: "select", title: "rm -rf build", options };
		chat.update({ uiRequest: approval });
		await settle();
		expect(chat.sent).toEqual([]);
		expect(driver.getSnapshot()).toMatchObject({ phase: "fallback", fallbackWhileSending: false });
		const Probe = () => usePendingQuestion(chat as unknown as SessionController, approval)?.node ?? null;
		const html = renderToStaticMarkup(createElement(Probe));
		expect(html).toContain('data-question-card="5"');
		expect(html).toContain("Permission needed");
		expect(html).toContain('data-approval-once=');
		expect(html).toContain("<pre");
		expect(html).not.toContain("Send answer");
		expect(html).not.toContain("data-ask-series");
		expect(chat.sent).toEqual([]);
	});
});
