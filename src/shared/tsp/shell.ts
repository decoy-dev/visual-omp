/**
 * Presentation types vendored from oh-my-pi v18.17.0, commit 75e7801e247d4e3263439d4cc08ccad60dc64bdd,
 * packages/wire/src/shell-viz.ts and tsp.ts. Copyright (c) 2025 Mario Zechner,
 * 2025-2026 Can Bölük, 2026 Stencil Labs, Inc. MIT licensed; see src/main/omp/tsp/LICENSE and NOTICE.
 */
import type { TspNode } from "../tsp";
import type { TspHostSnapshot, TspRendererEvent, TspSurfaceSnapshot } from "../tsp-host";

export type ShellTraceState = "pending" | "running" | "ok" | "fail" | "skipped";
export type ShellVizView = "raw" | "pseudo";
export type ShellVizLayer = "color" | "inline" | "idioms" | "effects" | "unwrap";
export interface ShellVizLayers { color: boolean; inline: boolean; idioms: boolean; effects: boolean; unwrap: boolean }
export interface ShellVizPreferences {
	view: ShellVizView;
	layers: ShellVizLayers;
	split: boolean;
	cursor?: number;
	playing: boolean;
	speed: number;
	selectedNode?: string;
	expandedNodes: string[];
}
/** Source ranges are outer-source UTF-16 offsets. Native node keys remain opaque. */
export interface ShellVizSegment {
	text: string;
	active?: boolean;
	state?: ShellTraceState;
	executedAtNs?: number;
	executionSeq?: number;
	style?: string;
	node?: string;
	executionNode?: string;
	range?: [number, number];
	tip?: string;
	expanded?: string;
	language?: string;
}
/** Heuristic annotations have no safety or completeness guarantee. */
export interface ShellVizEffect {
	kind: "network" | "write" | "destructive" | "secret" | "privilege" | "background";
	glyph: string;
	label: string;
	why: string;
}
export interface ShellVizRow {
	id: string;
	depth: number;
	node?: string;
	range?: [number, number];
	active?: boolean;
	role?: "stmt" | "head" | "mid" | "tail" | "raw" | "document";
	state?: ShellTraceState;
	segments: ShellVizSegment[];
	effects: ShellVizEffect[];
	executedAtNs?: number;
	executionSeq?: number;
	meta?: string;
	detail?: string;
	annotations?: ShellVizWatch[];
}
/** Values and setter identities are observed by omp. */
export interface ShellVizWatch {
	name: string;
	value: string;
	fullLength?: number;
	scope?: string;
	scopeId?: string;
	node?: string;
	range?: [number, number];
	setterSeq?: number;
}
export interface ShellVizPresentation {
	preferences: ShellVizPreferences;
	rows: ShellVizRow[];
	original: ShellVizRow[];
	output: string;
	running?: boolean;
	executing: boolean;
	watches: ShellVizWatch[];
	timeline: { length: number; cursor: number; elapsedNs: number; durationNs: number; trimmed?: boolean };
	message?: string;
}
export interface TspShellProps {
	presentation: ShellVizPresentation;
	inspector?: boolean;
	replayEpoch?: number;
	liveOrigin?: boolean;
	cwd?: string;
	lang?: "bash" | "zsh";
	preview?: { lines: number };
}

const RESPONSE_BYTES = 2 * 1024 * 1024;
const VALUE_BYTES = 16 * 1024;
const ROW_BYTES = 64 * 1024;
const MAX_SEGMENTS = 50_000;
const layers = ["color", "inline", "idioms", "effects", "unwrap"] as const;
const speeds = [0.5, 1, 2, 4];
const states = ["pending", "running", "ok", "fail", "skipped"];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const optional = (value: unknown, valid: (value: unknown) => boolean): boolean => value === undefined || valid(value);
const boolean = (value: unknown): boolean => typeof value === "boolean";

/** Count without allocating a second copy of an untrusted string. */
function stringBytes(value: string, limit: number, json = false): number {
	let bytes = json ? 2 : 0;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (json && (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13)) bytes += 2;
		else if (json && code < 32) bytes += 6;
		else if (code < 128) bytes++;
		else if (code < 2048) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
		else bytes += json && code >= 0xd800 && code <= 0xdfff ? 6 : 3;
		if (bytes > limit) return bytes;
	}
	return bytes;
}
const text = (value: unknown, max = VALUE_BYTES): value is string => typeof value === "string" && stringBytes(value, max) <= max;
const identity = (value: unknown): value is string => text(value) && value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const range = (value: unknown): boolean => Array.isArray(value) && value.length === 2 && integer(value[0]) && integer(value[1]) && value[0] <= value[1];

/** Bound the entire JSON response, including future fields, before traversing semantic arrays. */
function boundedJson(value: unknown): boolean {
	let remaining = RESPONSE_BYTES;
	const visit = (part: unknown, depth: number): boolean => {
		if (depth > 32 || remaining < 0) return false;
		if (typeof part === "string") remaining -= stringBytes(part, remaining, true);
		else if (typeof part === "number") { if (!Number.isFinite(part)) return false; remaining -= String(part).length; }
		else if (typeof part === "boolean") remaining -= part ? 4 : 5;
		else if (part === null) remaining -= 4;
		else if (Array.isArray(part)) {
			remaining -= 2;
			for (let i = 0; i < part.length; i++) { if (i) remaining--; if (!visit(part[i], depth + 1)) return false; }
		} else if (object(part)) {
			remaining -= 2;
			let count = 0;
			for (const key in part) {
				if (!Object.hasOwn(part, key) || part[key] === undefined) continue;
				remaining -= stringBytes(key, remaining, true) + 1 + (count++ ? 1 : 0);
				if (!visit(part[key], depth + 1)) return false;
			}
		} else return false;
		return remaining >= 0;
	};
	return visit(value, 0);
}

// Wire presentations are immutable: set ops replace their object, and host snapshots replace each revision.
const presentations = new WeakMap<object, ShellVizPresentation | null>();
function validatePresentation(value: unknown): ShellVizPresentation | null {
	if (!object(value) || !boundedJson(value)) return null;
	const timeline = value.timeline;
	if (!object(timeline) || !integer(timeline.length) || !integer(timeline.cursor) || timeline.cursor > timeline.length
		|| !finite(timeline.elapsedNs) || !finite(timeline.durationNs) || timeline.elapsedNs > timeline.durationNs || !optional(timeline.trimmed, boolean)) return null;
	const length = timeline.length;
	const preferences = value.preferences;
	if (!object(preferences) || (preferences.view !== "raw" && preferences.view !== "pseudo") || !object(preferences.layers)) return null;
	const layerValues = preferences.layers;
	if (!layers.every(layer => boolean(layerValues[layer]))
		|| !boolean(preferences.split) || !boolean(preferences.playing) || typeof preferences.speed !== "number" || !speeds.includes(preferences.speed)
		|| !optional(preferences.cursor, cursor => integer(cursor) && cursor <= length)
		|| !optional(preferences.selectedNode, identity) || !Array.isArray(preferences.expandedNodes)
		|| !preferences.expandedNodes.every(identity) || new Set(preferences.expandedNodes).size !== preferences.expandedNodes.length) return null;
	if (!text(value.output, RESPONSE_BYTES) || !boolean(value.executing) || !optional(value.running, boolean) || !optional(value.message, text)) return null;
	const watch = (item: unknown): boolean => object(item) && text(item.name) && text(item.value)
		&& optional(item.fullLength, integer) && optional(item.scope, text) && optional(item.scopeId, identity)
		&& optional(item.node, identity) && optional(item.range, range) && optional(item.setterSeq, integer);
	const execution = (item: Record<string, unknown>): boolean => optional(item.active, boolean)
		&& optional(item.state, state => typeof state === "string" && states.includes(state))
		&& optional(item.executedAtNs, finite) && optional(item.executionSeq, integer)
		&& optional(item.node, identity) && optional(item.range, range);
	let segments = 0;
	const rows = (items: unknown): boolean => {
		if (!Array.isArray(items)) return false;
		const ids = new Set<string>();
		for (const row of items) {
			if (!object(row) || !identity(row.id) || ids.has(row.id) || !integer(row.depth) || !execution(row)
				|| !optional(row.role, role => typeof role === "string" && ["stmt", "head", "mid", "tail", "raw", "document"].includes(role))
				|| !optional(row.meta, text) || !optional(row.detail, text)
				|| !optional(row.annotations, annotations => Array.isArray(annotations) && annotations.every(watch))
				|| !Array.isArray(row.segments) || row.segments.length > 1024 || !Array.isArray(row.effects)) return false;
			ids.add(row.id);
			segments += row.segments.length;
			if (segments > MAX_SEGMENTS) return false;
			let bytes = 0;
			for (const segment of row.segments) {
				if (!object(segment) || !text(segment.text, ROW_BYTES) || !execution(segment)
					|| !optional(segment.executionNode, identity) || !optional(segment.style, text) || !optional(segment.tip, text)
					|| !optional(segment.expanded, text) || !optional(segment.language, text)) return false;
				bytes += stringBytes(segment.text, ROW_BYTES);
				if (bytes > ROW_BYTES) return false;
			}
			for (const effect of row.effects) if (!object(effect) || typeof effect.kind !== "string" || !["network", "write", "destructive", "secret", "privilege", "background"].includes(effect.kind)
				|| !text(effect.glyph) || !text(effect.label) || !text(effect.why)) return false;
		}
		return true;
	};
	return rows(value.rows) && rows(value.original) && Array.isArray(value.watches) && value.watches.every(watch) ? value as unknown as ShellVizPresentation : null;
}

/** Refuse malformed or oversized data before consumers allocate rows or inspect details. */
export function shellPresentation(value: unknown): ShellVizPresentation | null {
	if (!object(value)) return null;
	if (presentations.has(value)) return presentations.get(value)!;
	const result = validatePresentation(value);
	presentations.set(value, result);
	return result;
}
const propsCache = new WeakMap<object, TspShellProps | null>();
export function shellProps(value: unknown): TspShellProps | null {
	if (!object(value)) return null;
	if (propsCache.has(value)) return propsCache.get(value)!;
	const valid = boundedJson(value) && optional(value.inspector, boolean) && optional(value.liveOrigin, boolean)
		&& optional(value.replayEpoch, integer) && optional(value.cwd, text)
		&& optional(value.lang, lang => lang === "bash" || lang === "zsh")
		&& optional(value.preview, preview => object(preview) && integer(preview.lines) && preview.lines > 0)
		&& shellPresentation(value.presentation) !== null;
	const result = valid ? value as unknown as TspShellProps : null;
	propsCache.set(value, result);
	return result;
}

export type ShellProjection = {
	hostId: string;
	generation: number;
	epoch: number;
	surfaceId: string;
	nodeId: string;
	toolCallId: string;
	props: TspShellProps;
};
const bashAncestor = (node: TspNode): boolean => (node.k === "tool" || node.k === "card") && node.p?.role === "omp.tool.bash" && identity(node.p.key);
const indexes = new WeakMap<TspHostSnapshot, ReadonlyMap<string, ShellProjection | null>>();
function shellIndex(snapshot: TspHostSnapshot): ReadonlyMap<string, ShellProjection | null> {
	const cached = indexes.get(snapshot);
	if (cached) return cached;
	const index = new Map<string, ShellProjection | null>();
	for (const surface of snapshot.surfaces) {
		if (surface.closed || surface.suspended || surface.documentGeneration !== snapshot.generation || !identity(surface.open.id) || !integer(surface.sequence)) continue;
		const visit = (node: TspNode, owner?: string): void => {
			if (node.p?.hidden) return;
			if (bashAncestor(node)) owner = node.p!.key;
			if (node.k === "shell" && owner && node.p?.inspector !== true) {
				const props = shellProps(node.p);
				// A second matching child invalidates ownership even when its presentation is malformed.
				if (index.has(owner) || !props || !identity(node.id)) index.set(owner, null);
				else index.set(owner, { hostId: snapshot.hostId, generation: snapshot.generation, epoch: snapshot.epoch,
					surfaceId: surface.open.id, nodeId: node.id, toolCallId: owner, props });
			}
			for (const child of node.c ?? []) visit(child, owner);
		};
		visit(surface.document);
	}
	indexes.set(snapshot, index);
	return index;
}
/** The caller also pins its session/controller and expected epoch before using this projection. */
export function projectShell(snapshot: TspHostSnapshot | null | undefined, hostId: string, generation: number, toolCallId: string): ShellProjection | null {
	if (!snapshot || snapshot.hostId !== hostId || snapshot.generation !== generation || snapshot.documentGeneration !== generation
		|| snapshot.lifecycle !== "live" || snapshot.closing || !snapshot.negotiated || !integer(snapshot.epoch) || snapshot.epoch === 0
		|| !identity(hostId) || !integer(generation) || !identity(toolCallId)) return null;
	return shellIndex(snapshot).get(toolCallId) ?? null;
}

function knownNode(presentation: ShellVizPresentation, id: string): boolean {
	for (const rows of [presentation.rows, presentation.original]) for (const row of rows) {
		if (row.node === id || row.segments.some(segment => segment.node === id || segment.executionNode === id)
			|| row.annotations?.some(watch => watch.node === id)) return true;
	}
	return presentation.watches.some(watch => watch.node === id);
}
const actions: ReadonlySet<string> = new Set(["view:raw", "view:pseudo", "split", "inspect", "play", "pause", "step", "reset", "live",
	...layers.map(layer => `layer:${layer}`), ...speeds.map(speed => `speed:${speed}`)]);
export function isShellAction(presentation: ShellVizPresentation, value: unknown): value is string {
	if (typeof value !== "string" || !text(value)) return false;
	if (actions.has(value)) return true;
	if (/^seek:(0|[1-9][0-9]*)$/.test(value)) { const cursor = Number(value.slice(5)); return integer(cursor) && cursor <= presentation.timeline.length; }
	if (value.startsWith("select:") || value.startsWith("expand:")) return knownNode(presentation, value.slice(7));
	return false;
}
function shellEventValue(event: TspRendererEvent, props: TspShellProps): string | null | undefined {
	if (event.ev === "action") return event.act === "shell-viz" ? event.value : undefined;
	if (event.ev === "select") return event.item.startsWith("select:") ? event.item : `select:${event.item}`;
	if (event.ev !== "change") return undefined;
	const { item, value } = event;
	if ((item === "select" || item === "expand") && typeof value === "string") return `${item}:${value}`;
	if (typeof value === "string" && (value.includes(":") || item === "shell-viz")) return value;
	if (item === "split" && typeof value === "boolean") return value === props.presentation.preferences.split ? null : "split";
	const layer = layers.find(layer => item === layer || item === `layer:${layer}`);
	if (layer && typeof value === "boolean") return value === props.presentation.preferences.layers[layer] ? null : `layer:${layer}`;
	if (item.startsWith("view:") && value === true) return item;
	if (item === "cursor" || item === "seek") return `seek:${String(value)}`;
	return `${item}:${String(value)}`;
}
/** Apply at dispatch time, including the generic change/select routes accepted by omp. */
export function assertShellEvent(surface: TspSurfaceSnapshot, event: TspRendererEvent): void {
	if (!("id" in event)) return;
	const path: TspNode[] = [];
	const find = (node: TspNode): boolean => {
		path.push(node);
		if (node.id === event.id) return true;
		for (const child of node.c ?? []) if (find(child)) return true;
		path.pop();
		return false;
	};
	const targetPath = find(surface.document) ? path : null;
	const node = targetPath?.at(-1);
	const shellAction = event.ev === "action" && event.act === "shell-viz";
	if (!shellAction && !(node?.k === "shell" && (event.ev === "change" || event.ev === "select"))) return;
	const props = node?.k === "shell" ? shellProps(node.p) : null;
	const inline = targetPath?.some(bashAncestor);
	const inspector = props?.inspector === true && (surface.open.mode === "screen" || targetPath?.[1]?.id === "layer");
	if (surface.closed || surface.suspended || !props || !targetPath || targetPath.some(parent => parent.p?.hidden)
		|| (!inline && !inspector)) throw new Error("omp screen: The shell visualization is no longer available.");
	const value = shellEventValue(event, props);
	if (value !== null && !isShellAction(props.presentation, value)) throw new Error("omp screen: The shell visualization action is not available.");
}
