import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveAgentDataDir } from "./history-path";

/** omp's agent configuration directory. Data may use a separate XDG root. */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	const root = join(homedir(), env.PI_CONFIG_DIR || ".omp");
	const profile = (env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE)?.trim();
	if (profile && profile !== "default") return join(root, "profiles", profile, "agent");
	return env.PI_CODING_AGENT_DIR ? resolve(env.PI_CODING_AGENT_DIR) : join(root, "agent");
}

/** Recheck the cheap XDG migration marker on each read, including offline history. */
export function agentDataDir(env: NodeJS.ProcessEnv = process.env): string {
	return resolveAgentDataDir({
		agentDir: agentDir(env), home: homedir(), platform: process.platform,
		configDir: env.PI_CONFIG_DIR, ompProfile: env.OMP_PROFILE, piProfile: env.PI_PROFILE,
		xdgDataHome: env.XDG_DATA_HOME, join, exists: existsSync,
	});
}

export function sessionsDir(env?: NodeJS.ProcessEnv): string {
	return join(agentDataDir(env), "sessions");
}
