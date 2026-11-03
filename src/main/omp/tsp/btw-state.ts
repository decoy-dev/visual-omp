import type { BtwState, BtwTopic, BtwTopicRef } from "../../../shared/contracts/btw";
import type { TspHostSnapshot } from "../../../shared/tsp-host";
import { btwOverlayTopics, btwTopicKey, mergeBtwTopics, projectBtw, resolveBtwTopic, sameBtwTopic } from "../../../shared/tsp/btw";
import { watchBtwHistory, type BtwHistoryWatcher } from "../btw-history";

/** Read-only disk subscription plus per-host live identities. No answer-completion timers. */
export class BtwHistoryState {
	readonly #publish: (state: BtwState) => void;
	#watcher: BtwHistoryWatcher | null = null;
	#scope = "";
	#snapshot: TspHostSnapshot | null = null;
	#persisted: BtwTopic[] = [];
	#recovered = new Set<string>();
	#initialRead = true;
	#liveSequence = 0;
	#liveKey = "";
	#liveRef: BtwTopicRef = { id: "live:0" };
	#resolvedRef: BtwTopicRef | null = null;
	#liveViews = new Map<string, boolean>();
	#aliases = new Map<string, BtwTopicRef>();
	#sessionFile: string | null = null;
	#state: BtwState | null = null;
	#signature = "";
	#revision = 0;
	constructor(publish: (state: BtwState) => void) { this.#publish = publish; }
	get state(): BtwState | null { return this.#state; }
	resolveTopicRef(topic: BtwTopicRef): BtwTopicRef { return this.#aliases.get(btwTopicKey(topic)) ?? topic; }
	update(snapshot: TspHostSnapshot, sessionFile: string | null, processStartedAt: number): void {
		const scope = JSON.stringify([snapshot.hostId, snapshot.generation, snapshot.epoch, sessionFile]);
		const sameSession = this.#snapshot?.generation === snapshot.generation && this.#snapshot.epoch === snapshot.epoch && (!this.#sessionFile || this.#sessionFile === sessionFile);
		this.#sessionFile = sessionFile;
		this.#snapshot = snapshot;
		if (scope !== this.#scope) {
			this.#watcher?.close();
			this.#scope = scope;
			this.#persisted = [];
			this.#recovered.clear();
			this.#initialRead = true;
			if (!sameSession) { this.#liveKey = ""; this.#resolvedRef = null; this.#aliases.clear(); this.#liveViews.clear(); this.#state = null; }
			this.#watcher = sessionFile ? watchBtwHistory(sessionFile, topics => {
				if (scope !== this.#scope) return;
				if (this.#initialRead) for (const topic of topics) if (topic.turns.some(turn => turn.status === "running" && (turn.updatedAt ?? turn.createdAt) < processStartedAt)) this.#recovered.add(btwTopicKey(topic));
				this.#initialRead = false;
				this.#persisted = topics;
				this.#reconcile();
			}, { includeScopes: true }) : null;
		}
		this.#reconcile();
	}
	async refresh(): Promise<BtwState> {
		await this.#watcher?.refresh();
		this.#reconcile();
		if (!this.#state) throw new Error("The side-question history is unavailable.");
		return this.#state;
	}
	#reconcile(): void {
		const snapshot = this.#snapshot;
		if (!snapshot) return;
		const surfaces = snapshot.lifecycle === "live" ? snapshot.surfaces.filter(surface => surface.documentGeneration === snapshot.generation) : [];
		const projection = projectBtw(surfaces);
		const resolved = projection ? resolveBtwTopic(projection, this.#persisted) : null;
		const key = projection?.turns.length ? JSON.stringify([projection.surfaceId, projection.nodeId, projection.selectedId, projection.focused, projection.turns[0]?.question]) : "";
		if (key && (key !== this.#liveKey || !!resolved && !!this.#resolvedRef && !sameBtwTopic(resolved, this.#resolvedRef))) {
			this.#liveKey = key;
			this.#liveRef = { id: `live:${++this.#liveSequence}` };
			this.#resolvedRef = null;
		}
		if (projection?.turns.length) this.#liveViews.set(btwTopicKey(this.#liveRef), projection.focused);
		for (const pending of this.#state?.topics ?? []) {
			const pendingKey = btwTopicKey(pending);
			if (!pending.id.startsWith("live:") || this.#aliases.has(pendingKey)) continue;
			const persisted = resolveBtwTopic({ selectedId: null, turns: pending.turns, focused: this.#liveViews.get(pendingKey) }, this.#persisted);
			if (persisted) this.#aliases.set(pendingKey, persisted);
		}
		if (resolved) {
			const liveKey = btwTopicKey(this.#liveRef);
			if (!this.#aliases.has(liveKey)) this.#aliases.set(liveKey, resolved);
			this.#resolvedRef = resolved;
		}
		const persisted = this.#persisted.map(topic => this.#recovered.has(btwTopicKey(topic)) && !sameBtwTopic(topic, resolved)
			? { ...topic, turns: topic.turns.map(turn => turn.status === "running" ? { ...turn, status: "interrupted" as const } : turn) } : topic);
		const topics = mergeBtwTopics(persisted, projection, this.#liveRef);
		for (const pending of this.#state?.topics ?? []) if (pending.id.startsWith("live:") && !this.#aliases.has(btwTopicKey(pending)) && !topics.some(topic => sameBtwTopic(topic, pending))) topics.push({ ...pending, live: false });
		const selectedTopic = projection?.turns.length ? resolved ?? this.#liveRef : null;
		const overlay = projection ? { epoch: snapshot.epoch, surfaceId: projection.surfaceId, nodeId: projection.nodeId, selectedTopic,
			topics: btwOverlayTopics(projection, this.#persisted, selectedTopic), actions: Object.keys(projection.actions), followUp: !!projection.field,
			draft: projection.field?.text ?? null, supported: projection.supported, notice: projection.notice } : null;
		const next = { hostId: snapshot.hostId, generation: snapshot.generation, epoch: snapshot.epoch, topics, overlay };
		const signature = JSON.stringify(next);
		if (signature === this.#signature) return;
		this.#signature = signature;
		this.#state = { ...next, revision: ++this.#revision };
		this.#publish(this.#state);
	}
	close(): void { this.#watcher?.close(); this.#watcher = null; this.#scope = ""; }
}
