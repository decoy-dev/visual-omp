import { homedir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamRunOptions, OmpRunner } from "./stream";
import { PluginService } from "./service";

const runner: OmpRunner = {
	env: vi.fn(async () => ({})),
	run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
	stream: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
};
const progress = vi.fn();
const service = new PluginService(runner, progress);

beforeEach(() => { vi.clearAllMocks(); });

describe("plugin upgrades", () => {
	it.each([
		["npm package", "sample-plugin", "1.1.0"],
		["scoped npm package", "@example/omp-plugin", "2.0.0"],
		["git package", "ida-mcp", "1.0.0"],
	])("upgrades an installed %s by its package name and preserves streamed progress", async (_kind, name, to) => {
		vi.mocked(runner.stream).mockImplementationOnce(async (_argv, options: StreamRunOptions) => {
			const stdout = JSON.stringify({ upgraded: name, from: "1.0.0", to, changed: true });
			options.onLine("Updating recorded package source", "stderr");
			options.onLine(stdout, "stdout");
			return { code: 0, stdout, stderr: "Updating recorded package source" };
		});
		await expect(service.upgrade({ id: name, cwd: "/fixture/project", opId: "update-package" })).resolves.toEqual({
			opId: "update-package", ok: true, error: null,
			log: ["Updating recorded package source", JSON.stringify({ upgraded: name, from: "1.0.0", to, changed: true })],
			upgrades: [{ id: name, scope: null, from: "1.0.0", to }],
		});
		expect(runner.stream).toHaveBeenCalledWith(["plugin", "upgrade", "--json", name], expect.objectContaining({ cwd: "/fixture/project", opId: "update-package" }));
		expect(progress).toHaveBeenCalledWith({ opId: "update-package", stream: "stderr", line: "Updating recorded package source" });
		expect(runner.run).not.toHaveBeenCalled();
	});

	it.each(["user", "project"] as const)("retains qualified marketplace IDs and the %s scope", async scope => {
		vi.mocked(runner.stream).mockResolvedValueOnce({ code: 0, stdout: `Upgraded review@catalog (${scope}) to 2.0.0\n`, stderr: "" });
		await expect(service.upgrade({ id: "review@catalog", scope, cwd: "/fixture/project", opId: "update-marketplace" })).resolves.toMatchObject({
			ok: true, upgrades: [{ id: "review@catalog", scope, from: null, to: "2.0.0" }],
		});
		expect(runner.stream).toHaveBeenCalledWith(["plugin", "upgrade", "--json", "review@catalog", "--scope", scope], expect.objectContaining({ cwd: "/fixture/project" }));
	});

	it("preserves marketplace-only bulk upgrades without forwarding a scope", async () => {
		vi.mocked(runner.stream).mockResolvedValueOnce({ code: 0, stdout: "All marketplace plugins are up to date.\n", stderr: "" });
		await expect(service.upgrade({ scope: "project", opId: "update-all" })).resolves.toMatchObject({ ok: true, upgrades: [] });
		expect(runner.stream).toHaveBeenCalledWith(["plugin", "upgrade", "--json"], expect.objectContaining({ cwd: homedir() }));
	});

	it("retains successful unchanged package results without inventing an upgrade", async () => {
		vi.mocked(runner.stream).mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ upgraded: "pkg", from: "1.0.0", to: "1.0.0", changed: false }), stderr: "" });
		await expect(service.upgrade({ id: "pkg" })).resolves.toMatchObject({ ok: true, error: null, upgrades: [] });
	});

	it("returns omp's upgrade failure without reinstalling or falling back to another command", async () => {
		vi.mocked(runner.stream).mockResolvedValueOnce({ code: 1, stdout: "", stderr: "Failed to upgrade linked-plugin: linked-plugin is linked from a local path; there is nothing to upgrade\n" });
		await expect(service.upgrade({ id: "linked-plugin" })).resolves.toMatchObject({
			ok: false, error: "Failed to upgrade linked-plugin: linked-plugin is linked from a local path; there is nothing to upgrade", upgrades: [],
		});
		expect(runner.stream).toHaveBeenCalledTimes(1);
		expect(runner.run).not.toHaveBeenCalled();
	});
});
