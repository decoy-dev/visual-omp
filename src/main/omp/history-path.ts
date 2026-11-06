/** Inputs come from the owning omp process, including its already-resolved agent directory. */
export interface HistoryPathInputs {
	agentDir: string;
	home: string;
	platform: string;
	configDir?: string;
	ompProfile?: string;
	piProfile?: string;
	xdgDataHome?: string;
	join(...parts: string[]): string;
	exists(path: string): boolean;
}

/**
 * omp's data-root rule, shared by sessions, history and blobs. The native extension
 * embeds this function too, so keep it self-contained and pass filesystem dependencies.
 * agentDir must already resolve profiles and explicit overrides in the owning environment.
 */
export function resolveAgentDataDir(input: HistoryPathInputs): string {
	let profile = (input.ompProfile !== undefined ? input.ompProfile : input.piProfile)?.trim();
	if (profile === "default" || profile === "") profile = undefined;
	const root = input.join(input.home, input.configDir || ".omp");
	const defaultAgent = profile ? input.join(root, "profiles", profile, "agent") : input.join(root, "agent");
	if ((input.platform === "linux" || input.platform === "darwin") && input.agentDir === defaultAgent && input.xdgDataHome) {
		const appRoot = input.join(input.xdgDataHome, "omp");
		const selected = profile ? input.join(appRoot, "profiles", profile) : appRoot;
		if (input.exists(selected)) return selected;
	}
	return input.agentDir;
}

export function resolveHistoryDbPath(input: HistoryPathInputs): string {
	return input.join(resolveAgentDataDir(input), "history.db");
}
