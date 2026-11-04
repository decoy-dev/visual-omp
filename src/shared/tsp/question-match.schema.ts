import { z } from "zod";

const Option = z.union([z.string(), z.object({ label: z.string(), description: z.string().optional() })]);
export const CollabQuestion = z.discriminatedUnion("kind", [
	z.object({ reqId: z.number().int().nonnegative(), kind: z.literal("select"), title: z.string(), options: z.array(Option) }),
	z.object({ reqId: z.number().int().nonnegative(), kind: z.literal("editor"), title: z.string(), prefill: z.string().optional() }),
]);
export const CollabQuestionState = z.strictObject({
	hostId: z.string(), generation: z.number().int().nonnegative(), epoch: z.number().int().nonnegative(),
	connection: z.number().int().nonnegative(), revision: z.number().int().nonnegative(), connected: z.boolean(),
	requests: z.array(CollabQuestion),
});
export type CollabQuestion = z.infer<typeof CollabQuestion>;
export type CollabQuestionState = z.infer<typeof CollabQuestionState>;
