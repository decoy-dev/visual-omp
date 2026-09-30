/**
 * `config:*` channels: omp settings, models, model roles/presets, tool approval and provider login
 * status. Contract and data sources: `src/shared/contracts/config.ts`.
 */
import { type Stats, unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
	type ApprovalMode,
	type ApprovalPolicy,
	type ApprovalState,
	BUILT_IN_MODEL_ROLES,
	type ConfigSnapshot,
	type JsonValue,
	type ModelInfo,
	type ModelPresetInfo,
	type ModelRoleInfo,
	type ModelRolesState,
	type PresetApplyResult,
	type PresetDeleteResult,
	type ProviderAuthStatus,
	type RoleAssignment,
	type RoleWriteOptions,
	type SettingInfo,
	type SettingScope,
	type SettingSource,
	type SettingWriteResult,
} from "@shared/contracts/config";
import { broadcast, handle } from "../ipc";
import { runOmp } from "../omp/cli";
import {
	configFile,
	deleteConfigPath,
	editConfig,
	isOwnWrite,
	NEUTRAL_CWD,
	ompAgentDir,
	readConfig,
	setConfigPath,
} from "../omp/config-file";
import {
	deepMerge,
	deleteDocumentPath,
	formatRoleValue,
	getPath,
	isJsonObject,
	JsonValueSchema,
	jsonEqual,
	type LeafSetting,
	type ListedSetting,
	ompErrorMessage,
	parseCfgLeaf,
	parseCfgTree,
	parseConfigList,
	parseModels,
	ROLE_KINDS,
	ROLE_NAME_PATTERN,
	setDocumentPath,
	splitRoleValue,
	type TreeSetting,
	UsageJsonSchema,
	valueProblem,
} from "../services/omp-config";

// ─── omp invocations ───────────────────────────────────────────────────────

async function ompText(argv: string[], cwd: string | undefined, timeoutMs?: number): Promise<string> {
	const result = await runOmp(argv, { cwd: cwd ?? NEUTRAL_CWD, timeoutMs });
	if (result.code !== 0) throw new Error(ompErrorMessage(result.stderr, `omp ${argv.join(" ")} exited with ${result.code}`));
	return result.stdout;
}

async function ompJson(argv: string[], cwd: string | undefined, timeoutMs?: number): Promise<unknown> {
	return JSON.parse(await ompText(argv, cwd, timeoutMs));
}

/** `omp read cfg://<key>`: one setting with its authoritative source layer. */
async function readLeaf(key: string, cwd: string | undefined): Promise<LeafSetting> {
	return parseCfgLeaf(await ompText(["read", `cfg://${key}`], cwd));
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	async function worker(): Promise<void> {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index] as T);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

// ─── Layers ────────────────────────────────────────────────────────────────

interface Layers {
	globalFile: string;
	global: { [key: string]: JsonValue };
	projectFile: string | null;
	project: { [key: string]: JsonValue };
}

async function readLayers(cwd: string | undefined): Promise<Layers> {
	const [global, project] = await Promise.all([readConfig("global"), cwd ? readConfig("project", cwd) : null]);
	return { globalFile: global.file, global: global.data, projectFile: project?.file ?? null, project: project?.data ?? {} };
}

/** Configured value of `key` in one layer; a YAML `null` counts as unset, as in omp. */
function layerValue(layer: { [key: string]: JsonValue }, key: string): JsonValue | undefined {
	const value = getPath(layer, key.split("."));
	if (value === null) return undefined;
	// omp drops cleared (`null`) project model roles so the global assignment applies.
	if (key === "modelRoles" && isJsonObject(value)) {
		return Object.fromEntries(Object.entries(value).filter(([, role]) => role !== null));
	}
	return value;
}

const SOURCE_RANK: Record<SettingSource, number> = { default: 0, global: 1, project: 2, overlay: 3, runtime: 4, env: 5 };

function namespaceOf(key: string): string | null {
	const dot = key.lastIndexOf(".");
	return dot === -1 ? null : key.slice(0, dot);
}

function settingInfo(
	base: { key: string; type: ListedSetting["type"]; description: string; value: JsonValue; redacted: boolean },
	schema: TreeSetting | { enumValues: string[] | null; defaultValue: JsonValue },
	source: SettingSource,
	layers: Layers,
): SettingInfo {
	const hide = base.redacted;
	return {
		key: base.key,
		namespace: namespaceOf(base.key),
		type: base.type,
		description: base.description,
		enumValues: schema.enumValues,
		defaultValue: schema.defaultValue,
		value: base.value,
		redacted: base.redacted,
		modified: base.redacted || !jsonEqual(base.value, schema.defaultValue),
		source,
		globalValue: hide ? null : (layerValue(layers.global, base.key) ?? null),
		projectValue: hide ? null : (layerValue(layers.project, base.key) ?? null),
	};
}

// ─── Settings ──────────────────────────────────────────────────────────────

async function listSettings(cwd: string | undefined): Promise<ConfigSnapshot> {
	const [listJson, treeText, layers, agentDir] = await Promise.all([
		ompJson(["config", "list", "--json"], cwd),
		ompText(["read", "cfg://"], cwd),
		readLayers(cwd),
		ompAgentDir(),
	]);
	const listed = parseConfigList(listJson);
	const tree = parseCfgTree(treeText, listed);

	// The source is derived from the two config files; whenever the files cannot explain the
	// effective value (environment variables, `.claude/settings.json`, legacy keys, path-scoped
	// lists, credentials), omp's own per-setting read decides.
	const derived = new Map<string, SettingSource>();
	const ask: string[] = [];
	for (const setting of listed.values()) {
		const schema = tree.get(setting.key);
		const project = layerValue(layers.project, setting.key);
		const global = layerValue(layers.global, setting.key);
		const layered = project !== undefined && setting.type === "record" ? deepMerge(global, project) : (project ?? global);
		const expected = layered ?? schema?.defaultValue;
		if (!schema || setting.redacted || !jsonEqual(expected, setting.value)) {
			ask.push(setting.key);
			continue;
		}
		derived.set(setting.key, project !== undefined ? "project" : global !== undefined ? "global" : "default");
	}
	const leaves = new Map((await mapLimited(ask, 6, key => readLeaf(key, cwd))).map(leaf => [leaf.key, leaf]));

	const settings = [...listed.values()]
		.map(setting => {
			const leaf = leaves.get(setting.key);
			const schema = tree.get(setting.key) ?? {
				enumValues: leaf?.enumValues ?? null,
				defaultValue: leaf?.defaultValue ?? null,
			};
			return settingInfo(setting, schema, leaf?.source ?? derived.get(setting.key) ?? "default", layers);
		})
		.sort((a, b) => a.key.localeCompare(b.key));
	return { cwd: cwd ?? null, agentDir, globalFile: layers.globalFile, projectFile: layers.projectFile, settings };
}

async function getSetting(key: string, cwd: string | undefined): Promise<SettingInfo> {
	const [leaf, layers] = await Promise.all([readLeaf(key, cwd), readLayers(cwd)]);
	return settingInfo(leaf, leaf, leaf.source, layers);
}

async function writeResult(key: string, scope: SettingScope, cwd: string | undefined): Promise<SettingWriteResult> {
	const setting = await getSetting(key, cwd);
	return { setting, shadowedBy: SOURCE_RANK[setting.source] > SOURCE_RANK[scope] ? setting.source : null };
}

async function setSetting(key: string, value: JsonValue, scope: SettingScope, cwd: string | undefined): Promise<SettingWriteResult> {
	const leaf = await readLeaf(key, cwd);
	const problem = valueProblem(leaf.type, leaf.enumValues, JsonValueSchema.parse(value));
	if (problem) throw new Error(`Invalid value for ${leaf.key}: ${problem}`);
	await setConfigPath(scope, cwd, leaf.key.split("."), value);
	configWritten();
	return writeResult(leaf.key, scope, cwd);
}

async function resetSetting(key: string, scope: SettingScope, cwd: string | undefined): Promise<SettingWriteResult> {
	const leaf = await readLeaf(key, cwd);
	await deleteConfigPath(scope, cwd, leaf.key.split("."));
	configWritten();
	return writeResult(leaf.key, scope, cwd);
}

// ─── Models ────────────────────────────────────────────────────────────────

const MODELS_TTL_MS = 5 * 60_000;
const modelsCache = new Map<string, { at: number; models: Promise<ModelInfo[]> }>();

function listModels(cwd: string | undefined, refresh = false): Promise<ModelInfo[]> {
	const cacheKey = cwd ?? "";
	const cached = modelsCache.get(cacheKey);
	if (!refresh && cached && Date.now() - cached.at < MODELS_TTL_MS) return cached.models;
	const argv = refresh ? ["models", "refresh", "--json", "--kind", "all"] : ["models", "--json", "--kind", "all"];
	const models = ompJson(argv, cwd, refresh ? 180_000 : 60_000).then(parseModels);
	const entry = { at: Date.now(), models };
	modelsCache.set(cacheKey, entry);
	models.catch(() => {
		if (modelsCache.get(cacheKey) === entry) modelsCache.delete(cacheKey);
	});
	return models;
}

/** Config changed (by the app or on disk): project settings can enable/disable providers. */
function configWritten(): void {
	modelsCache.clear();
}

// ─── Model roles ───────────────────────────────────────────────────────────

const BUILT_IN_ROLE_META: Record<string, { name: string; color: string; section: "chat" | "kind" }> = {
	default: { name: "Default", color: "success", section: "chat" },
	smol: { name: "Fast", color: "warning", section: "chat" },
	slow: { name: "Thinking", color: "accent", section: "chat" },
	vision: { name: "Vision", color: "error", section: "chat" },
	plan: { name: "Architect", color: "muted", section: "chat" },
	commit: { name: "Commit", color: "dim", section: "chat" },
	tiny: { name: "Tiny", color: "dim", section: "chat" },
	memory: { name: "Memory", color: "dim", section: "chat" },
	task: { name: "Subtask", color: "muted", section: "chat" },
	advisor: { name: "Advisor", color: "accent", section: "chat" },
	image: { name: "Image generation", color: "accent", section: "kind" },
	web: { name: "Web search", color: "success", section: "kind" },
	speech: { name: "Speech", color: "warning", section: "kind" },
	dictation: { name: "Dictation", color: "warning", section: "kind" },
	judge: { name: "Judge", color: "muted", section: "kind" },
};

const StringRecordSchema = z.record(z.string(), z.unknown()).transform(record =>
	Object.fromEntries(Object.entries(record).flatMap(([key, value]) => (typeof value === "string" && value.trim() ? [[key, value]] : []))),
);
const ModelTagsSchema = z.record(
	z.string(),
	z.object({ name: z.string().optional(), color: z.string().optional(), hidden: z.boolean().optional() }).loose(),
);
const StorageSchema = z.enum(["global", "project"]);
const DefaultThinkingSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "auto"]);
const RoleThinkingSchema = z.enum(["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);

function stringRecord(value: JsonValue | undefined): Record<string, string> {
	const parsed = StringRecordSchema.safeParse(value ?? {});
	return parsed.success ? parsed.data : {};
}

async function readRoles(cwd: string | undefined): Promise<ModelRolesState> {
	const [listJson, storageLeaf, thinkingLeaf, layers] = await Promise.all([
		ompJson(["config", "list", "--json"], cwd),
		readLeaf("modelRoleStorage", cwd),
		readLeaf("defaultThinkingLevel", cwd),
		readLayers(cwd),
	]);
	const listed = parseConfigList(listJson);
	const effective = stringRecord(listed.get("modelRoles")?.value);
	const globalRoles = stringRecord(layerValue(layers.global, "modelRoles"));
	const projectRoles = stringRecord(layerValue(layers.project, "modelRoles"));
	const cycle = z.array(z.string()).catch([]).parse(listed.get("cycleOrder")?.value ?? []);
	const tags = ModelTagsSchema.catch({}).parse(listed.get("modelTags")?.value ?? {});

	const ids: string[] = [...BUILT_IN_MODEL_ROLES];
	for (const role of [...cycle, ...Object.keys(effective), ...Object.keys(tags)]) if (!ids.includes(role)) ids.push(role);

	// Model ids may end in `:max`; resolve that suffix against the catalog only when it occurs.
	const needsCatalog = Object.values(effective).some(value => value.endsWith(":max"));
	const literals = needsCatalog ? new Set((await listModels(cwd)).map(model => model.selector)) : undefined;

	const roles = ids.map((id): ModelRoleInfo => {
		const builtIn = BUILT_IN_ROLE_META[id];
		const tag = Object.hasOwn(tags, id) ? tags[id] : undefined;
		const value = effective[id] ?? null;
		const split = value ? splitRoleValue(value, literals) : null;
		const projectValue = projectRoles[id] ?? null;
		const globalValue = globalRoles[id] ?? null;
		return {
			id,
			name: tag?.name || builtIn?.name || id,
			builtIn: builtIn !== undefined,
			section: builtIn?.section ?? "chat",
			acceptsKinds: ROLE_KINDS[id] ?? ["chat"],
			color: tag?.color ?? builtIn?.color ?? null,
			hidden: tag?.hidden ?? false,
			inCycle: cycle.includes(id),
			value,
			model: split?.model ?? null,
			thinking: split?.thinking ?? null,
			source: value === null ? "default" : value === projectValue || value !== globalValue ? "project" : "global",
			globalValue,
			projectValue,
		};
	});
	return {
		cwd: cwd ?? null,
		storage: StorageSchema.parse(storageLeaf.value),
		storageSource: storageLeaf.source,
		defaultThinkingLevel: DefaultThinkingSchema.parse(thinkingLeaf.value),
		roles,
	};
}

async function roleStorage(cwd: string | undefined): Promise<SettingScope> {
	return StorageSchema.parse((await readLeaf("modelRoleStorage", cwd)).value);
}

async function setRole(role: string, assignment: RoleAssignment | null, options: RoleWriteOptions = {}): Promise<ModelRolesState> {
	const { cwd } = options;
	if (!Object.hasOwn(BUILT_IN_ROLE_META, role) && !ROLE_NAME_PATTERN.test(role)) {
		throw new Error(`Invalid role name "${role}": use a letter, then letters, digits, - or _`);
	}
	const scope = options.scope ?? (await roleStorage(cwd));
	if (assignment === null) {
		await deleteConfigPath(scope, cwd, ["modelRoles", role]);
	} else {
		const model = assignment.model.trim();
		const thinking = assignment.thinking == null ? null : RoleThinkingSchema.parse(assignment.thinking);
		if (!model) throw new Error("A model is required");
		if (thinking && splitRoleValue(model).thinking) throw new Error(`"${model}" already carries a thinking level`);
		await setConfigPath(scope, cwd, ["modelRoles", role], formatRoleValue(model, thinking));
	}
	configWritten();
	return readRoles(cwd);
}

// ─── Model presets ─────────────────────────────────────────────────────────

/** Validate one raw `modelPresets` entry exactly like omp's `parseModelPreset`. */
function presetInfo(name: string, raw: JsonValue, source: SettingScope): ModelPresetInfo {
	const invalid = (problem: string): ModelPresetInfo => ({ name, source, modelRoles: {}, defaultThinkingLevel: null, problem });
	if (!isJsonObject(raw)) return invalid("it is not a mapping");
	const roles = raw.modelRoles;
	if (!isJsonObject(roles)) return invalid("`modelRoles` is missing or not a mapping");
	const modelRoles: Record<string, string> = {};
	for (const [role, value] of Object.entries(roles)) {
		if (typeof value !== "string" || value.trim() === "") return invalid(`role \`${role}\` is not a model selector`);
		modelRoles[role] = value;
	}
	const level = raw.defaultThinkingLevel;
	if (level === undefined) return { name, source, modelRoles, defaultThinkingLevel: null, problem: null };
	const thinking = DefaultThinkingSchema.safeParse(level);
	if (!thinking.success) return invalid("`defaultThinkingLevel` is not a thinking level");
	return { name, source, modelRoles, defaultThinkingLevel: thinking.data, problem: null };
}

async function listPresets(cwd: string | undefined): Promise<ModelPresetInfo[]> {
	const layers = await readLayers(cwd);
	const byName = new Map<string, ModelPresetInfo>();
	for (const [source, layer] of [
		["global", layers.global],
		["project", layers.project],
	] as const) {
		const presets = layerValue(layer, "modelPresets");
		if (!isJsonObject(presets)) continue;
		// A project preset replaces a same-name global one whole; entries never merge.
		for (const [name, raw] of Object.entries(presets)) if (raw !== null) byName.set(name, presetInfo(name, raw, source));
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function savePreset(name: string, cwd: string | undefined): Promise<ModelPresetInfo> {
	if (!ROLE_NAME_PATTERN.test(name)) throw new Error(`Invalid preset name "${name}": use a letter, then letters, digits, - or _`);
	const listed = parseConfigList(await ompJson(["config", "list", "--json"], cwd));
	const modelRoles = stringRecord(listed.get("modelRoles")?.value);
	const defaultThinkingLevel = DefaultThinkingSchema.parse(listed.get("defaultThinkingLevel")?.value);
	await setConfigPath("global", cwd, ["modelPresets", name], { modelRoles, defaultThinkingLevel });
	return { name, source: "global", modelRoles, defaultThinkingLevel, problem: null };
}

async function applyPreset(name: string, cwd: string | undefined): Promise<PresetApplyResult> {
	const preset = (await listPresets(cwd)).find(entry => entry.name === name);
	if (!preset) throw new Error(`Preset not found: ${name}`);
	if (preset.problem) throw new Error(`Preset "${name}" is malformed: ${preset.problem}`);

	// Like omp, refuse before writing anything when the preset's default model cannot be used.
	const models = await listModels(cwd);
	const presetDefault = preset.modelRoles.default;
	if (presetDefault) {
		const { model } = splitRoleValue(presetDefault, new Set(models.map(entry => entry.selector)));
		const literal = model.includes("/") && !model.startsWith("@");
		if (literal && !models.some(entry => entry.selector.toLowerCase() === model.toLowerCase())) {
			throw new Error(`Preset "${name}" not applied: default model \`${presetDefault}\` is not available`);
		}
	} else if (!models.some(entry => entry.kind === "chat")) {
		throw new Error(`Preset "${name}" not applied: no model with configured credentials is available`);
	}

	const [storage, before, layers] = await Promise.all([roleStorage(cwd), readRoles(cwd), readLayers(cwd)]);
	const roleIds = new Set([...before.roles.filter(role => role.value !== null).map(role => role.id), ...Object.keys(preset.modelRoles)]);
	const layer = storage === "project" ? layers.project : layers.global;
	const assigned = stringRecord(layerValue(layer, "modelRoles"));
	await editConfig(storage, cwd, doc => {
		for (const role of roleIds) {
			const value = preset.modelRoles[role];
			if (value !== undefined) setDocumentPath(doc, ["modelRoles", role], value);
			else if (Object.hasOwn(assigned, role)) deleteDocumentPath(doc, ["modelRoles", role]);
		}
		if (storage === "global" && preset.defaultThinkingLevel) setDocumentPath(doc, ["defaultThinkingLevel"], preset.defaultThinkingLevel);
	});
	if (storage === "project" && preset.defaultThinkingLevel) {
		await setConfigPath("global", cwd, ["defaultThinkingLevel"], preset.defaultThinkingLevel);
	}
	configWritten();

	const [roles, thinkingLeaf] = await Promise.all([readRoles(cwd), readLeaf("defaultThinkingLevel", cwd)]);
	const shadowed = roles.roles.flatMap(role => {
		const expected = preset.modelRoles[role.id] ?? null;
		return expected === role.value ? [] : [{ role: role.id, expected, actual: role.value, source: role.source }];
	});
	const actualThinking = DefaultThinkingSchema.parse(thinkingLeaf.value);
	const shadowedThinking =
		preset.defaultThinkingLevel && preset.defaultThinkingLevel !== actualThinking
			? { expected: preset.defaultThinkingLevel, actual: actualThinking, source: thinkingLeaf.source }
			: null;
	return { roles, shadowed, shadowedThinking };
}

async function deletePreset(name: string, cwd: string | undefined): Promise<PresetDeleteResult> {
	const layers = await readLayers(cwd);
	const inProject = layerValue(layers.project, `modelPresets.${name}`) !== undefined;
	if (await deleteConfigPath("global", cwd, ["modelPresets", name])) {
		return inProject ? "project" : "deleted";
	}
	return inProject ? "project" : "missing";
}

// ─── Approval ──────────────────────────────────────────────────────────────

const ApprovalModeSchema = z.enum(["always-ask", "write", "yolo"]);
const ApprovalPolicySchema = z.enum(["allow", "prompt", "deny"]);

async function readApproval(cwd: string | undefined): Promise<ApprovalState> {
	const [modeLeaf, policiesLeaf, layers] = await Promise.all([
		readLeaf("tools.approvalMode", cwd),
		readLeaf("tools.approval", cwd),
		readLayers(cwd),
	]);
	const projectPolicies = layerValue(layers.project, "tools.approval");
	const effective = isJsonObject(policiesLeaf.value) ? policiesLeaf.value : {};
	const policies: ApprovalState["policies"] = [];
	const unrecognized: ApprovalState["unrecognized"] = [];
	for (const [tool, value] of Object.entries(effective).sort(([a], [b]) => a.localeCompare(b))) {
		const policy = ApprovalPolicySchema.safeParse(value);
		if (!policy.success) {
			unrecognized.push({ tool, value });
			continue;
		}
		const fromProject = isJsonObject(projectPolicies) && Object.hasOwn(projectPolicies, tool);
		policies.push({ tool, policy: policy.data, source: fromProject ? "project" : "global" });
	}
	return { cwd: cwd ?? null, mode: ApprovalModeSchema.parse(modeLeaf.value), modeSource: modeLeaf.source, policies, unrecognized };
}

async function setApprovalMode(mode: ApprovalMode, scope: SettingScope, cwd: string | undefined): Promise<ApprovalState> {
	await setConfigPath(scope, cwd, ["tools", "approvalMode"], ApprovalModeSchema.parse(mode));
	configWritten();
	return readApproval(cwd);
}

async function setApprovalPolicy(
	tool: string,
	policy: ApprovalPolicy | null,
	scope: SettingScope,
	cwd: string | undefined,
): Promise<ApprovalState> {
	const name = tool.trim();
	if (!name) throw new Error("A tool name is required");
	if (policy === null) await deleteConfigPath(scope, cwd, ["tools", "approval", name]);
	else await setConfigPath(scope, cwd, ["tools", "approval", name], ApprovalPolicySchema.parse(policy));
	configWritten();
	return readApproval(cwd);
}

// ─── Providers ─────────────────────────────────────────────────────────────

async function providerStatus(cwd: string | undefined): Promise<ProviderAuthStatus[]> {
	const [models, usageJson] = await Promise.all([listModels(cwd), ompJson(["usage", "--json"], cwd, 60_000)]);
	const usage = UsageJsonSchema.parse(usageJson);
	const byProvider = new Map<string, ProviderAuthStatus>();
	const entry = (provider: string): ProviderAuthStatus => {
		let status = byProvider.get(provider);
		if (!status) {
			status = { provider, available: false, modelCount: 0, kinds: [], accounts: [], disabledAccounts: [] };
			byProvider.set(provider, status);
		}
		return status;
	};
	for (const model of models) {
		const status = entry(model.provider);
		status.available = true;
		status.modelCount++;
		if (!status.kinds.includes(model.kind)) status.kinds.push(model.kind);
	}
	for (const report of usage.reports) {
		entry(report.provider).accounts.push({
			email: report.metadata?.email ?? null,
			accountId: report.metadata?.accountId ?? null,
			orgName: report.metadata?.orgName ?? null,
			usageReported: true,
		});
	}
	for (const account of usage.accountsWithoutUsage) {
		entry(account.provider).accounts.push({
			email: account.email ?? null,
			accountId: account.accountId ?? null,
			orgName: account.orgName ?? null,
			usageReported: false,
		});
	}
	for (const disabled of usage.disabledCredentials) {
		entry(disabled.provider).disabledAccounts.push({
			email: disabled.email ?? null,
			accountId: disabled.accountId ?? null,
			cause: disabled.cause,
			disabledAt: disabled.disabledAtMs ?? null,
		});
	}
	return [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

// ─── Watching ──────────────────────────────────────────────────────────────

const WATCH_INTERVAL_MS = 1000;
/** Watched file → reference count and stop function. */
const watchers = new Map<string, { refs: number; stop: () => void }>();

function watchConfigFile(file: string, scope: SettingScope, cwd: string | null): void {
	const existing = watchers.get(file);
	if (existing) {
		existing.refs++;
		return;
	}
	// Stat polling survives atomic renames and files that do not exist yet.
	const listener = (current: Stats, previous: Stats) => {
		if (current.mtimeMs === previous.mtimeMs && current.size === previous.size && current.ino === previous.ino) return;
		if (isOwnWrite(file, current)) return;
		configWritten();
		broadcast("config:changed", { scope, cwd, file });
	};
	watchFile(file, { interval: WATCH_INTERVAL_MS, persistent: false }, listener);
	watchers.set(file, { refs: 1, stop: () => unwatchFile(file, listener) });
}

function releaseConfigFile(file: string): void {
	const existing = watchers.get(file);
	if (!existing) return;
	if (--existing.refs > 0) return;
	existing.stop();
	watchers.delete(file);
}

/** Both global names are watched: omp reads `config.yaml` only while `config.yml` is absent. */
async function watchedFiles(cwd: string | undefined): Promise<{ file: string; scope: SettingScope; cwd: string | null }[]> {
	const dir = await ompAgentDir();
	const files: { file: string; scope: SettingScope; cwd: string | null }[] = [
		{ file: join(dir, "config.yml"), scope: "global", cwd: null },
		{ file: join(dir, "config.yaml"), scope: "global", cwd: null },
	];
	if (cwd) files.push({ file: await configFile("project", cwd), scope: "project", cwd });
	return files;
}

// ─── IPC ───────────────────────────────────────────────────────────────────

const ScopeSchema = z.enum(["global", "project"]);

export function register(): void {
	handle("config:list", cwd => listSettings(cwd));
	handle("config:get", (key, cwd) => getSetting(key, cwd));
	handle("config:set", (key, value, scope, cwd) => setSetting(key, value, ScopeSchema.parse(scope), cwd));
	handle("config:reset", (key, scope, cwd) => resetSetting(key, ScopeSchema.parse(scope), cwd));
	handle("config:watch", async cwd => {
		for (const { file, scope, cwd: owner } of await watchedFiles(cwd)) watchConfigFile(file, scope, owner);
	});
	handle("config:unwatch", async cwd => {
		for (const { file } of await watchedFiles(cwd)) releaseConfigFile(file);
	});

	handle("config:models", cwd => listModels(cwd));
	handle("config:models:refresh", cwd => listModels(cwd, true));

	handle("config:roles", cwd => readRoles(cwd));
	handle("config:roles:set", (role, assignment, options) =>
		setRole(role, assignment, options && { ...options, scope: options.scope && ScopeSchema.parse(options.scope) }),
	);

	handle("config:presets", cwd => listPresets(cwd));
	handle("config:presets:save", (name, cwd) => savePreset(name, cwd));
	handle("config:presets:apply", (name, cwd) => applyPreset(name, cwd));
	handle("config:presets:delete", (name, cwd) => deletePreset(name, cwd));

	handle("config:approval", cwd => readApproval(cwd));
	handle("config:approval:setMode", (mode, scope, cwd) => setApprovalMode(mode, ScopeSchema.parse(scope), cwd));
	handle("config:approval:setPolicy", (tool, policy, scope, cwd) => setApprovalPolicy(tool, policy, ScopeSchema.parse(scope), cwd));

	handle("config:providers", cwd => providerStatus(cwd));
}
