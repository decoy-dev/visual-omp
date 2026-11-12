import { describe, expect, it } from "vitest";
import { BEHIND_BYTES, CALM_MS, COOLDOWN_MS, FROZEN_MS, GRACE_MS, HEARTBEAT_MS, NO_ANSWER_MS, WindowHealth } from "./window-health";

const MIB = 1024 * 1024;
const none = new Map<string, number>();

/**
 * Drive `health` as main does: every two seconds, deliver an answer that has arrived, send a heartbeat when none is
 * outstanding and sample at once. Answers arrive `answerMs` after their heartbeat, or never when null.
 */
class Driver {
	now = GRACE_MS;
	#answerAt: number | null = null;
	constructor(readonly health = new WindowHealth()) {
		health.pageReady(0);
	}
	run(ms: number, answerMs: number | null, backlogs: ReadonlyMap<string, number> = none): void {
		for (const end = this.now + ms; this.now < end; this.now += HEARTBEAT_MS) {
			if (this.#answerAt !== null && this.#answerAt <= this.now) {
				this.health.heartbeatAnswered(this.#answerAt);
				this.#answerAt = null;
			}
			if (this.health.heartbeatDue) {
				this.health.heartbeatSent(this.now);
				this.#answerAt = answerMs === null ? null : this.now + answerMs;
			}
			this.health.sample(this.now, backlogs);
		}
	}
	/** Deliver any answer still on its way, at `at`. */
	answer(at: number): void {
		this.health.heartbeatAnswered(at);
		this.#answerAt = null;
	}
}

describe("window health", () => {
	it("warns when a heartbeat goes unanswered, reports a freeze once, and ends after a calm stretch", () => {
		const driver = new Driver();
		const { health } = driver;
		driver.run(NO_ANSWER_MS, null);
		expect(health.incident).toBeNull();
		driver.run(HEARTBEAT_MS, null);
		expect(health.incident).toMatchObject({ id: 1, slow: true, delayed: [], resyncing: [] });
		const sentAt = GRACE_MS;
		expect(health.frozen(sentAt + FROZEN_MS - 1)).toBe(false);
		expect(health.frozen(sentAt + FROZEN_MS)).toBe(true);
		expect(health.frozen(sentAt + FROZEN_MS + 1)).toBe(false);
		driver.now = sentAt + FROZEN_MS + HEARTBEAT_MS;
		driver.answer(driver.now - 1);
		// That answer was slow, so calm waits for quick ones; a full calm stretch of them ends the warning.
		driver.run(CALM_MS, 50);
		expect(health.incident).not.toBeNull();
		driver.run(2 * HEARTBEAT_MS, 50);
		expect(health.incident).toBeNull();
	});

	it("warns after three answers in a row slower than two seconds, and not before", () => {
		const driver = new Driver();
		driver.run(5 * HEARTBEAT_MS, 2_500);
		expect(driver.health.incident).toBeNull();
		driver.run(2 * HEARTBEAT_MS, 2_500);
		expect(driver.health.incident).toMatchObject({ slow: true });
	});

	it("does not judge answers during the grace after the window is shown or reloaded", () => {
		const driver = new Driver();
		driver.now = 0;
		driver.run(GRACE_MS - 1, null);
		expect(driver.health.incident).toBeNull();
	});

	it("sends nothing while a page loads, however long, and starts judging only after the page is ready", () => {
		const driver = new Driver();
		const { health } = driver;
		health.pageLoading(driver.now);
		driver.run(FROZEN_MS + 10_000, null);
		expect(health.heartbeatDue).toBe(false);
		expect(health.incident).toBeNull();
		expect(health.frozen(driver.now)).toBe(false);
		health.pageReady(driver.now);
		driver.now += GRACE_MS;
		driver.run(20_000, 50);
		expect(health.incident).toBeNull();
	});

	it("warns about a chat whose updates stay waiting, but not about a snapshot that drains", () => {
		const driver = new Driver();
		const behind = new Map([["chat-a", BEHIND_BYTES + MIB]]);
		driver.run(10_000, 50, behind);
		driver.run(4_000, 50);
		driver.run(14_000, 50, behind);
		expect(driver.health.incident).toBeNull();
		driver.run(2 * HEARTBEAT_MS, 50, behind);
		expect(driver.health.incident).toMatchObject({ slow: false, delayed: ["chat-a"] });
	});

	it("warns once for repeated resyncs, ends after ten quiet seconds, and does not reopen from the same pair", () => {
		const driver = new Driver();
		const { health } = driver;
		health.resync("chat-a", driver.now);
		health.resync("chat-b", driver.now);
		driver.run(HEARTBEAT_MS, 50);
		expect(health.incident).toBeNull();
		health.resync("chat-a", driver.now);
		driver.run(HEARTBEAT_MS, 50);
		expect(health.incident).toMatchObject({ id: 1, resyncing: ["chat-a"] });
		driver.run(CALM_MS + HEARTBEAT_MS, 50);
		expect(health.incident).toBeNull();
		driver.run(20_000, 50);
		expect(health.incident).toBeNull();
		health.resync("chat-a", driver.now);
		driver.run(HEARTBEAT_MS, 50);
		expect(health.incident).toMatchObject({ id: 2, resyncing: ["chat-a"] });
	});

	it("ends the warning when the person acts, and waits out the cooldown even while the window stays slow", () => {
		const driver = new Driver();
		const { health } = driver;
		const behind = new Map([["chat-a", BEHIND_BYTES + MIB]]);
		driver.run(20_000, 50, behind);
		expect(health.incident).toMatchObject({ id: 1, delayed: ["chat-a"] });
		expect(health.acted(driver.now)).toBe(true);
		expect(health.incident).toBeNull();
		driver.run(COOLDOWN_MS - HEARTBEAT_MS, 50, behind);
		expect(health.incident).toBeNull();
		driver.run(2 * HEARTBEAT_MS, 50, behind);
		expect(health.incident).toMatchObject({ id: 2, delayed: ["chat-a"] });
		expect(health.acted(driver.now + 1)).toBe(true);
		expect(health.acted(driver.now + 2)).toBe(false);
	});
});
