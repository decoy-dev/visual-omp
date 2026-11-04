import { z } from "zod";

const Target = { sf: z.string().min(1), id: z.string().min(1) };
/** A complete answer, validated and converted to native events at the writer. */
export const TspHookAnswer = z.discriminatedUnion("kind", [
	z.strictObject({ ...Target, kind: z.literal("choose"), target: z.string().min(1), item: z.string() }),
	z.strictObject({ ...Target, kind: z.literal("text"), target: z.string().min(1), text: z.string(), len: z.number().int().nonnegative() }),
	z.strictObject({ ...Target, kind: z.literal("action"), target: z.string().min(1), act: z.string().min(1) }),
	z.strictObject({ ...Target, kind: z.literal("cancel") }),
]);
export type TspHookAnswer = z.infer<typeof TspHookAnswer>;
