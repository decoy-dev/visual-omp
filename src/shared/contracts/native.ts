import { z } from "zod";

const ModeStatus = z.enum(["inactive", "active", "paused"]);
export const SessionModesSchema = z.object({
	plan: z.object({ status: ModeStatus, planFilePath: z.string().optional() }),
	vibe: z.object({ status: z.enum(["inactive", "active"]) }),
	goal: z.object({ status: ModeStatus, objective: z.string().optional(), tokenBudget: z.number().optional() }),
	loop: z.object({ status: ModeStatus }),
});
export type SessionModes = z.infer<typeof SessionModesSchema>;
export const ModeRequestSchema = z.union([
	z.object({ mode: z.enum(["plan", "vibe"]), action: z.enum(["enter", "exit"]) }),
	z.object({ mode: z.literal("goal"), action: z.literal("enter"), objective: z.string().trim().min(1), tokenBudget: z.number().positive().optional() }),
	z.object({ mode: z.literal("goal"), action: z.enum(["pause", "resume", "drop"]) }),
	z.object({ mode: z.literal("loop"), action: z.literal("enter"), prompt: z.string().optional(), limit: z.union([z.object({ kind: z.literal("iterations"), iterations: z.number().int().positive() }), z.object({ kind: z.literal("duration"), durationMs: z.number().positive() })]).optional(), condition: z.object({ command: z.string().trim().min(1), until: z.boolean() }).optional() }),
	z.object({ mode: z.literal("loop"), action: z.literal("exit") }),
]);
export type ModeRequest = z.infer<typeof ModeRequestSchema>;
export const ModeResultSchema = z.union([
	z.object({ ok: z.literal(true), changed: z.boolean(), state: SessionModesSchema }),
	z.object({ ok: z.literal(false), code: z.enum(["busy", "conflict", "disabled", "invalid_request"]), message: z.string(), state: SessionModesSchema }),
]);
export type ModeResult = z.infer<typeof ModeResultSchema>;
const TerminalColorSchema = z.string().regex(/^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8})?$/i);
export const ThemeIdentitySchema = z.object({
	name: z.string().nullable(),
	background: z.string(),
	foreground: z.string(),
	terminal: z.object({ background: TerminalColorSchema.optional(), foreground: TerminalColorSchema.optional(), ansi: z.array(TerminalColorSchema).length(16).optional() }).optional(),
	revision: z.number().optional(),
});
/** Only display metadata crosses the bridge; job output and commands remain in omp's transcript. */
export const NativeJobSchema = z.object({
	id: z.string().min(1).max(256),
	intent: z.string().max(2048).nullable(),
	caption: z.string().max(1024).nullable(),
});
export type NativeJob = z.infer<typeof NativeJobSchema>;
export const NativeSnapshotSchema = z.object({
	modes: SessionModesSchema.nullable(),
	theme: ThemeIdentitySchema.nullable(),
	location: z.object({ cwd: z.string(), sessionFile: z.string().nullable(), sessionId: z.string() }).optional(),
	historyDbPath: z.string().min(1).optional(),
	asyncJobs: z.array(NativeJobSchema).max(100).optional(),
	/** Main's host generation when the bridge accepted this metadata. */
	asyncJobsGeneration: z.number().int().nonnegative().optional(),
	shutdown: z.literal("teardown").optional(),
});
export type NativeSnapshot = z.infer<typeof NativeSnapshotSchema>;
export interface TerminalColors { background?: string; foreground?: string; ansi?: string[]; }

declare module "../ipc" {
	interface IpcInvokeMap {
		"native:snapshot": { args: [hostId: string]; result: NativeSnapshot };
		/** Fresh SDK sample, requested after a collab background wait begins. Null means unavailable. */
		"native:asyncWork": { args: [hostId: string, generation: number]; result: boolean | null };
		"native:setMode": { args: [hostId: string, request: ModeRequest]; result: ModeResult };
		"native:terminalTheme": { args: [hostId: string]; result: TerminalColors | null };
	}
	interface IpcEventMap { "native:changed": { hostId: string; snapshot: NativeSnapshot }; }
}
