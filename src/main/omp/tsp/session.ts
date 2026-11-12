import { z } from "zod";
import { TSP_DEFAULT_APC_LIMIT, TSP_DEFAULT_CREDITS, TSP_KINDS, TSP_VERSION, type TspEvent, type TspFrame, type TspNode, type TspOpen } from "../../../shared/tsp";
import type { TspAvailability, TspSurfaceSnapshot } from "../../../shared/tsp-host";
import { TspRendererEvent } from "../../../shared/tsp-host.schema";
import { liveSurfaces, openOverlay, screenSurface, walkNodes } from "../../../shared/tsp/view-state";
import { isAskFormAction, isHookNode, isKnownAction, TSP_ACTIONS, TSP_ROLES } from "../../../shared/tsp/roles";
import { hookAnswerEvents } from "../../../shared/tsp/dialogs";
import { TspHookAnswer } from "../../../shared/tsp/dialogs.schema";
import { planReview } from "../../../shared/tsp/plan-review";
import { advisorActionEvents, advisorOverlay } from "../../../shared/tsp/advisor";
import { TspAdvisorAction } from "../../../shared/tsp/advisor.schema";
import { commandNodeText } from "../../../shared/tsp/command-result";
import { TspDocument } from "./apply";
import { encodeTspJson } from "./encode";
import type { TspMessage } from "./stream";
import { composerFacts } from "./composer";
import { assertBtwEvent, BTW_SEND_BLOCKED_REASON, projectBtw } from "../../../shared/tsp/btw";
import { assertShellEvent, shellProps } from "../../../shared/tsp/shell";

const Query = z.object({ q: z.string(), v: z.array(z.number()).optional(), features: z.array(z.string()).optional() });
const Open = z.object({ id: z.string().min(1), mode: z.enum(["inline", "screen"]), title: z.string().optional(), role: z.string().optional(), adopt: z.boolean().optional() });
interface WireNode { id: string; k: string; p?: Record<string, unknown>; c?: WireNode[] }
const Node: z.ZodType<WireNode> = z.lazy(() => z.object({
	id: z.string(), k: z.string(), p: z.record(z.string(), z.unknown()).optional(), c: z.array(Node).optional(),
}));
const Id = z.string();
const Before = z.string().nullable();
const SafeOp = z.union([
	z.tuple([z.literal("add"), Id, Id, Before, Node]),
	z.tuple([z.literal("set"), Id, z.record(z.string(), z.unknown())]),
	z.tuple([z.literal("text"), Id, z.string(), z.string()]),
	z.tuple([z.literal("splice"), Id, z.number().finite(), z.number().finite(), z.string()]),
	z.tuple([z.literal("move"), Id, Id, Before]),
	z.tuple([z.literal("del"), Id]),
	z.tuple([z.literal("settle"), Id]),
	z.tuple([z.literal("focus"), z.string().nullable()]),
	z.tuple([z.literal("reveal"), Id, z.string()]),
	z.tuple([z.literal("scroll"), Id, z.string()]),
	z.tuple([z.literal("suspend")]),
	z.tuple([z.literal("resume")]),
]);
const Frame = z.object({ sf: z.string().min(1), s: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), ops: z.array(SafeOp) });
const Close = z.object({ id: z.string().min(1), keep: z.boolean() });

interface Surface {
	open: TspOpen;
	doc: TspDocument;
	sequence: number;
	nodeVersions: Map<string, number>;
	closed: boolean;
}

export interface TspEditorTarget {
	surfaceId: string;
	editorId: string;
	epoch: number;
	assertCurrent(): void;
	ended(): boolean;
}

/** A rich ask replaces the dock editor. It never grants input to another focused or dock-owned UI. */
function askEditorOwnsDock(surfaces: readonly TspSurfaceSnapshot[]): boolean {
	const live = liveSurfaces(surfaces);
	const main = live.filter(surface => surface.open.mode === "inline" && surface.open.role === TSP_ROLES.session);
	if (live.length !== 1 || main.length !== 1) return false;
	const surface = main[0]!;
	const dock = surface.document.c?.find(node => node.id === "dock");
	if (!dock) return false;
	const dockNodes = [...walkNodes(dock)];
	const asks = dockNodes.filter(node => node.p?.role === TSP_ROLES.editorAsk || node.p?.role === TSP_ROLES.editorAskHidden);
	if (asks.length !== 1) return false;
	const subtree = [...walkNodes(asks[0]!)];
	if (subtree.some(node => node.k === "editor" && node.p?.mode === "PTY")) return false;
	const askNodes = new Set(subtree.map(node => node.id));
	if (live.some(candidate => candidate.focus !== null && (candidate !== surface || !askNodes.has(candidate.focus)))) return false;
	if (live.some(candidate => [...walkNodes(candidate.document)].some(node => node.p?.role === TSP_ROLES.composerFocus))) return false;
	return !dockNodes.some(node => !askNodes.has(node.id) && (
		node.p?.role?.startsWith(TSP_ROLES.editor) || node.k === "editor" || node.k === "input" || node.k === "picker" || node.k === "list" || node.k === "tree"
	));
}

export type TspUpdate = "hello" | "open" | "frame" | "close";

/** A document or protocol transition refused input before any application bytes were written. */
export class TspInputStateError extends Error {}

/** Image input failed after staging; the message carries the recovery contract across IPC. */
export class TspImageSubmissionError extends TspInputStateError {
	constructor(readonly recovery: "restored" | "required", reason: string) {
		super(`omp screen: Image submission ${recovery === "restored" ? "was restored." : "needs recovery."} ${reason}`);
	}
}

/**
 * omp owns document content and submission semantics. The app applies its semantic documents
 * and validates renderer interaction at the serialized writer. Hook answers require a separate
 * host-owned arbitration transaction. No blobs or aside layout are advertised.
 * Each applied surface frame returns a cumulative ack, coalesced while the writer is occupied.
 */
export class TspSession {
	readonly #write: (data: string) => Promise<void> | void;
	readonly #onUpdate: (reason: TspUpdate, surface?: string) => void;
	readonly #onError: (error: Error) => void;
	#surfaces = new Map<string, Surface>();
	#pendingAcks = new Map<string, number>();
	#tail: Promise<void> = Promise.resolve();
	#negotiated = false;
	#epoch = 0;
	#refreshingInline: string | null = null;
	#programFeatures = new Set<string>();
	#cols: number;
	#dark: boolean;
	#reduceMotion: boolean;
	readonly #publishedNodes = new WeakMap<TspNode, TspNode>();
	readonly #waiters = new Set<() => void>();

	constructor(options: {
		write: (data: string) => Promise<void> | void;
		onUpdate?: (reason: TspUpdate, surface?: string) => void;
		onError?: (error: Error) => void;
		cols: number;
		dark: boolean;
		reduceMotion: boolean;
	}) {
		this.#write = options.write;
		this.#onUpdate = options.onUpdate ?? (() => {});
		this.#onError = options.onError ?? (() => {});
		this.#cols = options.cols;
		this.#dark = options.dark;
		this.#reduceMotion = options.reduceMotion;
	}

	/** Drain the serialized protocol writer, including cumulative acknowledgments. */
	drain(): Promise<void> {
		return this.#tail;
	}

	/** Pins the actual editor lifetime, including ids reused within the same surface and epoch. */
	pinEditor(surfaceAllowed: (surface: string) => boolean = () => true): TspEditorTarget {
		const facts = composerFacts(this.snapshot().surfaces.filter(surface => surfaceAllowed(surface.open.id)));
		const surface = this.#surfaces.get(facts.surfaceId!);
		if (!surface || !facts.editorId) throw new TspInputStateError("omp screen: The main editor is not available.");
		const editorId = facts.editorId;
		const epoch = this.#epoch;
		const version = surface.nodeVersions.get(editorId);
		const ended = () => epoch !== this.#epoch || this.#surfaces.get(surface.open.id) !== surface || surface.closed
			|| surface.nodeVersions.get(editorId) !== version || surface.doc.get(editorId)?.k !== "editor";
		return { surfaceId: surface.open.id, editorId, epoch, ended, assertCurrent: () => {
			if (ended()) throw new TspInputStateError("omp screen: The original editor changed.");
			if (surface.doc.suspended || !surfaceAllowed(surface.open.id)) throw new TspInputStateError("omp screen: The original editor is temporarily unavailable.");
			const current = composerFacts(this.snapshot().surfaces.filter(surface => surfaceAllowed(surface.open.id)));
			if (current.surfaceId !== surface.open.id || current.editorId !== editorId) throw new TspInputStateError("omp screen: The original editor changed.");
		} };
	}

	#registerInputNodes(surface: Surface, node: WireNode): void {
		if (node.k === "editor" || node.k === "shell") surface.nodeVersions.set(node.id, (surface.nodeVersions.get(node.id) ?? 0) + 1);
		for (const child of node.c ?? []) this.#registerInputNodes(surface, child);
	}

	imageCount(surfaceId: string): number {
		const surface = this.#surfaces.get(surfaceId);
		if (!surface || surface.closed) return 0;
		const chips = [...walkNodes(surface.doc.snapshot())].find(node => node.p?.role === TSP_ROLES.composerChips);
		return chips ? [...walkNodes(chips)].filter(node => node.k === "image").length : 0;
	}

	/** Native edits bypass omp's async paste queue. Keep the host lock until the paste is reflected. */
	async paste(text: string, assertCurrent: () => void, surfaceAllowed: (surface: string) => boolean): Promise<void> {
		const target = this.pinEditor(surfaceAllowed);
		const before = composerFacts(this.snapshot().surfaces);
		const images = this.imageCount(target.surfaceId);
		const tokens = text.match(/(?:\\.|[^\s])+/g) ?? [];
		const imagePaths = tokens.length > 0 && tokens.every(token => /\.(?:png|jpe?g|gif|webp)$/i.test(token));
		const check = () => { assertCurrent(); target.assertCurrent(); };
		await this.#enqueue(() => {
			check();
			if (!this.availability(surfaceAllowed).available) throw new TspInputStateError("omp screen: The main editor is not ready for a paste.");
			return this.#write(`\x1b[200~${text}\x1b[201~`);
		});
		await this.waitFor(() => imagePaths ? this.imageCount(target.surfaceId) >= images + tokens.length
			: composerFacts(this.snapshot().surfaces).text !== before.text || this.imageCount(target.surfaceId) > images,
		check, 8000, "omp screen: omp did not finish the paste. Check its editor before sending again.");
	}

	/** Document waits never occupy the protocol writer, so credits keep flowing. */
	waitFor(predicate: () => boolean, assertCurrent: () => void, timeoutMs: number, reason: string): Promise<void> {
		const result = Promise.withResolvers<void>();
		const finish = (error?: unknown) => {
			clearTimeout(timer);
			this.#waiters.delete(check);
			if (error) result.reject(error); else result.resolve();
		};
		const check = () => {
			try { assertCurrent(); if (predicate()) finish(); }
			catch (error) { finish(error); }
		};
		const timer = setTimeout(() => finish(new TspInputStateError(reason)), timeoutMs);
		this.#waiters.add(check);
		check();
		return result.promise;
	}

	#updated(reason: TspUpdate, surface?: string): void {
		this.#onUpdate(reason, surface);
		for (const check of this.#waiters) check();
	}

	/** Bound shell data before snapshots and their derived patches can cross renderer IPC. */
	#snapshotNode(node: TspNode): TspNode {
		const cached = this.#publishedNodes.get(node);
		if (cached) return cached;
		const children = node.c?.map(child => this.#snapshotNode(child));
		const changed = children?.some((child, index) => child !== node.c![index]);
		// An omitted presentation is an unavailable marker. Keep identity and hidden state for matching and recovery.
		const result: TspNode = node.k === "shell" && !shellProps(node.p)
			? { id: node.id, k: "shell", ...(node.p?.hidden ? { p: { hidden: true } } : {}), ...(children ? { c: children } : {}) } as TspNode
			: changed ? { ...node, c: children } as TspNode : node;
		this.#publishedNodes.set(node, result);
		return result;
	}

	snapshot(): { negotiated: boolean; epoch: number; surfaces: TspSurfaceSnapshot[] } {
		return {
			negotiated: this.#negotiated,
			epoch: this.#epoch,
			surfaces: [...this.#surfaces.values()].map(surface => ({
				open: { ...surface.open }, sequence: surface.sequence, closed: surface.closed,
				document: this.#snapshotNode(surface.doc.snapshot()), focus: surface.doc.focus,
				suspended: surface.doc.suspended, settled: [...surface.doc.settled],
			})),
		};
	}

	receive(message: TspMessage): void {
		// Unknown verbs (including blobs, which we do not advertise) are deliberately ignored.
		if (!["q", "o", "f", "x"].includes(message.verb)) return;
		let body: unknown;
		try { body = JSON.parse(message.body); }
		catch { this.#report("Invalid TSP JSON"); return; }
		switch (message.verb) {
			case "q": {
				const query = Query.safeParse(body);
				if (!query.success) { this.#report("Invalid TSP query"); return; }
				if (query.data.q !== "hello" || !query.data.v?.includes(TSP_VERSION)) return;
				// A replacement process may reuse this transport and every surface id.
				this.#epoch++;
				this.#surfaces.clear();
				this.#pendingAcks.clear();
				this.#refreshingInline = null;
				this.#programFeatures = new Set(query.data.features);
				// First reply precedes every event, including acks for optimistic native frames.
				this.#internal(this.#enqueue(() => this.#write(encodeTspJson("r", {
					r: "hello", v: TSP_VERSION, term: "visual-omp", kinds: TSP_KINDS, features: [],
					apc: TSP_DEFAULT_APC_LIMIT, credits: TSP_DEFAULT_CREDITS, cols: this.#cols,
					dark: this.#dark, reduceMotion: this.#reduceMotion,
				}))));
				this.#negotiated = true;
				this.#updated("hello");
				return;
			}
			case "o": {
				const open = Open.safeParse(body);
				if (!open.success) { this.#report("Invalid TSP surface"); return; }
				if (open.data.mode === "inline" && !open.data.adopt) this.#refreshingInline = null;
				const previous = this.#surfaces.get(open.data.id);
				if (open.data.adopt && !previous) {
					this.#internal(this.#enqueue(() => this.#write(encodeTspJson("e", { ev: "gone", ids: [open.data.id] }))));
					return;
				}
				if (open.data.adopt && previous) {
					previous.open = open.data;
					previous.closed = false;
				} else {
					this.#surfaces.set(open.data.id, { open: open.data, doc: new TspDocument(open.data.id), sequence: 0, closed: false, nodeVersions: new Map() });
				}
				this.#updated("open", open.data.id);
				return;
			}
			case "f": {
				const frame = Frame.safeParse(body);
				if (!frame.success) { this.#report("Invalid TSP frame"); return; }
				// Frames already in the PTY before `gone` belong to the evicted inline document.
				if (frame.data.sf === this.#refreshingInline) return;
				const surface = this.#surfaces.get(frame.data.sf);
				if (!surface || surface.closed) { this.#report("Frame for an unavailable TSP surface", frame.data.sf, frame.data.s); return; }
				if (frame.data.s > surface.sequence) {
					const errors = surface.doc.applyFrame(frame.data as TspFrame);
					for (const [index, op] of frame.data.ops.entries()) if (op[0] === "add" && !errors.some(error => error.op === index)) this.#registerInputNodes(surface, op[4]);
					surface.sequence = frame.data.s;
					for (const error of errors) this.#report(error.msg, frame.data.sf, error.s, error.op);
					this.#updated("frame", frame.data.sf);
				}
				this.#ack(frame.data.sf);
				return;
			}
			case "x": {
				const close = Close.safeParse(body);
				if (!close.success) { this.#report("Invalid TSP close"); return; }
				const surface = this.#surfaces.get(close.data.id);
				if (!surface) return;
				if (close.data.keep) { surface.doc.close(); surface.closed = true; }
				else this.#surfaces.delete(close.data.id);
				this.#updated("close", close.data.id);
			}
		}
	}

	/** Called under the host's application input lock for renderer-originated events. */
	send(input: unknown, assertCurrent?: () => void): Promise<void> {
		if (!this.#negotiated) return Promise.reject(new Error("omp screen: The protocol has not negotiated yet."));
		const parsed = TspRendererEvent.safeParse(input);
		if (!parsed.success) return Promise.reject(new Error("omp screen: Invalid renderer event."));
		const event = parsed.data;
		const epoch = this.#epoch;
		const initialSurface = this.#surfaces.get(event.sf);
		const shellTarget = "id" in event && initialSurface?.doc.get(event.id)?.k === "shell"
			? { surface: initialSurface, version: initialSurface.nodeVersions.get(event.id) } : null;
		return this.#enqueue(async () => {
			assertCurrent?.();
			if (epoch !== this.#epoch) throw new TspInputStateError("omp screen: The semantic screen restarted.");
			if (event.ev === "action" && !isKnownAction(event.act)) throw new TspInputStateError(`omp screen: The omp action ${event.act} is not supported by visual-omp.`);
			assertBtwEvent(this.snapshot().surfaces, event);
			if (["send", "edit", "undo"].includes(event.ev) && !this.#programFeatures.has(event.ev)) throw new Error(`omp screen: omp does not accept ${event.ev} events.`);
			if (event.ev !== "visible" && this.hasHookDialog()) throw new TspInputStateError("omp screen: This question requires the guarded question answer controls.");
			const surface = this.#surfaces.get(event.sf);
			if (!surface || surface.closed || surface.doc.suspended) throw new TspInputStateError("omp screen: The target surface is no longer available.");
			if ("id" in event) {
				const node = surface.doc.get(event.id);
				if (!node) throw new TspInputStateError("omp screen: The target node is no longer available.");
				if (shellTarget || node.k === "shell" || event.ev === "action" && event.act === TSP_ACTIONS.shellViz) {
					assertShellEvent({ open: surface.open, sequence: surface.sequence, closed: surface.closed,
						document: surface.doc.snapshot(), focus: surface.doc.focus, suspended: surface.doc.suspended, settled: [] }, event);
					if (!shellTarget || shellTarget.surface !== surface || surface.nodeVersions.get(event.id) !== shellTarget.version || node.k !== "shell") {
						throw new TspInputStateError("omp screen: The original shell visualization changed.");
					}
				}
				if (event.ev === "action" && (event.act === TSP_ACTIONS.model || event.act === TSP_ACTIONS.thinkingCycle)
					&& node.p?.actions?.click !== event.act) throw new TspInputStateError("omp screen: The target no longer offers this model or thinking action.");
				if (event.ev === "action" && isAskFormAction(event.act)) {
					const form = [...walkNodes(surface.doc.snapshot())].find(root => (root.p?.role === TSP_ROLES.editorAsk || root.p?.role === TSP_ROLES.editorAskHidden) && [...walkNodes(root)].some(child => child.id === node.id));
					if (!form || Array.isArray(node.p?.actions) || node.p?.actions?.click !== event.act || node.k === "button" && (node.p?.disabled === true || typeof node.p?.disabled === "string" || node.p?.busy)) throw new TspInputStateError("omp screen: The form no longer offers this action.");
				}
				if ((event.ev === "select" || event.ev === "activate") && node.k === "tabs" && node.p?.role === TSP_ROLES.askQuestions
					&& !node.p.items.some(item => item.id === event.item)) throw new TspInputStateError("omp screen: The form question tab is no longer available.");
				if (event.ev === "activate" && node.k === "picker") {
					const item = node.p?.items?.find(item => item.id === event.item);
					if (!item || item.disabled) throw new TspInputStateError("omp screen: The picker item is no longer available.");
				}
				if (event.ev === "send" && ((node.k !== "editor" && node.k !== "input") || node.p?.sendable !== true)) throw new TspInputStateError("omp screen: The editor is not ready to send.");
				if (event.ev === "send") {
					const surfaces = this.snapshot().surfaces;
					if (screenSurface(surfaces)) throw new TspInputStateError("omp screen: Close the omp screen before sending a message.");
					if (projectBtw(surfaces)) throw new TspInputStateError(`omp screen: ${BTW_SEND_BLOCKED_REASON}`);
					if (composerFacts(surfaces).blockedBy === "panel") throw new TspInputStateError("omp screen: Close the open omp menu before sending a message.");
				}
				if (event.ev === "edit") {
					if ((node.k !== "editor" && node.k !== "input") || node.p?.readonly === true || event.len !== (node.p?.text?.length ?? 0)) throw new Error("omp screen: The editor changed before the edit could be applied.");
				}
			}
			await this.#write(encodeTspJson("e", event));
		});
	}
	/** Save and close share one write; scope and declarations are checked on the current document. */
	advisorAction(input: unknown, assertCurrent: () => void): Promise<void> {
		const parsed = TspAdvisorAction.safeParse(input);
		if (!parsed.success) return Promise.reject(new TspInputStateError("omp screen: Invalid advisor action."));
		const action = parsed.data;
		const epoch = this.#epoch;
		return this.#enqueue(() => {
			assertCurrent();
			if (!this.#negotiated || epoch !== this.#epoch) throw new TspInputStateError("omp screen: The semantic screen restarted.");
			if (this.hasHookDialog()) throw new TspInputStateError("omp screen: Answer the question before applying advisor configuration.");
			const surfaces = this.snapshot().surfaces;
			if (liveSurfaces(surfaces).some(surface => [...walkNodes(surface.document)].some(node => node.p?.role === TSP_ROLES.approvalChoices))) throw new TspInputStateError("Answer the approval before applying advisor configuration.");
			const target = advisorOverlay(surfaces);
			if (!target || target.surface.open.id !== action.sf || target.node.id !== action.id) throw new TspInputStateError("The advisor configuration is no longer available.");
			const events = advisorActionEvents(target, action);
			return this.#write(events.map(event => encodeTspJson("e", event)).join(""));
		});
	}

	/** A complete local hook answer is one writer operation, with no yield between edit and submit. */
	answerHook(input: unknown, assertCurrent: (surfaceId: string, nodeId: string) => void): Promise<void> {
		const parsed = TspHookAnswer.safeParse(input);
		if (!parsed.success) return Promise.reject(new TspInputStateError("omp screen: Invalid question answer."));
		const answer = parsed.data;
		const epoch = this.#epoch;
		return this.#enqueue(() => {
			if (!this.#negotiated || epoch !== this.#epoch) throw new TspInputStateError("omp screen: The semantic screen restarted.");
			const surface = this.#surfaces.get(answer.sf);
			if (!surface || surface.closed || surface.doc.suspended) throw new TspInputStateError("omp screen: The target surface is no longer available.");
			const node = surface.doc.get(answer.id);
			if (!node) throw new TspInputStateError("omp screen: The question node is no longer available.");
			const events = hookAnswerEvents(node, answer);
			if (events.some(event => event.ev === "edit") && !this.#programFeatures.has("edit")) throw new TspInputStateError("omp screen: omp does not accept edit events.");
			assertCurrent(answer.sf, answer.id);
			return this.#write(events.length ? events.map(event => encodeTspJson("e", event)).join("") : "\x1b");
		});
	}
	/** Restart uses declared dismissal only; autocomplete without one requires a saved-session relaunch. */
	async prepareRestart(assertCurrent: () => void, surfaceAllowed: (surface: string) => boolean = () => true): Promise<boolean> {
		assertCurrent();
		if (this.availability(surfaceAllowed).available) return true;
		const surfaces = this.snapshot().surfaces.filter(surface => surfaceAllowed(surface.open.id));
		if (this.hasHookDialog() || composerFacts(surfaces).blockedBy === "approval") return false;
		const screen = screenSurface(surfaces);
		const target = screen ? { surface: screen, node: screen.document } : openOverlay(surfaces, true);
		if (!target) return false;
		const controls = [...walkNodes(target.node)];
		let dismissal: { id: string; act: "close" | "cancel" } | undefined;
		for (const act of [TSP_ACTIONS.close, TSP_ACTIONS.cancel] as const) {
			for (const node of controls) {
				if (node.k === "button" && !node.p?.disabled && node.p?.actions?.click === act
					|| Array.isArray(node.p?.actions) && node.p.actions.some(action => action.id === act && !action.disabled)) {
					dismissal = { id: node.id, act };
					break;
				}
			}
			if (dismissal) break;
		}
		if (!dismissal) return false;
		const event = { ev: "action", sf: target.surface.open.id, ...dismissal } as const;
		const epoch = this.#epoch;
		await this.send(event, () => {
			assertCurrent();
			const current = this.#surfaces.get(event.sf);
			const node = current?.doc.get(event.id);
			if (epoch !== this.#epoch || !surfaceAllowed(event.sf) || current?.closed || !node
				|| !(node.k === "button" && !node.p?.disabled && node.p?.actions?.click === event.act
					|| Array.isArray(node.p?.actions) && node.p.actions.some(action => action.id === event.act && !action.disabled))) {
				throw new TspInputStateError("omp screen: The omp menu changed before it could close.");
			}
		});
		await this.waitFor(() => this.availability(surfaceAllowed).available, assertCurrent, 8000, "omp did not confirm that its menu closed.");
		return true;
	}
	/** Atomic text submission to omp's main composer, preserving its displaced-draft semantics. */
	submit(text: string, assertCurrent?: () => void, surfaceAllowed: (surface: string) => boolean = () => true): Promise<void> {
		if (!text.trim()) return Promise.reject(new Error("omp screen: Enter a message before sending."));
		const surfaces = this.snapshot().surfaces;
		const availability = this.availability(surfaceAllowed);
		if (!availability.available) return Promise.reject(new TspInputStateError(`omp screen: The main editor is not ready to send. ${availability.reason}`));
		const facts = composerFacts(surfaces.filter(surface => surfaceAllowed(surface.open.id)));
		const original = this.#surfaces.get(facts.surfaceId!);
		return this.send({ ev: "send", sf: facts.surfaceId!, id: facts.editorId!, text }, () => {
			assertCurrent?.();
			if (!surfaceAllowed(facts.surfaceId!) || this.#surfaces.get(facts.surfaceId!) !== original) throw new TspInputStateError("omp screen: The main editor changed before the message could be sent.");
			if (!this.availability(surfaceAllowed).available) throw new TspInputStateError("omp screen: The main editor is not ready to send.");
		});
	}

	/** Follow-up has no wire event. Edit and Ctrl+Q must be one atomic write. */
	followUp(text: string, assertCurrent: () => void, surfaceAllowed: (surface: string) => boolean = () => true): Promise<void> {
		const facts = composerFacts(this.snapshot().surfaces.filter(surface => surfaceAllowed(surface.open.id)));
		const value = facts.surfaceId && this.imageCount(facts.surfaceId) > 0 ? facts.text + text : text;
		return this.editAndKeys(0, facts.text.length, value, value.length, "\x11", assertCurrent, surfaceAllowed);
	}

	editAndKeys(from: number, to: number, text: string, cursor: number, keys: string, assertCurrent: () => void, surfaceAllowed: (surface: string) => boolean = () => true): Promise<void> {
		const epoch = this.#epoch;
		const facts = composerFacts(this.snapshot().surfaces.filter(surface => surfaceAllowed(surface.open.id)));
		const original = this.#surfaces.get(facts.surfaceId!);
		const target = this.pinEditor(surfaceAllowed);
		return this.#enqueue(() => {
			assertCurrent();
			target.assertCurrent();
			if (epoch !== this.#epoch) throw new TspInputStateError("omp screen: The semantic screen restarted.");
			const now = composerFacts(this.snapshot().surfaces.filter(surface => surfaceAllowed(surface.open.id)));
			if (!this.#programFeatures.has("edit")) throw new TspInputStateError("omp screen: omp does not accept edit events.");
			if (!this.availability(surfaceAllowed).available || !now.sendable) throw new TspInputStateError(`omp screen: ${this.availability(surfaceAllowed).reason}`);
			if (this.#surfaces.get(facts.surfaceId!) !== original || now.surfaceId !== facts.surfaceId || now.editorId !== facts.editorId || now.text !== facts.text) throw new TspInputStateError("omp screen: The editor changed before the edit could be applied.");
			const event = TspRendererEvent.parse({ ev: "edit", sf: facts.surfaceId, id: facts.editorId, from, to, text, cursor, len: facts.text.length });
			return this.#write(encodeTspJson("e", event) + keys);
		});
	}

	/** `send` omits staged images. Preserve them with the composer's submit action. */
	async submitImages(text: string, paths: string, assertCurrent: () => void, surfaceAllowed: (surface: string) => boolean = () => true, prepared?: (text: string) => void): Promise<void> {
		const facts = composerFacts(this.snapshot().surfaces.filter(surface => surfaceAllowed(surface.open.id)));
		const target = this.pinEditor(surfaceAllowed);
		const assertTarget = () => { assertCurrent(); target.assertCurrent(); };
		const originalImages = this.imageCount(target.surfaceId);
		const tokens = paths.match(/(?:\\.|[^\s])+/g) ?? [];
		const notices = () => [...walkNodes(this.#surfaces.get(target.surfaceId)!.doc.snapshot())]
			.filter(node => node.p?.role === TSP_ROLES.toastStatus || node.p?.role === TSP_ROLES.noticeError || node.p?.role === TSP_ROLES.noticeWarning)
			.map(node => ({ id: node.id, text: commandNodeText(node) }));
		let pasteFinished = false;
		let submitting = false;
		let stagedWrites = 0;
		try {
			// Await each path separately so rejection cannot leave a later paste callback pending.
			for (const [index, path] of tokens.entries()) {
				const priorNotices = new Map(notices().map(notice => [notice.id, notice.text]));
				const expected = (index === 0 ? 0 : this.imageCount(target.surfaceId)) + 1;
				const before = composerFacts(this.snapshot().surfaces.filter(surface => surfaceAllowed(surface.open.id)));
				const fallbackText = (index === 0 ? "" : before.text) + path.replace(/\\(.)/g, "$1");
				pasteFinished = false;
				await this.editAndKeys(index === 0 ? 0 : before.text.length, before.text.length, "", index === 0 ? 0 : before.text.length,
					`\x1b[200~${path}\x1b[201~`, assertTarget, surfaceAllowed);
				stagedWrites++;
				await this.waitFor(() => {
					const currentText = composerFacts(this.snapshot().surfaces.filter(surface => surfaceAllowed(surface.open.id))).text;
					const failure = notices().find(notice => (priorNotices.get(notice.id) !== notice.text
						|| fallbackText !== before.text && currentText === fallbackText)
						&& /^(?:Failed to read pasted image path|Pasted path is not a supported image|Image not found at |Image file too large:|Unsupported pasted image format:)/.test(notice.text));
					if (failure) { pasteFinished = true; throw new Error(failure.text); }
					if (this.imageCount(target.surfaceId) < expected) return false;
					pasteFinished = true;
					return true;
				}, assertTarget, 8000, "omp did not attach the image. Check its editor before sending again.");
			}
			const attached = composerFacts(this.snapshot().surfaces.filter(surface => surfaceAllowed(surface.open.id)));
			const submit = { ev: "action", sf: target.surfaceId, id: target.editorId, act: TSP_ACTIONS.submit } as const;
			prepared?.(attached.text + text);
			submitting = true;
			await this.editAndKeys(attached.text.length, attached.text.length, text, attached.text.length + text.length,
				encodeTspJson("e", submit), assertTarget, surfaceAllowed);
		} catch (error) {
			if (stagedWrites === 0 && error instanceof TspInputStateError) throw error;
			const reason = error instanceof Error ? error.message : String(error);
			if (pasteFinished && !submitting) {
				try {
					assertTarget();
					const failed = composerFacts(this.snapshot().surfaces.filter(surface => surfaceAllowed(surface.open.id)));
					// Public edit remains valid while the failed path's autocomplete owns a panel.
					await this.send({ ev: "edit", sf: target.surfaceId, id: target.editorId, from: 0, to: failed.text.length,
						text: facts.text, cursor: facts.cursor, len: failed.text.length }, () => {
						assertTarget();
						if (composerFacts(this.snapshot().surfaces).text !== failed.text) throw new TspInputStateError("The editor changed before the image input could be restored.");
					});
					await this.waitFor(() => {
						const restored = composerFacts(this.snapshot().surfaces.filter(surface => surfaceAllowed(surface.open.id)));
						return restored.text === facts.text && restored.cursor === facts.cursor && this.imageCount(target.surfaceId) === originalImages
							&& restored.blockedBy !== "panel";
					}, assertTarget, 8000, "omp did not confirm the restored editor.");
				} catch (recoveryError) {
					throw new TspImageSubmissionError("required", `${reason} ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
				}
				throw new TspImageSubmissionError("restored", reason);
			}
			throw new TspImageSubmissionError("required", reason);
		}
	}

	availability(surfaceAllowed: (surface: string) => boolean = () => true): TspAvailability {
		const surfaces = this.snapshot().surfaces;
		if (!this.#negotiated) return { available: false, reason: "Waiting for omp to start its semantic screen." };
		if (!this.#programFeatures.has("send")) return { available: false, reason: "omp does not accept send events." };
		const facts = composerFacts(surfaces.filter(surface => surfaceAllowed(surface.open.id)));
		if (screenSurface(surfaces)) return { available: false, reason: "Close the omp screen before sending a message." };
		if (facts.blockedBy === "approval" && facts.sendable) return { available: true, reason: null };
		if (facts.blockedBy === "panel" || openOverlay(surfaces, true)) {
			if (projectBtw(surfaces)) return { available: false, reason: BTW_SEND_BLOCKED_REASON, reasonCode: "btw" };
			if (this.hasHookDialog()) return { available: false, reason: "Answer omp's question before sending a message." };
			if (planReview(surfaces)) return { available: false, reason: "Choose how to continue with the plan before sending a message." };
			return { available: false, reason: "Close the open omp menu before sending a message." };
		}
		if (!this.hasHookDialog() && askEditorOwnsDock(surfaces.filter(surface => surfaceAllowed(surface.open.id)))) {
			return { available: false, reason: "Answer the question card before sending a message.", reasonCode: "ask-editor" };
		}
		if (!facts.editorId) return { available: false, reason: "Wait for omp to finish opening its main editor." };
		if (!facts.sendable) return { available: false, reason: "Wait for omp to enable its main editor." };
		return { available: true, reason: null };
	}

	hasHookDialog(): boolean {
		return liveSurfaces(this.snapshot().surfaces).some(surface => [...walkNodes(surface.document)].some(isHookNode));
	}

	/** Ordinary terminal reports share the protocol queue, so DA1 never overtakes hello. */
	terminalReply(data: string): void {
		this.#internal(this.#enqueue(() => this.#write(data)));
	}

	/** Evict the inline document so omp's `gone` handler recreates it from its current UI, not a cached frame. */
	refreshInlineSurface(isCurrent: () => boolean): void {
		const epoch = this.#epoch;
		this.#internal(this.#enqueue(async () => {
			if (!this.#negotiated || epoch !== this.#epoch || !isCurrent()) return;
			let inline: Surface | undefined;
			for (const surface of this.#surfaces.values()) {
				if (!surface.closed && surface.open.mode === "inline") { inline = surface; break; }
			}
			if (!inline) return;
			this.#refreshingInline = inline.open.id;
			this.#surfaces.delete(inline.open.id);
			this.#pendingAcks.delete(inline.open.id);
			this.#updated("close", inline.open.id);
			await this.#write(encodeTspJson("e", { ev: "gone", ids: [inline.open.id] }));
		}));
	}

	resize(cols: number): Promise<void> {
		if (this.#cols === cols) return Promise.resolve();
		this.#cols = cols;
		return this.#environment({ ev: "resize", cols });
	}

	theme(dark: boolean): Promise<void> {
		if (this.#dark === dark) return Promise.resolve();
		this.#dark = dark;
		return this.#environment({ ev: "theme", dark });
	}

	motion(reduce: boolean): Promise<void> {
		if (this.#reduceMotion === reduce) return Promise.resolve();
		this.#reduceMotion = reduce;
		return this.#environment({ ev: "motion", reduce });
	}

	#environment(event: TspEvent): Promise<void> {
		// During startup the latest values belong in hello, never in an earlier APC event.
		return this.#negotiated ? this.#enqueue(() => this.#write(encodeTspJson("e", event))) : Promise.resolve();
	}

	#ack(id: string): void {
		const surface = this.#surfaces.get(id);
		if (!this.#negotiated || !surface) return;
		const pending = this.#pendingAcks.has(id);
		this.#pendingAcks.set(id, surface.sequence);
		if (pending) return;
		const epoch = this.#epoch;
		this.#internal(this.#enqueue(async () => {
			if (epoch !== this.#epoch) return;
			const sequence = this.#pendingAcks.get(id)!;
			this.#pendingAcks.delete(id);
			// A close may already have removed the document; applied frames still return their credit.
			await this.#write(encodeTspJson("e", { ev: "ack", sf: id, s: sequence }));
		}));
	}

	#report(msg: string, sf?: string, s?: number, op?: number): void {
		if (this.#negotiated) this.#internal(this.#enqueue(() => this.#write(encodeTspJson("e", { ev: "error", sf, s, op, msg }))));
		this.#onError(new Error(msg));
	}

	#enqueue(work: () => Promise<void> | void): Promise<void> {
		const pending = this.#tail.then(work);
		this.#tail = pending.catch(() => {});
		return pending;
	}

	#internal(pending: Promise<void>): void {
		void pending.catch(error => this.#onError(error instanceof Error ? error : new Error(String(error))));
	}
}
