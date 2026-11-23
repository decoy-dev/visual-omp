/**
 * Late-bound tool renderer lookup so tools like `bash` can render nested tool commands
 * without creating a circular module import with `registry.ts`.
 */
import { genericRenderer } from "./generic";
import type { ToolRenderer } from "./types";

type Resolver = (name: string, details?: unknown) => ToolRenderer;

let resolver: Resolver = () => genericRenderer;

export function registerToolRendererResolver(next: Resolver): void {
	resolver = next;
}

export function lookupToolRenderer(name: string, details?: unknown): ToolRenderer {
	return resolver(name, details);
}
