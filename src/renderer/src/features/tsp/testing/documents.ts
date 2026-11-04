import { z } from "zod";
import type { TspFrame, TspOpen } from "@shared/tsp";
import type { TspSurfaceSnapshot } from "@shared/tsp-host";
import { TspRendererEvent } from "@shared/tsp-host.schema";
import { TspDocument } from "../../../../../main/omp/tsp/apply";

const Open = z.object({ id: z.string(), mode: z.enum(["inline", "screen"]), title: z.string().optional(), role: z.string().optional(), adopt: z.boolean().optional() });
const Frame = z.object({ sf: z.string(), s: z.number(), ops: z.array(z.unknown()) });
const Close = z.object({ id: z.string(), keep: z.boolean() });

/** Change this selector when replacing the pinned recordings; consumers do not own fixture paths. */
export const FIXTURE_VERSION = "18.15.0";
const recordings = import.meta.glob<string>("../../../../../main/omp/tsp/fixtures/*/*.{messages,events}.jsonl", { query: "?raw", import: "default", eager: true });
const Message = z.object({ verb: z.string(), body: z.unknown() });
const EventRecord = z.object({ verb: z.string().optional(), body: z.unknown().optional(), keys: z.string().optional(), afterMessage: z.number().int().nonnegative().optional() });
export interface FixtureMessage { verb: string; body: unknown }
export type FixtureInput = { keys: string; afterMessage?: number } | { verb: "e"; body: TspRendererEvent; afterMessage?: number };
export interface FixtureRecording { messages: FixtureMessage[]; inputs: FixtureInput[] }
const housekeeping: Readonly<Record<string, true | undefined>> = { ack: true, resize: true, theme: true, motion: true };
/** Skip only named protocol housekeeping. Unsupported application input must fail the replay. */
export function parseFixtureInputs(text: string): FixtureInput[] {
	const lines = text.trim() ? text.trim().split("\n") : [];
	return lines.flatMap((line): FixtureInput[] => {
		const record = EventRecord.parse(JSON.parse(line));
		if (record.keys !== undefined) {
			if (record.verb !== undefined || record.body !== undefined) throw new Error("A recorded key input cannot also carry a semantic message");
			return [{ keys: record.keys, afterMessage: record.afterMessage }];
		}
		if (record.verb === "r") {
			z.object({ r: z.literal("hello") }).parse(record.body);
			return [];
		}
		if (record.verb !== "e") throw new Error(`Unsupported recorded client verb: ${record.verb ?? "missing"}`);
		const envelope = z.object({ ev: z.string() }).parse(record.body);
		if (Object.hasOwn(housekeeping, envelope.ev)) return [];
		return [{ verb: "e", body: TspRendererEvent.parse(record.body), afterMessage: record.afterMessage }];
	});
}
export function loadFixtureRecording(name: string): FixtureRecording {
	const source = (kind: "messages" | "events"): string => {
		const entry = Object.entries(recordings).find(([path]) => path.endsWith(`/${FIXTURE_VERSION}/${name}.${kind}.jsonl`));
		if (!entry) throw new Error(`Missing omp ${FIXTURE_VERSION} ${name}.${kind}.jsonl recording`);
		return entry[1];
	};
	const text = source("messages").trim();
	const messages = (text ? text.split("\n") : []).map(line => Message.parse(JSON.parse(line)));
	const inputs = parseFixtureInputs(source("events"));
	return { messages, inputs };
}
/** Renderer fixture replay stays free of Node transports and their Buffer dependency. */
export class FixtureDocuments {
	#epoch = 0;
	#surfaces = new Map<string, { open: TspOpen; document: TspDocument; sequence: number; closed: boolean }>();
	receive(message: { verb: string; body: string; params?: Record<string, string> }): void {
		const body: unknown = JSON.parse(message.body);
		switch (message.verb) {
			case "q":
				if (z.object({ q: z.literal("hello") }).safeParse(body).success) { this.#epoch++; this.#surfaces.clear(); }
				break;
			case "o": {
				const open = Open.parse(body);
				const previous = this.#surfaces.get(open.id);
				this.#surfaces.set(open.id, { open, document: open.adopt && previous ? previous.document : new TspDocument(open.id), sequence: previous && open.adopt ? previous.sequence : 0, closed: false });
				break;
			}
			case "f": {
				const envelope = Frame.parse(body);
				const surface = this.#surfaces.get(envelope.sf);
				if (!surface || surface.closed) throw new Error(`Unavailable recorded surface: ${envelope.sf}`);
				// Repository-controlled fixtures use wire operations. The applier checks them;
				// main's replay suite separately validates the untrusted transport boundary.
				const frame = envelope as TspFrame;
				if (frame.s <= surface.sequence) break;
				const errors = surface.document.applyFrame(frame);
				if (errors.length) throw new Error(JSON.stringify(errors));
				surface.sequence = frame.s;
				break;
			}
			case "x": {
				const close = Close.parse(body);
				const surface = this.#surfaces.get(close.id);
				if (surface && close.keep) { surface.document.close(); surface.closed = true; }
				else this.#surfaces.delete(close.id);
			}
		}
	}
	snapshot(): { epoch: number; negotiated: boolean; surfaces: TspSurfaceSnapshot[] } {
		return { epoch: this.#epoch, negotiated: this.#epoch > 0, surfaces: [...this.#surfaces.values()].map(surface => ({
			open: surface.open, sequence: surface.sequence, closed: surface.closed, suspended: surface.document.suspended,
			focus: surface.document.focus, settled: [...surface.document.settled], document: surface.document.snapshot(),
		})) };
	}
}
