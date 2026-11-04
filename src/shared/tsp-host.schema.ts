import { z } from "zod";

const Target = { sf: z.string().min(1), id: z.string().min(1) };
const Offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Edit = z.strictObject({
	ev: z.literal("edit"), ...Target, from: Offset, to: Offset, text: z.string(), cursor: Offset, len: Offset,
}).refine(event => event.from <= event.to && event.to <= event.len && event.cursor <= event.len - (event.to - event.from) + event.text.length, "Invalid UTF-16 edit range");

/** Untrusted renderer input. Main alone owns protocol lifecycle, credits and environment events. */
export const TspRendererEvent = z.discriminatedUnion("ev", [
	z.strictObject({ ev: z.literal("visible"), sf: z.string().min(1), visible: z.boolean() }),
	z.strictObject({ ev: z.literal("toggle"), ...Target, key: z.string().optional(), collapsed: z.boolean() }),
	z.strictObject({ ev: z.literal("select"), ...Target, item: z.string() }),
	z.strictObject({ ev: z.literal("activate"), ...Target, item: z.string() }),
	z.strictObject({ ev: z.literal("action"), ...Target, act: z.string().min(1), value: z.string().optional(), mods: z.array(z.string()).optional() }),
	z.strictObject({ ev: z.literal("change"), ...Target, item: z.string(), value: z.union([z.boolean(), z.number().finite(), z.string(), z.array(z.string()), z.null()]) }),
	Edit,
	z.strictObject({ ev: z.literal("undo"), ...Target }),
	z.strictObject({ ev: z.literal("send"), ...Target, text: z.string() }),
	z.strictObject({ ev: z.literal("focus"), ...Target }),
]);
export type TspRendererEvent = z.infer<typeof TspRendererEvent>;
