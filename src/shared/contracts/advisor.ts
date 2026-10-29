import { z } from "zod";

export const AdvisorScopeSchema = z.enum(["project", "user"]);
export type AdvisorScope = z.infer<typeof AdvisorScopeSchema>;
export const AdvisorEntrySchema = z.object({
	name: z.string(), model: z.string().optional(), tools: z.array(z.string()).optional(), instructions: z.string().optional(),
	enabled: z.boolean().optional(), reviewMode: z.enum(["turn", "agent-end"]).optional(), reviewInterval: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
	syncBacklog: z.union([z.enum(["off", "1", "3", "5", "strict"]), z.literal(1), z.literal(3), z.literal(5)]).optional(),
	maxNotesPerUpdate: z.number().min(1).optional(), scope: z.enum(["main", "subagent", "all"]).optional(), includeReasoning: z.boolean().optional(),
}).passthrough();
export type AdvisorEntry = z.infer<typeof AdvisorEntrySchema>;
export const AdvisorDocSchema = z.object({ instructions: z.string().optional(), maxNotesPerUpdate: z.number().min(1).optional(), advisors: z.array(AdvisorEntrySchema) }).passthrough();
export type AdvisorDoc = z.infer<typeof AdvisorDocSchema>;
export interface AdvisorFile { file: string; content: string; exists: boolean; doc: AdvisorDoc; error?: string; }

declare module "../ipc" {
	interface IpcInvokeMap {
		"advisor:read": { args: [cwd: string, scope: AdvisorScope]; result: AdvisorFile };
		"advisor:save": { args: [cwd: string, scope: AdvisorScope, original: string, doc: AdvisorDoc]; result: AdvisorFile };
		"advisor:beginApply": { args: [cwd: string, scope: AdvisorScope]; result: string };
		"advisor:finishApply": { args: [token: string]; result: AdvisorFile };
	}
}
