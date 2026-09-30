/**
 * Model and thinking changes for one chat.
 *
 * - Model: `/switch <provider/id>` is omp's session-only switch (same as Alt+P); `/model <x>` in the
 *   TUI ignores its argument and opens the Model Hub, and `/model` over RPC would persist the default.
 * - Thinking: Shift+Tab cycles off → auto → the model's efforts → off (`cycleThinkingLevel`). Unlike
 *   `/switch model:level` it does not reset the provider session (prompt cache), so the app presses it
 *   until omp's status line shows the chosen level.
 */
import { useEffect, useState } from "react";
import type { ModelInfo } from "@shared/contracts/config";
import type { SessionController } from "../../state/session";
import { OmpBusyError, press, readyEditor, reportFailure, runCommand, waitForScreen } from "./drive";
import { parseStatusLine, THINKING_LEVELS, type ThinkingLevel } from "./screen";
import { screenPoller } from "./status";

const modelCache = new Map<string, Promise<ModelInfo[]>>();

/** Usable chat models for a project (cached per project for the app's lifetime; main caches omp's list too). */
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

/** Switch this chat's model; resolves true when omp confirmed it. */
export async function switchModel(session: SessionController, selector: string): Promise<boolean> {
	try {
		const { output } = await runCommand(session, `/switch ${selector}`, {
			until: (_lines, printed) => printed.some(line => /Session-only model|Unknown model|Failed|No API key|error/i.test(line)),
			timeoutMs: 8000,
		});
		const failure = output.find(line => /Unknown model|Failed|No API key|error/i.test(line));
		if (failure) throw new Error(failure.replace(/^(warning|error):\s*/i, ""));
		void screenPoller(session).refresh();
		return true;
	} catch (error) {
		reportFailure(error);
		return false;
	}
}

/** Set the thinking level by cycling Shift+Tab until the status line shows it. */
export async function setThinking(session: SessionController, target: ThinkingLevel, choices: readonly ThinkingLevel[]): Promise<boolean> {
	try {
		let current = parseStatusLine(await readyEditor(session))?.thinking ?? null;
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
				const level = parseStatusLine(screen)?.thinking;
				return level !== undefined && level !== null && (level === target || level !== before);
			}, 2500);
			current = (lines && parseStatusLine(lines)?.thinking) ?? current;
		}
		void screenPoller(session).refresh();
		return current === target;
	} catch (error) {
		reportFailure(error);
		return false;
	}
}
