const BUILT_IN_FILENAMES: Record<string, true> = { "agents.md": true, "claude.md": true, "gemini.md": true, "rules.md": true };

/** omp extra context files are plain filenames, separate from its built-in context files. */
export function extraInstructionFilenameProblem(input: string): "empty" | "builtIn" | "path" | null {
	const name = input.trim();
	if (!name) return "empty";
	if (Object.hasOwn(BUILT_IN_FILENAMES, name.toLowerCase())) return "builtIn";
	if (name === "." || name === ".." || /[/\\\0]/.test(name)) return "path";
	return null;
}
