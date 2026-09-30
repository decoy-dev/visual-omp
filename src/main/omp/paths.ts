import { homedir } from "node:os";
import { join } from "node:path";

/** omp's agent directory (`PI_CODING_AGENT_DIR`, default `~/.omp/agent`). */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
}

export function sessionsDir(env?: NodeJS.ProcessEnv): string {
	return join(agentDir(env), "sessions");
}
