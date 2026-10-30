import { z } from "zod";
import { TSP_DEFAULT_APC_LIMIT, TSP_DEFAULT_CREDITS, TSP_KINDS, TSP_VERSION, type TspEvent, type TspFrame, type TspOpen } from "../../../shared/tsp";
import { TspRendererEvent, TSP_PREVIEW_UNAVAILABLE, type TspSurfaceSnapshot } from "../../../shared/tsp-host";
import { composer, liveSurfaces, openOverlay, screenSurface, walkNodes } from "../../../shared/tsp/view-state";
import { isHookDialog } from "../../../shared/tsp/roles";
import { TspDocument } from "./apply";
import { encodeTspJson } from "./encode";
import type { TspMessage } from "./stream";

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
	closed: boolean;
}

export type TspUpdate = "hello" | "open" | "frame" | "close";

/** A document or protocol transition refused input before any application bytes were written. */
export class TspInputStateError extends Error {}

/**
 * omp owns document content and submission semantics. The app applies its semantic documents
 * and validates renderer interaction at the serialized writer. Hook dialogs remain display-only
 * until collab question arbitration is implemented. No blobs or aside layout are advertised.
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
	#programFeatures = new Set<string>();
	#cols: number;
	#dark: boolean;
	#reduceMotion: boolean;

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

	snapshot(): { negotiated: boolean; epoch: number; surfaces: TspSurfaceSnapshot[] } {
		return {
			negotiated: this.#negotiated,
			epoch: this.#epoch,
			surfaces: [...this.#surfaces.values()].map(surface => ({
				open: { ...surface.open }, sequence: surface.sequence, closed: surface.closed,
				document: surface.doc.snapshot(), focus: surface.doc.focus,
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
				this.#programFeatures = new Set(query.data.features);
				// First reply precedes every event, including acks for optimistic native frames.
				this.#internal(this.#enqueue(() => this.#write(encodeTspJson("r", {
					r: "hello", v: TSP_VERSION, term: "visual-omp", kinds: TSP_KINDS, features: [],
					apc: TSP_DEFAULT_APC_LIMIT, credits: TSP_DEFAULT_CREDITS, cols: this.#cols,
					dark: this.#dark, reduceMotion: this.#reduceMotion,
				}))));
				this.#negotiated = true;
				this.#onUpdate("hello");
				return;
			}
			case "o": {
				const open = Open.safeParse(body);
				if (!open.success) { this.#report("Invalid TSP surface"); return; }
				const previous = this.#surfaces.get(open.data.id);
				if (open.data.adopt && !previous) {
					this.#internal(this.#enqueue(() => this.#write(encodeTspJson("e", { ev: "gone", ids: [open.data.id] }))));
					return;
				}
				if (open.data.adopt && previous) {
					previous.open = open.data;
					previous.closed = false;
				} else {
					this.#surfaces.set(open.data.id, { open: open.data, doc: new TspDocument(open.data.id), sequence: 0, closed: false });
				}
				this.#onUpdate("open", open.data.id);
				return;
			}
			case "f": {
				const frame = Frame.safeParse(body);
				if (!frame.success) { this.#report("Invalid TSP frame"); return; }
				const surface = this.#surfaces.get(frame.data.sf);
				if (!surface || surface.closed) { this.#report("Frame for an unavailable TSP surface", frame.data.sf, frame.data.s); return; }
				if (frame.data.s > surface.sequence) {
					const errors = surface.doc.applyFrame(frame.data as TspFrame);
					surface.sequence = frame.data.s;
					for (const error of errors) this.#report(error.msg, frame.data.sf, error.s, error.op);
					this.#onUpdate("frame", frame.data.sf);
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
				this.#onUpdate("close", close.data.id);
			}
		}
	}

	/** Called under the host's application input lock for renderer-originated events. */
	send(input: unknown, assertCurrent?: () => void): Promise<void> {
		if (!this.#negotiated) return Promise.reject(new Error("TSP preview: The protocol has not negotiated yet."));
		const parsed = TspRendererEvent.safeParse(input);
		if (!parsed.success) return Promise.reject(new Error("TSP preview: Invalid renderer event."));
		const event = parsed.data;
		const epoch = this.#epoch;
		return this.#enqueue(async () => {
			assertCurrent?.();
			if (epoch !== this.#epoch) throw new TspInputStateError("TSP preview: The semantic screen restarted.");
			if (["send", "edit", "undo"].includes(event.ev) && !this.#programFeatures.has(event.ev)) throw new Error(`TSP preview: omp does not accept ${event.ev} events.`);
			if (event.ev !== "visible" && this.hasReadOnlyHook()) throw new TspInputStateError("TSP preview: This question is read-only in this preview. If it also appears in chat, answer it there.");
			const surface = this.#surfaces.get(event.sf);
			if (!surface || surface.closed || surface.doc.suspended) throw new TspInputStateError("TSP preview: The target surface is no longer available.");
			if ("id" in event) {
				const node = surface.doc.get(event.id);
				if (!node) throw new TspInputStateError("TSP preview: The target node is no longer available.");
				if (event.ev === "send" && ((node.k !== "editor" && node.k !== "input") || node.p?.sendable !== true)) throw new TspInputStateError("TSP preview: The editor is not ready to send.");
				if (event.ev === "edit") {
					if ((node.k !== "editor" && node.k !== "input") || node.p?.readonly === true || event.len !== (node.p?.text?.length ?? 0)) throw new Error("TSP preview: The editor changed before the edit could be applied.");
				}
			}
			await this.#write(encodeTspJson("e", event));
		});
	}

	/** Atomic text submission to omp's main composer, preserving its displaced-draft semantics. */
	submit(text: string, assertCurrent?: () => void, surfaceAllowed: (surface: string) => boolean = () => true): Promise<void> {
		if (!text.trim() || /^[!$]/.test(text.trimStart())) return Promise.reject(new Error(TSP_PREVIEW_UNAVAILABLE));
		const surfaces = this.snapshot().surfaces;
		const availability = this.availability(surfaceAllowed);
		if (!availability.available) return Promise.reject(new TspInputStateError(`TSP preview: The main editor is not ready to send. ${availability.reason}`));
		const target = composer(surfaces.filter(surface => surfaceAllowed(surface.open.id)))!;
		const original = this.#surfaces.get(target.surface.open.id);
		return this.send({ ev: "send", sf: target.surface.open.id, id: target.node.id, text }, () => {
			assertCurrent?.();
			if (!surfaceAllowed(target.surface.open.id) || this.#surfaces.get(target.surface.open.id) !== original) throw new TspInputStateError("TSP preview: The main editor changed before the message could be sent.");
			if (!this.availability(surfaceAllowed).available) throw new TspInputStateError("TSP preview: The main editor is not ready to send.");
		});
	}

	availability(surfaceAllowed: (surface: string) => boolean = () => true): { available: boolean; reason: string | null } {
		const surfaces = this.snapshot().surfaces;
		if (!this.#negotiated) return { available: false, reason: "Waiting for omp to start its semantic screen." };
		if (!this.#programFeatures.has("send")) return { available: false, reason: "omp does not accept send events." };
		if (screenSurface(surfaces)) return { available: false, reason: "Close the omp screen before sending a message." };
		if (openOverlay(surfaces)) return { available: false, reason: "Close the open omp menu before sending a message." };
		if (!composer(surfaces.filter(surface => surfaceAllowed(surface.open.id)))) return { available: false, reason: "Wait for omp to finish opening its main editor." };
		return { available: true, reason: null };
	}

	hasReadOnlyHook(): boolean {
		return liveSurfaces(this.snapshot().surfaces).some(surface => [...walkNodes(surface.document)].some(node => isHookDialog(node.p?.role)));
	}

	/** Ordinary terminal reports share the protocol queue, so DA1 never overtakes hello. */
	terminalReply(data: string): void {
		this.#internal(this.#enqueue(() => this.#write(data)));
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
