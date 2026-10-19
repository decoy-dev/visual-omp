/**
 * Model and thinking changes for one chat.
 *
 * - Model: `/switch <provider/id>` is omp's session-only switch (same as Alt+P); `/model <x>` in the
 *   TUI ignores its argument and opens the Model Hub, and `/model` over RPC would persist the default.
 * - Thinking: Shift+Tab cycles off → auto → the model's efforts → off (`cycleThinkingLevel`). Unlike
 *   `/switch model:level` it does not reset the provider session (prompt cache), so the app presses it
 *   until omp shows the chosen level. In Auto, omp paints the level it resolved for the latest turn,
 *   so Auto itself is read from the selector omp records in `thinking_level_change` entries.
 */
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { useEffect, useState } from "react";
import type { ModelInfo } from "@shared/contracts/config";
import { toast } from "@/ui";
import { displayedEntries } from "../../chat/branch";
import { i18n } from "../../i18n";
import type { SessionController } from "../../state/session";
import { OmpBusyError, press, readyEditor, reportFailure, waitForScreen } from "./drive";
import { parseStatusLine, THINKING_LEVELS, type ThinkingLevel } from "./screen";
import { screenPoller } from "./status";

const modelCache = new Map<string, Promise<ModelInfo[]>>();
// A sign-in or sign-out changes which models omp lists; the picker reloads the next time it opens.
window.vomp.on("providers:changed", () => modelCache.clear());

/** Usable chat models for a project (cached per project until credentials change; main caches omp's list too). */
export function useChatModels(cwd: string): { models: ModelInfo[] | null; error: string | null } {
	const [state, setState] = useState<{ models: ModelInfo[] | null; error: string | null }>({ models: null, error: null });
	useEffect(() => {
		let live = true;
		let pending = modelCache.get(cwd);
		if (!pending) {
			pending = window.vomp.invoke("config:models", cwd);
			modelCache.set(cwd, pending);
			pending.catch(() => modelCache.delete(cwd));
		}
		pending.then(
			all => live && setState({ models: all.filter(model => model.kind === "chat"), error: null }),
			error => live && setState({ models: null, error: error instanceof Error ? error.message : String(error) }),
		);
		return () => {
			live = false;
		};
	}, [cwd]);
	return state;
}

/** Levels omp offers for a model, in cycle order; empty when thinking is not controllable. */
export function thinkingChoices(model: ModelInfo | undefined): ThinkingLevel[] {
	if (!model?.reasoning) return [];
	return ["off", "auto", ...THINKING_LEVELS.filter(level => model.thinkingLevels.some(effort => effort === level))];
}

/**
 * The thinking selector the user chose. omp paints the level Auto resolved for the latest turn, so
 * Auto comes from omp's latest `thinking_level_changed` event (`autoThinking`), else from the latest
 * `thinking_level_change` entry on this branch (`configured: "auto"`); otherwise the painted level,
 * else the recorded one.
 */
export function configuredThinking(
	autoThinking: boolean | null | undefined,
	entries: readonly SessionEntry[],
	painted: ThinkingLevel | null,
): ThinkingLevel | null {
	const change = entries.findLast(entry => entry.type === "thinking_level_change");
	const recorded = change?.type === "thinking_level_change" ? (change.configured ?? change.thinkingLevel ?? null) : null;
	if (autoThinking ?? recorded === "auto") return "auto";
	return painted ?? THINKING_LEVELS.find(level => level === recorded) ?? null;
}

/** How long omp may take to report the new model before the picker warns. */
const SWITCH_CONFIRM_MS = 8000;

/**
 * Switch this chat's model; resolves true once omp confirmed it, false after telling the user why not.
 *
 * Only omp's collab state confirms the switch. The "Session-only model" line omp prints cannot: during
 * a turn omp prints it above the working indicator, and it rewrites an earlier status line in place,
 * so a screen diff either misses it or returns older transcript lines. omp's rejections ("Error:
 * Unknown model …", "Error: No API key for …") reach only the screen, where a reply can print the
 * same text, so a rejected switch ends with the unconfirmed warning, which points to the terminal sheet.
 */
export async function switchModel(session: SessionController, model: ModelInfo): Promise<boolean> {
	const switched = () => {
		const current = session.getSnapshot().guest?.state?.model;
		return current?.provider === model.provider && current.id === model.id;
	};
	try {
		await readyEditor(session);
		const tokens = session.getSnapshot().guest?.state?.contextUsage?.tokens ?? 0;
		const overContext = model.contextWindow !== null && model.contextWindow > 0 && tokens > model.contextWindow;
		await session.command(`/switch ${model.selector}`);
		if (!switched()) {
			const { promise, resolve } = Promise.withResolvers<void>();
			const timer = setTimeout(resolve, SWITCH_CONFIRM_MS);
			const unsubscribe = session.subscribe(() => {
				if (switched()) resolve();
			});
			await promise;
			clearTimeout(timer);
			unsubscribe();
		}
		if (switched()) {
			void screenPoller(session).refresh();
			return true;
		}
		// A chat longer than the model's window makes omp compact it before switching, which can outlast the wait.
		const message = overContext ? "session:model.notConfirmedLong" : "session:model.notConfirmed";
		toast({ tone: "warn", message: i18n.t(message, { name: model.name }) });
		return false;
	} catch (error) {
		reportFailure(error);
		return false;
	}
}

/** Set the thinking level by cycling Shift+Tab until the status line shows it. */
export async function setThinking(session: SessionController, target: ThinkingLevel, choices: readonly ThinkingLevel[]): Promise<boolean> {
	try {
		const read = (screen: readonly string[]) => {
			const snapshot = session.getSnapshot();
			return configuredThinking(snapshot.guest?.autoThinking, displayedEntries(snapshot), parseStatusLine(screen)?.thinking ?? null);
		};
		let current = read(await readyEditor(session));
		if (current === null) throw new OmpBusyError();
		// One jump by the computed distance, then single steps in case omp's list differs from ours.
		const from = choices.indexOf(current);
		const to = choices.indexOf(target);
		const jump = from >= 0 && to >= 0 ? (to - from + choices.length) % choices.length : 1;
		for (let attempt = 0; current !== target && attempt <= choices.length + 1; attempt++) {
			const steps = attempt === 0 ? jump : 1;
			const before = current;
			await press(session, Array.from({ length: steps }, () => "S-tab").join(" "));
			const lines = await waitForScreen(session, screen => {
				const level = read(screen);
				return level !== null && (level === target || level !== before);
			}, 2500);
			current = (lines && read(lines)) ?? current;
		}
		void screenPoller(session).refresh();
		return current === target;
	} catch (error) {
		reportFailure(error);
		return false;
	}
}
