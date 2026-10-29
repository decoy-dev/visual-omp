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
 * omp 18.14 pi-utils/dirs.ts DirResolver data-root rule. Keep this function self-contained:
 * the native extension embeds this same tested function, without relying on unavailable
 * pi-utils imports in the standalone binary. getAgentDir() has already resolved CLI profiles
 * and explicit agent overrides inside that owning process.
 */
export function resolveHistoryDbPath(input: HistoryPathInputs): string {
	let profile = (input.ompProfile !== undefined ? input.ompProfile : input.piProfile)?.trim();
	if (profile === "default" || profile === "") profile = undefined;
	const root = input.join(input.home, input.configDir || ".omp");
	const defaultAgent = profile ? input.join(root, "profiles", profile, "agent") : input.join(root, "agent");
	if ((input.platform === "linux" || input.platform === "darwin") && input.agentDir === defaultAgent && input.xdgDataHome) {
		const appRoot = input.join(input.xdgDataHome, "omp");
		const selected = profile ? input.join(appRoot, "profiles", profile) : appRoot;
		if (input.exists(selected)) return input.join(selected, "history.db");
	}
	return input.join(input.agentDir, "history.db");
}
