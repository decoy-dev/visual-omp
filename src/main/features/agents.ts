import { broadcast, handle } from "../ipc";
import { parseAgentMarkdown } from "./agents/parse";
import {
	createAgent,
	customizeBundledAgent,
	deleteAgent,
	listAgents,
	readAgentFile,
	setAgentEnabled,
	setAgentModelOverride,
	updateAgent,
	writeAgentRaw,
} from "./agents/service";

/** Run a mutation, then tell renderers which project (null = user/global) it affected. */
async function changed<T>(cwd: string | null, work: Promise<T>): Promise<T> {
	const result = await work;
	broadcast("agents:changed", { cwd });
	return result;
}

export function register(): void {
	handle("agents:list", (cwd, refresh) => listAgents(cwd, refresh));
	handle("agents:read", filePath => readAgentFile(filePath));
	handle("agents:validate", content => parseAgentMarkdown(content));
	handle("agents:create", (draft, scope, cwd) =>
		changed(scope === "project" ? (cwd ?? null) : null, createAgent(draft, scope, cwd)),
	);
	handle("agents:update", (filePath, draft) => changed(null, updateAgent(filePath, draft)));
	handle("agents:writeRaw", (filePath, content) => changed(null, writeAgentRaw(filePath, content)));
	handle("agents:delete", filePath => changed(null, deleteAgent(filePath)));
	handle("agents:customize", (name, scope, cwd, overwrite) =>
		changed(scope === "project" ? (cwd ?? null) : null, customizeBundledAgent(name, scope, cwd, overwrite)),
	);
	handle("agents:setEnabled", (name, enabled, cwd) => changed(null, setAgentEnabled(name, enabled, cwd)));
	handle("agents:setModelOverride", (name, model, cwd) => changed(null, setAgentModelOverride(name, model, cwd)));
}
