/** Pure helpers for the Model roles editor: role order, model grouping, thinking levels, drafts. */
import type { ModelInfo, ModelKind, ModelRoleInfo, RoleThinking } from "@shared/contracts/config";

/** DESIGN §4.13 display order: the everyday roles first, the specialist runners last. */
export const ROLE_DISPLAY_ORDER = [
	"default",
	"plan",
	"commit",
	"advisor",
	"smol",
	"slow",
	"vision",
	"tiny",
	"memory",
	"task",
	"image",
	"web",
	"speech",
	"dictation",
	"judge",
] as const;

/** Built-in roles in display order, then custom roles in omp's order. */
export function orderRoles(roles: readonly ModelRoleInfo[]): ModelRoleInfo[] {
	const rank = (role: ModelRoleInfo) => {
		const index = (ROLE_DISPLAY_ORDER as readonly string[]).indexOf(role.id);
		return role.builtIn && index >= 0 ? index : ROLE_DISPLAY_ORDER.length;
	};
	return roles
		.map((role, position) => ({ role, position }))
		.sort((a, b) => rank(a.role) - rank(b.role) || a.position - b.position)
		.map(entry => entry.role);
}

export interface RoleDraft {
	/** `provider/id`, alias or pattern; null = let omp pick. */
	model: string | null;
	thinking: RoleThinking | null;
}

/** Role ids whose draft differs from what omp has stored. */
export function changedRoleIds(roles: readonly ModelRoleInfo[], drafts: Readonly<Record<string, RoleDraft>>): string[] {
	return roles
		.filter(role => {
			const draft = drafts[role.id];
			return draft !== undefined && (draft.model !== role.model || (draft.model !== null && draft.thinking !== role.thinking));
		})
		.map(role => role.id);
}

/** Models a role can take, grouped by provider (providers and models sorted by name). */
export function groupModelsByProvider(models: readonly ModelInfo[], accepts: readonly ModelKind[]): [provider: string, models: ModelInfo[]][] {
	const groups = new Map<string, ModelInfo[]>();
	for (const model of models) {
		if (!accepts.includes(model.kind)) continue;
		const list = groups.get(model.provider);
		if (list) list.push(model);
		else groups.set(model.provider, [model]);
	}
	return [...groups.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([provider, list]) => [provider, list.sort((a, b) => a.name.localeCompare(b.name))]);
}

export type ModelValueStatus = "auto" | "alias" | "available" | "missing";

/**
 * How a stored role value resolves against the usable models: unassigned, a `@role` alias, a model
 * in the list (by `provider/id`, or a bare id), or something omp cannot use right now.
 */
export function modelValueStatus(value: string | null, models: readonly ModelInfo[]): ModelValueStatus {
	if (value === null || value === "") return "auto";
	if (value.startsWith("@")) return "alias";
	return models.some(model => model.selector === value || model.id === value) ? "available" : "missing";
}

export function findModel(value: string | null, models: readonly ModelInfo[]): ModelInfo | null {
	if (!value) return null;
	return models.find(model => model.selector === value) ?? models.find(model => model.id === value) ?? null;
}

/**
 * Thinking choices for a model: always "inherit" (use the chat's level); models that reason add
 * "off", each effort they support and "auto". Unknown/alias models get the full effort list.
 */
export function thinkingChoices(model: ModelInfo | null, known: boolean): RoleThinking[] {
	if (known && model && (!model.reasoning || model.thinkingLevels.length === 0)) return ["inherit"];
	const efforts = model && known ? model.thinkingLevels : (["minimal", "low", "medium", "high", "xhigh", "max"] as const);
	return ["inherit", "off", ...efforts, "auto"];
}

/** Context window as a short hint: 200000 → "200K", 1048576 → "1M". */
export function formatContextWindow(tokens: number | null): string | null {
	if (!tokens) return null;
	if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
	return `${Math.round(tokens / 1000)}K`;
}
