import type { ModelInfo } from "@shared/contracts/config";

export interface ModelFamily {
	name: string;
	version: string;
}

// Only documented naming shapes establish a family. In particular, arbitrary trailing numbers,
// fine-tunes, organization prefixes and unrecognized suffixes never establish related models.
const CLAUDE_SUFFIX = "(?:-(?:latest|\\d{8}))?(?:\\[1m\\]|:1m|-1m)?";
const GPT_SUFFIX = "(?:-(?:preview|latest|\\d{4}-\\d{2}-\\d{2}))?";
const GEMINI_SUFFIX = "(?:-(?:preview(?:-\\d{2}-\\d{2})?|latest|\\d{3}))?";

function parseFamily(value: string): ModelFamily | null {
	const id = value.toLowerCase();
	let match = new RegExp(`^claude-(opus|sonnet|haiku)-(\\d+)(?:[.-](\\d{1,2}))?(${CLAUDE_SUFFIX})$`).exec(id);
	if (match) return { name: `Claude ${title(match[1]!)}`, version: `${match[2]}${match[3] ? `.${match[3]}` : ""}${match[4]}` };
	match = new RegExp(`^claude-(\\d+)(?:[.-](\\d{1,2}))?-(opus|sonnet|haiku)(${CLAUDE_SUFFIX})$`).exec(id);
	if (match) return { name: `Claude ${title(match[3]!)}`, version: `${match[1]}${match[2] ? `.${match[2]}` : ""}${match[4]}` };
	match = /^(claude)-(opus|sonnet|haiku)-latest$/.exec(id);
	if (match) return { name: `Claude ${title(match[2]!)}`, version: "latest" };
	match = new RegExp(`^gpt-(\\d+(?:\\.\\d+)?[o]?)(?:-(mini|nano|codex|pro))?(${GPT_SUFFIX})$`).exec(id);
	if (match) return { name: match[2] ? `GPT ${title(match[2])}` : "GPT", version: `${match[1]}${match[3]}` };
	match = new RegExp(`^gemini-(\\d+(?:\\.\\d+)?)-(pro|flash-lite|flash)(${GEMINI_SUFFIX})$`).exec(id);
	if (match) return { name: `Gemini ${match[2] === "flash-lite" ? "Flash-Lite" : title(match[2]!)}`, version: `${match[1]}${match[3]}` };
	return null;
}

function title(value: string): string {
	return value[0]!.toUpperCase() + value.slice(1);
}

/** Family hints affect presentation only. The catalog object and its exact selector remain intact. */
export function modelFamily(model: ModelInfo): ModelFamily | null {
	// omp's v18.15 catalog uses upstream namespaces on OpenRouter ids. Custom routes keep their ids.
	const id = model.provider === "openrouter" ? model.id.replace(/^(?:anthropic|openai|google)\//i, "") : model.id;
	const family = parseFamily(id);
	if (!family) return null;
	// A contradictory or custom display name is deliberately left as a direct leaf.
	const normalizedName = model.name.replace(/\s+\(1m(?: context)?\)$/i, "[1m]").replace(/\s+/g, "-");
	const named = parseFamily(model.provider === "openrouter" ? normalizedName.replace(/^(?:anthropic|openai|google)\//i, "") : normalizedName);
	if (!named || named.name !== family.name) return null;
	// A display name may omit a dated snapshot or window suffix, but cannot name another version.
	const windowSuffix = /(?:\[1m\]|:1m|-1m)$/;
	if (windowSuffix.test(named.version) && !windowSuffix.test(family.version)) return null;
	const identifiedVersion = family.version.replace(windowSuffix, "");
	const namedVersion = named.version.replace(windowSuffix, "");
	if (identifiedVersion !== "latest" && identifiedVersion !== namedVersion && !identifiedVersion.startsWith(`${namedVersion}-`)) return null;
	// Retain the catalog's spelling of versions, aliases, snapshots and window variants when possible.
	const nameVersion = model.name
		.replace(new RegExp(`^${family.name.replace(" ", "[ -]")}[ -]`, "i"), "")
		.trim();
	return { name: family.name, version: named.version === family.version && nameVersion !== model.name ? nameVersion : family.version };
}

export type ModelNode = ModelBranch | ModelLeaf;
export interface ModelBranch {
	kind: "provider" | "family";
	key: string;
	label: string;
	children: ModelNode[];
}
export interface ModelLeaf {
	kind: "model";
	key: string;
	label: string;
	model: ModelInfo;
}

export function modelKey(model: Pick<ModelInfo, "provider" | "id" | "selector">): string {
	return JSON.stringify(["model", model.provider, model.id, model.selector]);
}

/** Build from available chat models, never from a second catalog or inferred host provider. */
export function modelTree(models: readonly ModelInfo[]): ModelBranch[] {
	const providers = new Map<string, ModelInfo[]>();
	for (const model of models) {
		const group = providers.get(model.provider) ?? [];
		group.push(model);
		providers.set(model.provider, group);
	}
	return [...providers].sort(([a], [b]) => a.localeCompare(b)).map(([provider, entries]) => {
		const families = new Map<string, ModelLeaf[]>();
		const children: ModelNode[] = [];
		for (const model of entries) {
			const family = modelFamily(model);
			const leaf: ModelLeaf = { kind: "model", key: modelKey(model), label: family?.version ?? model.name, model };
			if (family) {
				const group = families.get(family.name) ?? [];
				group.push(leaf);
				families.set(family.name, group);
			} else children.push(leaf);
		}
		for (const [family, versions] of families) {
			if (versions.length === 1) children.push({ ...versions[0]!, label: versions[0]!.model.name });
			else children.push({ kind: "family", key: JSON.stringify(["family", provider, family]), label: family, children: versions.sort((a, b) => b.label.localeCompare(a.label, undefined, { numeric: true })) });
		}
		children.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }) || a.key.localeCompare(b.key));
		return { kind: "provider", key: JSON.stringify(["provider", provider]), label: provider, children };
	});
}

/** Search leaves across collapsed branches; matched branches are retained with all matching descendants. */
export function searchModelTree(tree: readonly ModelBranch[], query: string): ModelBranch[] {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!tokens.length) return [...tree];
	const filter = (node: ModelNode): ModelNode | null => {
		if (node.kind === "model") {
			const haystack = `${node.model.provider} ${node.model.name} ${node.model.id}`.toLowerCase();
			return tokens.every(token => haystack.includes(token)) ? node : null;
		}
		const children = node.children.map(filter).filter((child): child is ModelNode => child !== null);
		return children.length ? { ...node, children } : null;
	};
	return tree.map(filter).filter((node): node is ModelBranch => node !== null);
}

export interface ModelRow {
	node: ModelNode;
	parent: string | null;
	level: number;
}

export function modelRows(tree: readonly ModelNode[], expanded: (node: ModelBranch) => boolean, parent: string | null = null, level = 1): ModelRow[] {
	return tree.flatMap(node => [
		{ node, parent, level },
		...(node.kind !== "model" && expanded(node) ? modelRows(node.children, expanded, node.key, level + 1) : []),
	]);
}

export function containsCurrent(node: ModelNode, current: { provider: string; id: string } | null): boolean {
	if (!current) return false;
	return node.kind === "model"
		? node.model.provider === current.provider && node.model.id === current.id
		: node.children.some(child => containsCurrent(child, current));
}
