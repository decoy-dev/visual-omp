import { z } from "zod";

/** Expected scope binds a save to the file the app prepared, including at the serialized writer. */
export const TspAdvisorAction = z.strictObject({
	sf: z.string().min(1), id: z.string().min(1), scope: z.enum(["project", "user"]), act: z.enum(["scope", "apply", "close"]),
});
export type TspAdvisorAction = z.infer<typeof TspAdvisorAction>;
