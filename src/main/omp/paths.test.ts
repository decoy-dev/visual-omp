import type * as OsModule from "node:os";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentDataDir, agentDir, sessionsDir } from "./paths";

const fixture = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async importOriginal => ({ ...(await importOriginal<typeof OsModule>()), homedir: () => fixture.home }));
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "vomp-data-paths-")); fixture.home = join(root, "home"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("omp filesystem paths", () => {
	it("preserves the default layout without XDG and resolves explicit overrides before comparison", async () => {
		const standard = join(fixture.home, ".omp", "agent");
		expect(agentDir({})).toBe(standard);
		expect(sessionsDir({})).toBe(join(standard, "sessions"));
		const data = join(root, "data");
		await mkdir(join(data, "omp"), { recursive: true });
		for (const override of [undefined, standard, relative(process.cwd(), standard)]) {
			const env = { XDG_DATA_HOME: data, PI_CODING_AGENT_DIR: override };
			expect(sessionsDir(env)).toBe(join(process.platform === "win32" ? standard : join(data, "omp"), "sessions"));
		}
		const custom = join(root, "custom-agent");
		expect(agentDataDir({ XDG_DATA_HOME: data, PI_CODING_AGENT_DIR: custom })).toBe(custom);
	});
	it("rechecks the XDG marker instead of caching the first root", async () => {
		const env = { XDG_DATA_HOME: join(root, "data") };
		const standard = join(fixture.home, ".omp", "agent", "sessions");
		expect(sessionsDir(env)).toBe(standard);
		await mkdir(join(env.XDG_DATA_HOME, "omp"), { recursive: true });
		expect(sessionsDir(env)).toBe(process.platform === "win32" ? standard : join(env.XDG_DATA_HOME, "omp", "sessions"));
		await rm(join(env.XDG_DATA_HOME, "omp"), { recursive: true });
		expect(sessionsDir(env)).toBe(standard);
	});
	it("uses the same profile and config inputs as the native history resolver", async () => {
		const env = { PI_CONFIG_DIR: ".other", OMP_PROFILE: " work ", PI_PROFILE: "ignored", PI_CODING_AGENT_DIR: join(root, "ignored-agent"), XDG_DATA_HOME: join(root, "data") };
		const standard = join(fixture.home, ".other", "profiles", "work", "agent");
		expect(agentDir(env)).toBe(standard);
		await mkdir(join(env.XDG_DATA_HOME, "omp"), { recursive: true });
		expect(agentDataDir(env)).toBe(standard);
		await mkdir(join(env.XDG_DATA_HOME, "omp", "profiles", "work"), { recursive: true });
		expect(agentDataDir(env)).toBe(process.platform === "win32" ? standard : join(env.XDG_DATA_HOME, "omp", "profiles", "work"));
		expect(agentDir({ ...env, OMP_PROFILE: "", PI_CODING_AGENT_DIR: undefined })).toBe(join(fixture.home, ".other", "agent"));
	});
});
