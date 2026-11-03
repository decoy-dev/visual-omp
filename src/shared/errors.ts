/** Preserve an Error's message and stringify non-Error failures consistently. */
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
