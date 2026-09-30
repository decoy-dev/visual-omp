/** Running registered commands from the palette, menu accelerators and keyboard shortcuts. */
import { type CommandContext, type CommandSpec, getCommand } from "../../registry/commands";
import { controllerFor, focusedTabId, useApp } from "../../state/app";
import { toast } from "../../ui";
import { recordUse } from "./usage";

/** Context commands act on: the focused chat and its project (else the selected project). */
export function commandContext(): CommandContext {
	const state = useApp.getState();
	const tabId = focusedTabId(state);
	const tab = tabId ? state.tabs.find(entry => entry.id === tabId) : undefined;
	return { session: controllerFor(tabId), projectPath: tab?.projectPath ?? state.activeProject };
}

/** Run a command by id or spec if it is available right now. Unknown ids are ignored. */
export function runCommand(target: string | CommandSpec, ctx: CommandContext = commandContext()): boolean {
	const spec = typeof target === "string" ? getCommand(target) : target;
	if (!spec || !(spec.when?.(ctx) ?? true)) return false;
	recordUse(spec.id);
	void Promise.resolve()
		.then(() => spec.run(ctx))
		.catch((error: unknown) => {
			toast({ tone: "err", message: error instanceof Error ? error.message : String(error) });
		});
	return true;
}
