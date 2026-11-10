import { useEffect } from "react";
import { create } from "zustand";

/** Display metadata only. Navigation and persisted project paths retain their original spelling. */
const useProjects = create<Record<string, string | null>>(() => ({}));

/** One bounded existing reference check per project supplies realpath identity for symlink-aware labels. */
export function useCanonicalProjectPath(projectPath: string | null): string | null {
	const canonical = useProjects(state => projectPath ? state[projectPath] ?? null : null);
	useEffect(() => {
		if (!projectPath || !window.vomp || Object.hasOwn(useProjects.getState(), projectPath)) return;
		// Null also reserves the in-flight lookup, so sibling consumers share it.
		useProjects.setState({ [projectPath]: null });
		void window.vomp.invoke("fs:resolveRefs", { refs: [projectPath], bases: [] }).then(refs => {
			const folder = refs?.[0];
			useProjects.setState({ [projectPath]: folder?.kind === "folder" ? folder.path : null });
		}, () => useProjects.setState({ [projectPath]: null }));
	}, [projectPath]);
	return canonical;
}
