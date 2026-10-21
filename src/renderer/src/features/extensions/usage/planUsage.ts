/**
 * Plan usage from `omp usage`: per chat for the status bar (DESIGN §3.8: which reports and limit
 * windows apply to the chat's models, pooled across accounts, and the window each provider shows),
 * and per provider account for the Usage & limits page ({@link planLimits}).
 */
import type { SessionEntry, WireModel } from "@oh-my-pi/pi-wire";
import type { DisabledCredential, ProviderWindowStat, UsageLimit, UsageLimitsSnapshot, UsageReport, UsageStatus } from "@shared/contracts/usage";
import { formatDuration } from "../format";
import { limitTone, usedFraction } from "./model";

/** A model as `provider/modelId`. */
export interface ModelRef {
	provider: string;
	modelId: string;
}

/** One limit window as the status bar shows it. */
export interface WindowUsage {
	/** {@link UsageLimit.id}. */
	id: string;
	/** omp's full limit label, e.g. `Claude 5 Hour`. */
	label: string;
	/** Compact window name, e.g. `5h`, `7d`, `7d fable`. */
	window: string;
	/**
	 * omp's limit label, set only when another window of the provider has the same compact name and
	 * this label is readable (Kimi's `Weekly limit` beside its `limit_7d` meter); the tooltip shows it.
	 */
	detail?: string;
	/** 0..1 (above 1 means overage); null when the provider reports nothing usable. */
	fraction: number | null;
	status: UsageStatus | undefined;
	tone: "ok" | "warn" | "err";
	/** Epoch ms of the next reset (the soonest one across pooled accounts). */
	resetsAt: number | null;
}

export interface ProviderUsage {
	provider: string;
	/** Accounts reporting for this provider; above 1 the windows use omp's pooled capacity. */
	accounts: number;
	windows: WindowUsage[];
	/** The window the status bar shows (see {@link pickBinding}). */
	top: WindowUsage;
	/** Epoch ms of the oldest report behind these figures (omp caches provider reports). */
	fetchedAt: number;
}

const PROVIDER_NAMES: Record<string, string> = {
	anthropic: "Claude",
	"openai-codex": "Codex",
	"kimi-code": "Kimi",
	"github-copilot": "Copilot",
	"google-gemini-cli": "Gemini",
	"google-antigravity": "Antigravity",
	cursor: "Cursor",
	zai: "Z.ai",
	"minimax-code": "MiniMax",
	"xai-oauth": "Grok",
	"alibaba-token-plan": "Alibaba",
	"opencode-go": "OpenCode Go",
	"ollama-cloud": "Ollama Cloud",
	ollama: "Ollama",
	synthetic: "Synthetic",
	umans: "Umans",
};

/** Short product name of a model provider; unknown ids are title-cased the way `omp usage` prints them. */
export function providerName(provider: string): string {
	return (
		PROVIDER_NAMES[provider] ??
		provider
			.split(/[-_]/g)
			.map(part => (part ? part[0].toUpperCase() + part.slice(1) : ""))
			.join(" ")
	);
}

const THINKING_LEVELS: Record<string, true> = { inherit: true, off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true };

/** Parses omp's `provider/modelId[@route][:thinking]` selector (subagent `resolvedModel`). */
export function parseModelSelector(selector: string): ModelRef | null {
	const slash = selector.indexOf("/");
	if (slash <= 0) return null;
	let modelId = selector.slice(slash + 1);
	const colon = modelId.lastIndexOf(":");
	if (colon > 0 && THINKING_LEVELS[modelId.slice(colon + 1)] === true) modelId = modelId.slice(0, colon);
	const at = modelId.lastIndexOf("@");
	if (at > 0) modelId = modelId.slice(0, at);
	return modelId ? { provider: selector.slice(0, slash), modelId } : null;
}

/**
 * The chat's own model. The live omp state wins; a saved chat that has not started omp yet falls back
 * to its active branch (`entries`, root to leaf): the last `model_change`, else the last assistant
 * reply's model. omp writes `provider` and `model` on each assistant message in the session file.
 */
export function chatModel(live: WireModel | undefined, entries: readonly SessionEntry[]): ModelRef | null {
	if (live) return { provider: live.provider, modelId: live.id };
	let reply: ModelRef | null = null;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "model_change") {
			const changed = parseModelSelector(entry.model);
			if (changed) return changed;
		} else if (!reply && entry.type === "message" && entry.message.role === "assistant") {
			const { model, provider } = entry.message as { model?: string; provider?: string };
			if (model) reply = provider ? { provider, modelId: model } : parseModelSelector(model);
		}
	}
	return reply;
}

/** The chat's own model first, then the models of its running subagents, without duplicates. */
export function modelsInUse(main: ModelRef | null, subagents: Iterable<{ status: string; resolvedModel?: string }>): ModelRef[] {
	const models: ModelRef[] = main ? [main] : [];
	for (const agent of subagents) {
		if (agent.status !== "running" && agent.status !== "pending") continue;
		const model = agent.resolvedModel ? parseModelSelector(agent.resolvedModel) : null;
		if (model && !models.some(known => known.provider === model.provider && known.modelId === model.modelId)) models.push(model);
	}
	return models;
}

/** Models the status bar has shown this app session: model ids per provider, providers in first-seen order. */
export type SeenModels = ReadonlyMap<string, readonly string[]>;

/** `seen` with `models` added; the same map when every model is already in it. */
export function rememberModels(seen: SeenModels, models: readonly ModelRef[]): SeenModels {
	let next: Map<string, readonly string[]> | null = null;
	for (const { provider, modelId } of models) {
		const known = (next ?? seen).get(provider) ?? [];
		if (known.includes(modelId)) continue;
		next ??= new Map(seen);
		next.set(provider, [...known, modelId]);
	}
	return next ?? seen;
}

/**
 * What the status bar shows: the models in use now, then, for each provider seen earlier this session
 * and not in use now, every model it was seen with. A provider in use now keeps only its current
 * models, so its window follows the chat; one shown before stays after its helper or chat stops.
 */
export function withSeenProviders(current: readonly ModelRef[], seen: SeenModels): ModelRef[] {
	const out = [...current];
	for (const [provider, modelIds] of seen) {
		if (current.some(model => model.provider === provider)) continue;
		for (const modelId of modelIds) out.push({ provider, modelId });
	}
	return out;
}

const bareModelId = (modelId: string) => modelId.slice(modelId.lastIndexOf("/") + 1);

/** Claude family of a model id (`claude-opus-5-5` → `opus`), as omp's `parseAnthropicModel` reads it. */
function claudeKind(modelId: string): string | undefined {
	const id = bareModelId(modelId);
	return (
		/claude-(opus|sonnet|fable|mythos)-\d{1,2}(?:[.-]\d{1,2}){0,2}\b/.exec(id)?.[1] ??
		/claude-\d{1,2}(?:[.-]\d{1,2}){0,2}-(opus|sonnet|fable|mythos)\b/.exec(id)?.[1]
	);
}

/**
 * Whether a limit binds any of the provider's models in use. A `scope.modelId` limit counts only for
 * that model. Anthropic rows follow omp's own scoping (`scopeClaudeLimitsForModel`): shared windows
 * always count, tier rows (Fable, Opus weekly) only for the matching Claude family, and the remaining
 * rows (extra usage spend) are left out.
 */
export function limitApplies(limit: UsageLimit, modelIds: readonly string[]): boolean {
	const scoped = limit.scope.modelId;
	if (scoped !== undefined) return modelIds.some(id => bareModelId(id) === bareModelId(scoped));
	if (limit.scope.provider !== "anthropic") return true;
	if (limit.scope.shared === true) return true;
	const tier = limit.scope.tier;
	return tier !== undefined && modelIds.some(id => claudeKind(id) === tier);
}

const DURATION_UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const DURATION_TOKEN = /(?<![a-z0-9.])(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)(?![a-z0-9])/gi;

/**
 * Duration in ms of a window name that holds exactly one duration token (`7d`, `limit_7d`, `7 Day`,
 * `30 days`, `1w`); null when it holds none or several, or digits sit inside another word.
 */
export function parseWindowDuration(text: string): number | null {
	const tokens = [...text.matchAll(DURATION_TOKEN)];
	if (tokens.length !== 1) return null;
	const [, amount, unit] = tokens[0];
	return Number(amount) * DURATION_UNIT_MS[unit[0].toLowerCase()];
}

/** omp's window duration, else one read from the window id, scope or label; null when none can be read. */
function windowDurationMs(limit: UsageLimit): number | null {
	const window = limit.window;
	let durationMs = window?.durationMs ?? null;
	for (const text of [window?.id, limit.scope.windowId, window?.label]) {
		if (durationMs === null && text) durationMs = parseWindowDuration(text);
	}
	return durationMs;
}

/** Compact window name: the window's duration, else the human label. */
function windowName(limit: UsageLimit): string {
	const durationMs = windowDurationMs(limit);
	return durationMs !== null ? formatDuration(durationMs) : (limit.window?.label ?? limit.label);
}

const FIVE_HOURS_MS = 5 * 3_600_000;
const SEVEN_DAYS_MS = 7 * 86_400_000;
const MONTHLY_WORD = /(?<![a-z])month(?:ly)?(?![a-z])/i;

/**
 * Which window kind the status bar prefers: 0 for 5 hours, 1 for 7 days, 2 for a month (28 to 31 days,
 * or a window without a duration whose id or label says monthly), null for any other window.
 */
function windowPreference(limit: UsageLimit): number | null {
	const durationMs = windowDurationMs(limit);
	if (durationMs === FIVE_HOURS_MS) return 0;
	if (durationMs === SEVEN_DAYS_MS) return 1;
	if (durationMs !== null) return durationMs >= 28 * 86_400_000 && durationMs <= 31 * 86_400_000 ? 2 : null;
	const texts = [limit.window?.id, limit.scope.windowId, limit.window?.label, limit.label];
	return texts.some(text => text !== undefined && MONTHLY_WORD.test(text)) ? 2 : null;
}

/**
 * omp's pooled capacity bucket for a limit (see `computeProviderWindowStats`): the same window, and
 * the limit's tier as the bucket's meter. Anthropic keeps tier rows (Fable weekly) and shared windows
 * in separate meters, so its buckets must match the meter exactly (no meter for a shared window) and a
 * missing bucket returns undefined. Other providers name meters without a tier (Codex's `chat`), so a
 * window's only bucket stands in for it.
 */
function capacityStat(stats: readonly ProviderWindowStat[], limit: UsageLimit): ProviderWindowStat | undefined {
	const durationMs = limit.window?.durationMs;
	const name = limit.window?.label ?? limit.scope.windowId ?? limit.label;
	const candidates = stats.filter(stat => (durationMs !== undefined ? stat.durationMs === durationMs : stat.durationMs === undefined && stat.window === name));
	const exact = candidates.find(stat => stat.meter === limit.scope.tier);
	if (exact || limit.scope.provider === "anthropic") return exact;
	return candidates.length === 1 ? candidates[0] : undefined;
}

function pooledStatus(statuses: readonly (UsageStatus | undefined)[]): UsageStatus | undefined {
	if (statuses.length > 0 && statuses.every(status => status === "exhausted")) return "exhausted";
	if (statuses.some(status => status === "warning" || status === "exhausted")) return "warning";
	return statuses.find(status => status !== undefined);
}

/** A window with its {@link windowPreference}. */
interface RankedWindow {
	usage: WindowUsage;
	preference: number | null;
}

/**
 * The provider's windows that bind `modelIds`. With one account each limit is read as reported; with
 * several, a limit id's rows across accounts merge into omp's pooled capacity figure (accounts' worth
 * of quota used / accounts), falling back to the mean fraction when omp reports no matching bucket.
 * A pooled window is exhausted only when every reporting account reports it exhausted; an account
 * without the row counts as not exhausted. Rows that share a compact name stay separate: a tier tells
 * them apart (`7d` and `7d fable`), else a readable limit label goes into `detail`.
 */
function providerWindows(reports: readonly UsageReport[], modelIds: readonly string[], stats: readonly ProviderWindowStat[]): RankedWindow[] {
	// Each limit id's row per account, by report index; undefined where an account has no such row.
	const groups = new Map<string, (UsageLimit | undefined)[]>();
	reports.forEach((report, account) => {
		for (const limit of report.limits) {
			if (!limitApplies(limit, modelIds)) continue;
			const rows = groups.get(limit.id) ?? new Array<UsageLimit | undefined>(reports.length).fill(undefined);
			rows[account] = limit;
			groups.set(limit.id, rows);
		}
	});
	const present = [...groups.values()].map(rows => rows.filter((row): row is UsageLimit => row !== undefined));
	const firsts = present.map(([limit]) => limit);
	const durations = firsts.map(windowName);
	// Rows that share a compact name (`7d` and its Fable tier) keep apart by their tier.
	const names = durations.map((name, index) => {
		const tier = firsts[index].scope.tier;
		return tier && durations.some((other, otherIndex) => otherIndex !== index && other === name) ? `${name} ${tier}` : name;
	});
	return [...groups.values()].map((rows, index): RankedWindow => {
		const limits = present[index];
		const first = limits[0];
		const stat = reports.length > 1 ? capacityStat(stats, first) : undefined;
		const known = limits.map(usedFraction).filter((fraction): fraction is number => fraction !== null);
		const fraction =
			stat && stat.accounts > 0 ? stat.usedAccounts / stat.accounts : known.length > 0 ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
		const status = pooledStatus(rows.map(row => row?.status));
		const resets = limits.map(limit => limit.window?.resetsAt).filter((at): at is number => at !== undefined);
		const name = names[index];
		const clash = names.some((other, otherIndex) => otherIndex !== index && other === name);
		const readable = /\s/.test(first.label) && parseWindowDuration(first.label) === null;
		const usage: WindowUsage = {
			id: first.id,
			label: first.label,
			window: name,
			detail: clash && readable ? first.label : undefined,
			fraction,
			status,
			tone: limitTone(fraction, status),
			resetsAt: resets.length > 0 ? Math.min(...resets) : null,
		};
		return { usage, preference: windowPreference(first) };
	});
}

/** What {@link pickBinding} reads from a window. */
interface BindingCandidate {
	fraction: number | null;
	/** The window blocks work: reported exhausted (the status bar), or reached (the Usage page). */
	exhausted: boolean;
	/** {@link windowPreference}. */
	preference: number | null;
}

/**
 * The window that binds, among those with a known fraction: an exhausted one (it blocks work), else the
 * 5h window, else 7d, else monthly, else the most-used one. Several windows of the chosen kind (Claude's
 * `7d` and `7d fable`) yield the most-used. The status bar and the Usage page's provider rows both use it.
 */
function pickBinding<T>(items: readonly T[], read: (item: T) => BindingCandidate): T | undefined {
	const known = items.map(item => ({ item, ...read(item) })).filter(candidate => candidate.fraction !== null);
	const exhausted = known.filter(candidate => candidate.exhausted);
	const preferences = known.map(candidate => candidate.preference).filter((preference): preference is number => preference !== null);
	const preferred = preferences.length > 0 ? Math.min(...preferences) : null;
	const pool = exhausted.length > 0 ? exhausted : preferred !== null ? known.filter(candidate => candidate.preference === preferred) : known;
	return pool.sort((a, b) => Number(b.exhausted) - Number(a.exhausted) || (b.fraction ?? 0) - (a.fraction ?? 0))[0]?.item;
}

/**
 * Plan usage per provider of `models`, in the order the providers first appear. Providers without a
 * report (API keys with no usage endpoint) and providers whose windows report no usable fraction are
 * left out.
 */
export function planUsage(snapshot: UsageLimitsSnapshot | null, models: readonly ModelRef[]): ProviderUsage[] {
	if (!snapshot) return [];
	const byProvider = new Map<string, string[]>();
	for (const model of models) byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model.modelId]);
	const out: ProviderUsage[] = [];
	for (const [provider, modelIds] of byProvider) {
		const reports = snapshot.reports.filter(report => report.provider === provider && report.limits.length > 0);
		if (reports.length === 0) continue;
		const windows = providerWindows(reports, modelIds, snapshot.capacity[provider] ?? []);
		const top = pickBinding(windows, window => ({ fraction: window.usage.fraction, exhausted: window.usage.status === "exhausted", preference: window.preference }))?.usage;
		if (!top) continue;
		out.push({ provider, accounts: reports.length, windows: windows.map(window => window.usage), top, fetchedAt: Math.min(...reports.map(report => report.fetchedAt)) });
	}
	return out;
}

/** How a limit row reads on the Usage & limits page. */
export type LimitState = "ok" | "near" | "reached" | "unavailable";

export interface LimitRow {
	/** {@link UsageLimit.id}. */
	id: string;
	/** Window length for "5-hour limit"; null when omp gives none and the id, scope and label hold none. */
	durationMs: number | null;
	/** A window without a duration that omp names monthly. */
	monthly: boolean;
	/** Which window kind binds first ({@link windowPreference}). */
	preference: number | null;
	/** omp's label without a leading provider name; names the row when the window has no duration. */
	label: string;
	/** Tells rows of one window apart: the tier or model, plus a readable omp label when names still clash. */
	qualifier: string | null;
	/** 0..1 (above 1 means overage); null when the provider reports nothing usable. */
	fraction: number | null;
	state: LimitState;
	tone: "ok" | "warn" | "err";
	resetsAt: number | null;
	/** Provider verb for the reset (`regen`), when it reports one; omp's default is "resets". */
	resetLabel: string | null;
	notes: string[];
}

export interface AccountId {
	key: "provider" | "account" | "org" | "plan" | "limit";
	value: string;
}

/** Saved rate-limit resets of an account, from its report's `resetCredits`. */
export interface SavedResets {
	/** Banked resets, including ones not usable now (omp's `availableCount`). */
	count: number;
	/** Resets the provider says are usable now, when it says. */
	usable: number | null;
	/** Expiry times of the banked resets in epoch ms, soonest first. */
	expiries: number[];
	/**
	 * {@link UsageLimit.id}s the next reset clears, as omp's last report gives them: only when the report
	 * names the next credit (`nextCreditId`) and that credit lists them; empty otherwise.
	 */
	clears: string[];
}

/** Who an account is, as omp's report or credential names it. */
export interface AccountIdentity {
	accountId?: string;
	email?: string;
	orgId?: string;
	orgName?: string;
}

export interface AccountLimits {
	key: string;
	/** Email, else organization, else null (an account omp reports without a name). */
	name: string | null;
	/** Organization, when `name` is the email. */
	detail: string | null;
	identity: AccountIdentity;
	/**
	 * `report`: omp returned a report (possibly without limits); `unavailable`: a usage-capable account
	 * without a report; `disabled`: known only from a credential omp disabled.
	 */
	kind: "report" | "unavailable" | "disabled";
	/** Epoch ms of omp's cached report. */
	fetchedAt: number | null;
	rows: LimitRow[];
	/** Saved resets the report lists; null without any. */
	resets: SavedResets | null;
	disabled: DisabledCredential[];
	notes: string[];
	/** Raw identifiers for the technical details; plan ids stay here until a verified name mapping exists. */
	ids: AccountId[];
}

export interface ProviderLimits {
	provider: string;
	accounts: AccountLimits[];
}

const metaText = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** Same account: equal account ids, else (one side without an id) equal emails in a compatible organization. */
function sameIdentity(a: AccountIdentity, b: AccountIdentity): boolean {
	if (a.accountId !== undefined && b.accountId !== undefined) return a.accountId === b.accountId;
	return a.email !== undefined && a.email === b.email && (a.orgId === undefined || b.orgId === undefined || a.orgId === b.orgId);
}

const rowSeverity = (row: LimitRow) => (row.state === "reached" ? 0 : row.state === "near" ? 1 : 2);

/** Credit states that no longer count toward the saved resets. */
const SPENT_CREDIT = /^(redeemed|expired|used|revoked)$/i;

function savedResets(report: UsageReport): SavedResets | null {
	const credits = report.resetCredits;
	if (!credits || credits.availableCount <= 0) return null;
	const list = (credits.credits ?? []).filter(credit => !credit.status || !SPENT_CREDIT.test(credit.status));
	const next = credits.nextCreditId === undefined ? undefined : list.find(credit => credit.id === credits.nextCreditId);
	const expiries = list
		.map(credit => (credit.expiresAt ? Date.parse(credit.expiresAt) : Number.NaN))
		.filter(Number.isFinite)
		.sort((a, b) => a - b);
	return { count: credits.availableCount, usable: credits.redeemableCount ?? null, expiries, clears: next?.clears ?? [] };
}

/** A saved reset expiring within this long gets a warning on the Usage page; omp's own banner uses 24 hours. */
export const RESET_EXPIRY_WARN_MS = 86_400_000;

/** The soonest expiry still ahead of `now`, or null. */
export function soonestExpiry(resets: SavedResets, now: number): number | null {
	return resets.expiries.find(at => at > now) ?? null;
}

function limitRows(report: UsageReport): LimitRow[] {
	const prefix = `${providerName(report.provider)} `;
	const rows = report.limits.map((limit): LimitRow => {
		const fraction = usedFraction(limit);
		const tone = limitTone(fraction, limit.status);
		const durationMs = windowDurationMs(limit);
		const reached = limit.status === "exhausted" || (fraction ?? 0) >= 1;
		const near = limit.status === "warning" || (fraction !== null && tone !== "ok");
		const { tier, modelId } = limit.scope;
		const preference = windowPreference(limit);
		return {
			id: limit.id,
			durationMs,
			monthly: durationMs === null && preference === 2,
			preference,
			label: limit.label.startsWith(prefix) ? limit.label.slice(prefix.length) : limit.label,
			qualifier: tier ? tier[0].toUpperCase() + tier.slice(1) : modelId ? bareModelId(modelId) : null,
			fraction,
			state: reached ? "reached" : near ? "near" : fraction === null ? "unavailable" : "ok",
			tone,
			resetsAt: limit.window?.resetsAt ?? null,
			resetLabel: limit.window?.resetLabel ?? null,
			notes: limit.notes ?? [],
		};
	});
	// Rows whose names still match (Kimi's `Weekly limit` and `limit_7d`, both 7 days) add omp's label when it reads as words.
	const nameOf = (row: LimitRow) => `${row.durationMs ?? (row.monthly ? "monthly" : row.label)}|${row.qualifier ?? ""}`;
	const names = rows.map(nameOf);
	for (const [index, row] of rows.entries()) {
		const clash = names.some((name, other) => other !== index && name === names[index]);
		const named = row.durationMs !== null || row.monthly;
		if (clash && named && /\s/.test(row.label) && parseWindowDuration(row.label) === null) {
			row.qualifier = row.qualifier ? `${row.qualifier}, ${row.label}` : row.label;
		}
	}
	return rows.sort((a, b) => rowSeverity(a) - rowSeverity(b));
}

/** Disabled or limit-reached accounts first, then near-limit ones, then by the highest known use. */
function compareAccounts(a: AccountLimits, b: AccountLimits): number {
	const severity = (account: AccountLimits) => (account.disabled.length > 0 ? 0 : Math.min(2, ...account.rows.map(rowSeverity)));
	const peak = (account: AccountLimits) => Math.max(-1, ...account.rows.map(row => row.fraction ?? -1));
	return severity(a) - severity(b) || peak(b) - peak(a);
}

/**
 * Every account omp knows for the Usage & limits page, grouped by provider: accounts with reports,
 * usage-capable accounts without one (`accountsWithoutUsage`), and disabled credentials (attached to
 * their account when the identity matches). Accounts and providers are ordered by
 * {@link compareAccounts} with stable ties; rows are never merged across accounts or windows, since
 * equal figures do not show that two quotas are one.
 */
export function planLimits(snapshot: UsageLimitsSnapshot): ProviderLimits[] {
	const groups = new Map<string, AccountLimits[]>();
	const add = (provider: string, account: AccountLimits) => groups.set(provider, [...(groups.get(provider) ?? []), account]);
	const ids = (provider: string, identity: AccountIdentity, plan?: string): AccountId[] => [
		{ key: "provider", value: provider },
		...(identity.accountId ? [{ key: "account" as const, value: identity.accountId }] : []),
		...(identity.orgId ? [{ key: "org" as const, value: identity.orgId }] : []),
		...(plan ? [{ key: "plan" as const, value: plan }] : []),
	];
	const known = ({ accountId, email, orgId, orgName }: AccountIdentity) => ({
		identity: { accountId, email, orgId, orgName },
		name: email ?? orgName ?? null,
		detail: email ? (orgName ?? null) : null,
	});

	for (const [index, report] of snapshot.reports.entries()) {
		const meta = report.metadata ?? {};
		const identity: AccountIdentity = { accountId: metaText(meta.accountId), email: metaText(meta.email), orgId: metaText(meta.orgId), orgName: metaText(meta.orgName) };
		add(report.provider, {
			key: `report:${report.provider}:${identity.accountId ?? identity.email ?? index}`,
			...known(identity),
			kind: "report",
			fetchedAt: report.fetchedAt,
			rows: limitRows(report),
			resets: savedResets(report),
			disabled: [],
			notes: report.notes ?? [],
			ids: [...ids(report.provider, identity, metaText(meta.planType)), ...report.limits.map(limit => ({ key: "limit" as const, value: limit.id }))],
		});
	}
	for (const [index, account] of snapshot.accountsWithoutUsage.entries()) {
		add(account.provider, {
			key: `unavailable:${account.provider}:${account.accountId ?? account.email ?? index}`,
			...known(account),
			kind: "unavailable",
			fetchedAt: null,
			rows: [],
			resets: null,
			disabled: [],
			notes: [],
			ids: ids(account.provider, account),
		});
	}
	for (const credential of snapshot.disabledCredentials) {
		const match = groups.get(credential.provider)?.find(account => sameIdentity(account.identity, credential));
		if (match) {
			match.disabled.push(credential);
			continue;
		}
		add(credential.provider, {
			key: `disabled:${credential.id}`,
			...known(credential),
			kind: "disabled",
			fetchedAt: null,
			rows: [],
			resets: null,
			disabled: [credential],
			notes: [],
			ids: ids(credential.provider, credential),
		});
	}

	const providers = [...groups].map(([provider, accounts]) => ({ provider, accounts: accounts.sort(compareAccounts) }));
	return providers.sort((a, b) => compareAccounts(a.accounts[0], b.accounts[0]));
}

/** A limit window of one account. */
export interface AccountRow {
	account: AccountLimits;
	row: LimitRow;
}

/** A provider's collapsed row on the Usage & limits page. */
export interface ProviderSummary {
	/**
	 * The binding window across the provider's accounts ({@link pickBinding}, a reached window counting
	 * as exhausted); null when no window reports a usable figure.
	 */
	binding: AccountRow | null;
	/** Other windows near or at their limit, most severe first; they stay visible while the row is collapsed. */
	alerts: AccountRow[];
	/** Accounts with a sign-in omp stopped using. */
	disabled: AccountLimits[];
	/** Accounts omp knows that report no usable figure: no report, or only windows without one. */
	unknown: AccountLimits[];
}

export function providerSummary(provider: ProviderLimits): ProviderSummary {
	const rows = provider.accounts.flatMap(account => account.rows.map((row): AccountRow => ({ account, row })));
	const binding = pickBinding(rows, ({ row }) => ({ fraction: row.fraction, exhausted: row.state === "reached", preference: row.preference })) ?? null;
	return {
		binding,
		alerts: rows.filter(entry => entry !== binding && (entry.row.state === "reached" || entry.row.state === "near")).sort((a, b) => rowSeverity(a.row) - rowSeverity(b.row)),
		disabled: provider.accounts.filter(account => account.disabled.length > 0),
		unknown: provider.accounts.filter(account => account.kind !== "disabled" && account.rows.every(row => row.fraction === null)),
	};
}
