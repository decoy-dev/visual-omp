import type { AssistantMessage, FallbackContent, ModelChangeEntry, SessionEntry, WireModel } from "@oh-my-pi/pi-wire";

/** A serving-model change needs a new reply header, including within one uninterrupted turn. */
export function continuesAssistantModel(previous: AssistantMessage | null, current: AssistantMessage | null): boolean {
	return previous !== null && current !== null && previous.model === current.model && previous.provider === current.provider;
}

export interface ModelFallback {
	from?: string;
	to: string;
	/** omp's recorded error, including any provider retry or reset information. */
	reason?: string;
	source: "retry" | "provider";
}

/** omp also uses role "fallback" when restoring the primary, so only its explicit flag counts. */
export function isModelFallback(entry: SessionEntry): entry is ModelChangeEntry {
	return entry.type === "model_change" && entry.resolvedModelIsFallback === true && typeof entry.model === "string" && entry.model.trim().length > 0;
}

export function modelSetupVisible(entry: Extract<SessionEntry, { type: "model_change" | "thinking_level_change" }>, verbose: boolean, afterPrompt: boolean): boolean {
	return entry.type === "model_change" ? isModelFallback(entry) || afterPrompt : verbose && afterPrompt;
}

const fallbackCache = new WeakMap<readonly SessionEntry[], ReadonlyMap<string, ModelFallback>>();

/** The caller supplies the displayed branch, including entries outside the transcript's render window. */
export function modelFallbacks(entries: readonly SessionEntry[]): ReadonlyMap<string, ModelFallback> {
	const cached = fallbackCache.get(entries);
	if (cached) return cached;
	const result = new Map<string, ModelFallback>();
	let previous: string | undefined;
	let pending: ModelFallback | undefined;
	for (const entry of entries) {
		if (entry.type === "model_change") {
			pending = undefined;
			if (typeof entry.model !== "string" || !entry.model.trim()) continue;
			if (isModelFallback(entry)) {
				pending = { from: previous, to: entry.model, source: "retry" };
				result.set(entry.id, pending);
			}
			previous = entry.model;
		} else if (entry.type === "message" && entry.message.role === "user") {
			pending = undefined;
		} else if (pending && entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message;
			const recovery = message.retryRecovery;
			const target = recovery?.supersededBy;
			// omp appends the failed attempt after applying its fallback. Require its explicit recovery
			// attribution and matching destination; proximity to an error alone never establishes a cause.
			if (message.stopReason === "error" && recovery?.kind === "auto-retry" && recovery.recovery === "model" && target && `${target.provider}/${target.model}` === pending.to) {
				pending.from = message.provider && message.model ? `${message.provider}/${message.model}` : pending.from;
				pending.reason = typeof message.errorMessage === "string" && message.errorMessage.trim() ? message.errorMessage : undefined;
			}
			pending = undefined;
		}
	}
	fallbackCache.set(entries, result);
	return result;
}

export function providerFallback(block: FallbackContent): ModelFallback | null {
	const from = block.from?.model;
	const to = block.to?.model;
	if (typeof from !== "string" || typeof to !== "string" || !from.trim() || !to.trim() || from === to) return null;
	return { from, to, source: "provider" };
}

function modelReference(selector: string): Pick<WireModel, "provider" | "id" | "name"> {
	const slash = selector.indexOf("/");
	return { provider: slash < 0 ? "" : selector.slice(0, slash), id: selector.slice(slash + 1), name: selector };
}

interface RecordedModel {
	selected?: string;
	fallback: ModelFallback | null;
	provider: { message: AssistantMessage; fallback: ModelFallback } | null;
}

const modelCache = new WeakMap<readonly SessionEntry[], RecordedModel>();

/** Entry arrays are immutable snapshots, so streaming updates do not rescan the saved transcript. */
function recordedModel(entries: readonly SessionEntry[]): RecordedModel {
	const cached = modelCache.get(entries);
	if (cached) return cached;
	const changes = modelFallbacks(entries);
	let selected: string | undefined;
	let fallback: ModelFallback | null = null;
	let original: string | undefined;
	let chainStarted = false;
	let provider: { message: AssistantMessage; fallback: ModelFallback } | null = null;
	for (const entry of entries) {
		if (entry.type === "model_change" && typeof entry.model === "string" && entry.model.trim()) {
			const change = changes.get(entry.id);
			if (!change) {
				original = undefined;
				chainStarted = false;
			} else if (!chainStarted) {
				original = change.from;
				chainStarted = true;
			}
			fallback = change ? { ...change, from: original } : null;
			selected = entry.model;
			provider = null;
		} else if (entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted") {
			provider = responseFallback(entry.message);
		}
	}
	const result = { selected, fallback, provider };
	modelCache.set(entries, result);
	return result;
}

/** Live state owns selection. Provider fallback content records the serving model for the latest reply. */
export function composerModel(
	entries: readonly SessionEntry[],
	live: WireModel | undefined,
	stream: AssistantMessage | null,
): { model: Pick<WireModel, "provider" | "id" | "name"> | null; selectedModel: Pick<WireModel, "provider" | "id" | "name"> | null; fallback: ModelFallback | null } {
	let { selected, fallback, provider } = recordedModel(entries);
	const selectedModel = live ?? (selected ? modelReference(selected) : null);
	if (live && selected !== `${live.provider}/${live.id}`) fallback = null;
	if (stream) provider = responseFallback(stream);
	// A response's source must still be selected. A newer same-provider choice can reach live state
	// before its history entry, so provider equality alone cannot keep an older serving model active.
	const source = provider?.fallback.from ? modelReference(provider.fallback.from) : null;
	const sourceProvider = source?.provider || provider?.message.provider;
	if (provider && (!live || (sourceProvider === live.provider && source?.id === live.id))) {
		const serving = modelReference(provider.fallback.to);
		return {
			model: { ...serving, provider: serving.provider || provider.message.provider || selectedModel?.provider || "" },
			selectedModel,
			fallback: provider.fallback,
		};
	}
	return { model: selectedModel, selectedModel, fallback };
}

function responseFallback(message: AssistantMessage): { message: AssistantMessage; fallback: ModelFallback } | null {
	let from: string | undefined;
	let to: string | undefined;
	for (const block of message.content) {
		if (block.type !== "fallback") continue;
		const next = providerFallback(block);
		if (next) {
			if (to === undefined) from = next.from;
			to = next.to;
		}
	}
	return to ? { message, fallback: { from, to, source: "provider" } } : null;
}
