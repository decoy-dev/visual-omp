import type { BtwState, BtwTopicRef } from "../../../shared/contracts/btw";
import type { TspHostSnapshot } from "../../../shared/tsp-host";
import { projectBtw, sameBtwTopic, type BtwProjection } from "../../../shared/tsp/btw";
import { BTW_COMMAND_OUTCOME, commandOutcome } from "../../../shared/tsp/command-result";
import { TSP_ACTIONS } from "../../../shared/tsp/roles";
import type { TspSession } from "./session";

export type BtwOperation = "ask" | "select" | "followUp" | "stop" | "close" | "inject";
export interface BtwDriverContext {
	session: TspSession;
	snapshot(): TspHostSnapshot;
	state(): BtwState;
	assertCurrent(): void;
}

/** One entire operation runs under SessionHost's application-input lock. Credits remain independent. */
export class BtwDriver {
	readonly #ctx: BtwDriverContext;
	readonly #before: TspHostSnapshot;
	constructor(context: BtwDriverContext) { this.#ctx = context; this.#before = context.snapshot(); }
	#snapshot(): TspHostSnapshot {
		this.#ctx.assertCurrent();
		const snapshot = this.#ctx.snapshot();
		if (snapshot.hostId !== this.#before.hostId || snapshot.generation !== this.#before.generation || snapshot.epoch !== this.#before.epoch || snapshot.lifecycle !== "live" || snapshot.closing) throw new Error("The chat changed before the side-question action finished.");
		return snapshot;
	}
	#overlay(): BtwProjection | null {
		const snapshot = this.#snapshot();
		return projectBtw(snapshot.surfaces.filter(surface => surface.documentGeneration === snapshot.generation));
	}
	#authority(overlay: BtwProjection): NonNullable<BtwState["overlay"]> {
		this.#snapshot();
		const state = this.#ctx.state();
		if (state.hostId !== this.#before.hostId || state.generation !== this.#before.generation || state.epoch !== this.#before.epoch
			|| state.overlay?.surfaceId !== overlay.surfaceId || state.overlay.nodeId !== overlay.nodeId) throw new Error("The side-question history changed before the action.");
		return state.overlay;
	}
	#assertSelected(overlay: BtwProjection, topic: BtwTopicRef | null): void {
		const selected = this.#authority(overlay).selectedTopic;
		if (topic === null ? selected !== null : !sameBtwTopic(topic, selected)) throw new Error("The selected side conversation changed before the action.");
	}
	async #wait(predicate: () => boolean, reason: string): Promise<void> {
		await this.#ctx.session.waitFor(() => {
			const snapshot = this.#snapshot();
			const outcome = commandOutcome(this.#before, snapshot, BTW_COMMAND_OUTCOME);
			if (outcome?.status === "error") throw new Error(outcome.lines.join("\n"));
			return predicate();
		}, () => { this.#snapshot(); }, 8000, reason);
	}
	async #action(action: string, topic: BtwTopicRef | null): Promise<void> {
		const overlay = this.#overlay();
		const id = overlay?.actions[action];
		if (!overlay || !id) throw new Error("The side question no longer offers this action.");
		this.#assertSelected(overlay, topic);
		await this.#ctx.session.send({ ev: "action", sf: overlay.surfaceId, id, act: action }, () => {
			const current = this.#overlay();
			if (current?.nodeId !== overlay.nodeId || current.surfaceId !== overlay.surfaceId || current.actions[action] !== id) throw new Error("The side question changed before the action could be sent.");
			this.#assertSelected(current, topic);
		});
	}
	async #open(): Promise<BtwProjection> {
		if (!this.#overlay()) {
			await this.#ctx.session.submit("/btw", () => { this.#snapshot(); }, surface => this.#snapshot().surfaces.some(item => item.open.id === surface && item.documentGeneration === this.#before.generation));
			await this.#wait(() => !!this.#overlay(), "omp did not open the side-question history.");
		}
		return this.#overlay()!;
	}
	async #select(topic: BtwTopicRef): Promise<BtwProjection> {
		let overlay = await this.#open();
		const authority = this.#authority(overlay);
		if (!authority.topics.some(ref => sameBtwTopic(ref, topic))) throw new Error("This side conversation is unavailable in the current omp view.");
		if (sameBtwTopic(authority.selectedTopic, topic)) return overlay;
		if (overlay.field) throw new Error("Finish or cancel the open side-question follow-up first.");
		// A raw omp item id is safe only after the scoped identity belongs to this overlay.
		const item = overlay.topics.find(item => item.id === topic.id);
		if (!overlay.list || !item) throw new Error("This side conversation is unavailable in the current omp view.");
		const target = overlay;
		await this.#ctx.session.send({ ev: "select", sf: overlay.surfaceId, id: overlay.list.nodeId, item: item.itemId }, () => {
			const current = this.#overlay();
			if (current?.nodeId !== target.nodeId || current.list?.nodeId !== target.list?.nodeId || current.field
				|| !current.topics.some(topic => topic.itemId === item.itemId)
				|| !this.#authority(current).topics.some(ref => sameBtwTopic(ref, topic))) throw new Error("The side-question history changed before selection.");
		});
		await this.#wait(() => {
			const current = this.#overlay();
			return !!current && sameBtwTopic(this.#authority(current).selectedTopic, topic);
		}, "omp did not select the side conversation.");
		overlay = this.#overlay()!;
		return overlay;
	}
	async run(operation: BtwOperation, text = "", topic?: BtwTopicRef | null): Promise<void> {
		this.#snapshot();
		if (operation === "select") {
			if (!topic) throw new Error("Choose a side conversation first.");
			await this.#select(topic);
			return;
		}
		if (operation === "close") {
			const overlay = this.#overlay();
			if (!overlay) return;
			const original = topic === undefined ? this.#authority(overlay).selectedTopic : topic;
			this.#assertSelected(overlay, original);
			// Closing never cancels a side answer. A follow-up draft is explicitly discarded first.
			if (overlay.field) {
				await this.#action(TSP_ACTIONS.btwDiscard, original);
				await this.#wait(() => !this.#overlay()?.field, "omp did not cancel the unsent follow-up.");
			}
			const target = this.#overlay();
			if (!target) return;
			await this.#action(TSP_ACTIONS.close, original);
			await this.#wait(() => this.#overlay()?.nodeId !== target.nodeId, "omp did not close the side-question history.");
			return;
		}
		if (operation === "stop") {
			const overlay = await this.#open();
			const original = topic ?? this.#authority(overlay).selectedTopic;
			if (!original) throw new Error("Choose a side conversation first.");
			await this.#action(TSP_ACTIONS.btwStop, original);
			await this.#wait(() => { const current = this.#overlay(); if (current) this.#assertSelected(current, original); return !current?.actions[TSP_ACTIONS.btwStop]; }, "omp did not stop the side answer.");
			await this.run("close", "", original);
			return;
		}
		if (operation === "ask") {
			if (!text.trim()) { await this.#open(); return; }
			if (this.#overlay()?.field) throw new Error("Finish or cancel the open side-question follow-up first.");
			if (this.#overlay()) await this.run("close");
			await this.#ctx.session.submit(`/btw ${text.trim()}`, () => { this.#snapshot(); }, surface => this.#snapshot().surfaces.some(item => item.open.id === surface && item.documentGeneration === this.#before.generation));
			await this.#wait(() => !!this.#overlay()?.turns.length, "omp did not start the side question. Your question is kept.");
			return;
		}
		if (!topic) throw new Error("Choose a side conversation first.");
		let overlay = await this.#select(topic);
		if (operation === "inject") {
			await this.#action(TSP_ACTIONS.btwInject, topic);
			await this.#wait(() => { const current = this.#overlay(); if (current) this.#assertSelected(current, topic); return current?.turns.at(-1)?.inject?.sent === true; }, "omp did not confirm the steering prompt.");
			return;
		}
		if (!text.trim()) throw new Error("Enter a follow-up question.");
		const beforeTurns = overlay.turns.length;
		if (!overlay.field) {
			await this.#action(TSP_ACTIONS.btwFollowUp, topic);
			await this.#wait(() => !!this.#overlay()?.field, "omp did not open the follow-up field.");
			overlay = this.#overlay()!;
		}
		const field = overlay.field!;
		const value = text.trim();
		await this.#ctx.session.send({ ev: "edit", sf: overlay.surfaceId, id: field.nodeId, from: 0, to: field.text.length, text: value, cursor: value.length, len: field.text.length }, () => {
			const current = this.#overlay();
			if (current?.field?.nodeId !== field.nodeId || current.field.text !== field.text) throw new Error("The follow-up field changed before the edit.");
			this.#assertSelected(current, topic);
		});
		await this.#wait(() => this.#overlay()?.field?.text === value, "omp did not accept the follow-up text. Your draft is kept.");
		await this.#action(TSP_ACTIONS.btwSend, topic);
		await this.#wait(() => { const current = this.#overlay(); if (current) this.#assertSelected(current, topic); return !current?.field && (current?.turns.length ?? 0) > beforeTurns; }, "omp did not start the follow-up. Your draft is kept.");
	}
}
