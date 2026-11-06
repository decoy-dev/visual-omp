import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgentDataDir, resolveHistoryDbPath, type HistoryPathInputs } from "./history-path";

const base: HistoryPathInputs = { agentDir: "/home/user/.omp/agent", home: "/home/user", platform: "darwin", join: posix.join, exists: () => false };

describe("owning omp history path", () => {
	it("uses the default agent and PI_CONFIG_DIR roots", () => {
		expect(resolveHistoryDbPath(base)).toBe("/home/user/.omp/agent/history.db");
		expect(resolveHistoryDbPath({ ...base, configDir: ".other-omp", agentDir: "/home/user/.other-omp/agent" })).toBe("/home/user/.other-omp/agent/history.db");
	});
	it("keeps an explicit resolved agent override outside XDG", () => {
		expect(resolveHistoryDbPath({ ...base, agentDir: "/explicit/agent", xdgDataHome: "/xdg", exists: () => true })).toBe("/explicit/agent/history.db");
	});
	it("uses the owning process's named profile and ignores a lower-priority legacy profile", () => {
		expect(resolveHistoryDbPath({ ...base, ompProfile: "work", piProfile: "other", agentDir: "/home/user/.omp/profiles/work/agent" })).toBe("/home/user/.omp/profiles/work/agent/history.db");
		expect(resolveHistoryDbPath({ ...base, ompProfile: "", piProfile: "work" })).toBe("/home/user/.omp/agent/history.db");
	});
	it.each(["darwin", "linux"])("adopts an existing XDG data root on %s and retains the legacy root when absent", platform => {
		expect(resolveHistoryDbPath({ ...base, platform, xdgDataHome: "/xdg", exists: path => path === "/xdg/omp" })).toBe("/xdg/omp/history.db");
		expect(resolveHistoryDbPath({ ...base, platform, xdgDataHome: "/xdg" })).toBe("/home/user/.omp/agent/history.db");
	});
	it("requires the profile-specific XDG root instead of adopting the base app root", () => {
		const input = { ...base, ompProfile: "work", agentDir: "/home/user/.omp/profiles/work/agent", xdgDataHome: "/xdg" };
		expect(resolveHistoryDbPath({ ...input, exists: path => path === "/xdg/omp" })).toBe("/home/user/.omp/profiles/work/agent/history.db");
		expect(resolveHistoryDbPath({ ...input, exists: path => path === "/xdg/omp/profiles/work" })).toBe("/xdg/omp/profiles/work/history.db");
	});
	it("does not apply XDG redirection to Windows", () => {
		expect(resolveHistoryDbPath({ ...base, platform: "win32", home: "C:\\Users\\person", agentDir: "C:\\Users\\person\\.omp\\agent", join: win32.join, xdgDataHome: "D:\\data", exists: () => true })).toBe("C:\\Users\\person\\.omp\\agent\\history.db");
	});
	it.each(["darwin", "linux", "win32", "freebsd"])("shares the full data-root rule on %s", platform => {
		for (const xdgDataHome of [undefined, "", "/xdg"]) {
			for (const present of [false, true]) {
				for (const agentDir of [base.agentDir, "/custom/agent"]) {
					const input = { ...base, platform, agentDir, xdgDataHome, exists: () => present };
					const expected = (platform === "darwin" || platform === "linux") && xdgDataHome && present && agentDir === base.agentDir
						? "/xdg/omp" : agentDir;
					expect(resolveAgentDataDir(input)).toBe(expected);
					expect(resolveHistoryDbPath(input)).toBe(posix.join(expected, "history.db"));
				}
			}
		}
	});
	it("embeds the shared resolver and history wrapper without other module bindings", () => {
		const embedded = Function(`const resolveAgentDataDir = ${resolveAgentDataDir.toString()}; return (${resolveHistoryDbPath.toString()});`)() as typeof resolveHistoryDbPath;
		expect(embedded({ ...base, xdgDataHome: "/xdg", exists: () => true })).toBe("/xdg/omp/history.db");
	});
});
