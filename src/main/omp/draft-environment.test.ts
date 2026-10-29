import { describe, expect, it } from "vitest";
import { draftEnvironment } from "./draft-environment";

describe("draft RPC environment", () => {
	it("keeps configured credentials and OS paths while removing execution injection and host controls", () => {
		const inherited = {
			PATH: "/safe/bin", HOME: "/home/user", HTTPS_PROXY: "http://proxy", MY_PROVIDER_TOKEN: "secret",
			PI_CODING_AGENT_DIR: "/isolated-agent", NODE_EXTRA_CA_CERTS: "/safe/cert.pem",
			NODE_OPTIONS: "--require hostile.cjs", NODE_PATH: "/hostile/modules", BUN_OPTIONS: "--preload hostile.ts",
			PI_CONFIG_FILES: "/hostile/config.yml", PI_EXTENSIONS: "/hostile/extension.ts", OMP_TUI_DEBUG: "/host/control",
			VOMP_NATIVE_BRIDGE: "http://host/control", ELECTRON_RUN_AS_NODE: "1", DYLD_INSERT_LIBRARIES: "/hostile.dylib",
			LD_PRELOAD: "/hostile.so", BASH_ENV: "/hostile.sh", ENV: "/hostile.sh", ZDOTDIR: "/hostile-shell", node_options: "--require other.cjs",
		};
		const clean = draftEnvironment(inherited);
		expect(clean).toEqual({ PATH: "/safe/bin", HOME: "/home/user", HTTPS_PROXY: "http://proxy", MY_PROVIDER_TOKEN: "secret", PI_CODING_AGENT_DIR: "/isolated-agent", NODE_EXTRA_CA_CERTS: "/safe/cert.pem", NO_COLOR: "1", OMP_SKIP_SETUP: "1", PI_TUI_NATIVE: "0" });
		expect(inherited.NODE_OPTIONS).toBe("--require hostile.cjs");
	});
});
