/** Draft RPC children cannot inherit app bridges, injected config layers or executable preloads. */
export function draftEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		const name = key.toUpperCase();
		if (name === "PI_CODING_AGENT_DIR" || name === "NODE_EXTRA_CA_CERTS") {
			env[key] = value;
			continue;
		}
		if (/^(?:PI_|OMP_|VOMP_|NODE_|BUN_|ELECTRON_|LD_|DYLD_|GIT_|NPM_CONFIG_|PYTHON|RUBY|PERL)/.test(name) ||
			/^(?:BASH_ENV|ENV|ZDOTDIR|SHELLOPTS|BASHOPTS|PROMPT_COMMAND|PS4|TERM_PROGRAM|TERMINAL_EMULATOR|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS|SSLKEYLOGFILE)$/.test(name)) continue;
		env[key] = value;
	}
	return { ...env, NO_COLOR: "1", OMP_SKIP_SETUP: "1", PI_TUI_NATIVE: "0" };
}
