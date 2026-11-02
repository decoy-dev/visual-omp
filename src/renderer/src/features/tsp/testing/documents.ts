import { z } from "zod";
import type { TspFrame, TspOpen } from "@shared/tsp";
import type { TspSurfaceSnapshot } from "@shared/tsp-host";
import { TspDocument } from "../../../../../main/omp/tsp/apply";

const Open = z.object({ id: z.string(), mode: z.enum(["inline", "screen"]), title: z.string().optional(), role: z.string().optional(), adopt: z.boolean().optional() });
const Frame = z.object({ sf: z.string(), s: z.number(), ops: z.array(z.unknown()) });
const Close = z.object({ id: z.string(), keep: z.boolean() });
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
