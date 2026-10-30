import type * as PathModule from "node:path";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renameSavedSession } from "./session-rename";
const fake = vi.hoisted(() => ({
	windowsPaths: false,
	paths: { old: "", latest: "", continued: "", different: "", project: "" },
	owners: new Map<string, string>(), hosts: [] as Array<{ sessionFile: string; phase: string }>, rpc: vi.fn(), summary: vi.fn(),
}));
vi.mock("node:path", async importOriginal => {
	const actual = await importOriginal<typeof PathModule>();
	return {
		...actual,
		join: (...parts: string[]) => (fake.windowsPaths ? actual.win32 : actual).join(...parts),
		resolve: (...parts: string[]) => (fake.windowsPaths ? actual.win32 : actual).resolve(...parts),
	};
});
vi.mock("./host", () => ({ listHosts: () => fake.hosts }));
vi.mock("./elsewhere", () => ({ sessionOwnership: async () => fake.owners }));
vi.mock("./rpc", () => ({ rpcRequests: fake.rpc }));
vi.mock("./sessions", () => ({ resolveSessionFile: async () => fake.paths.latest, sessionSummary: fake.summary }));
describe.each(["native", "win32"] as const)("renameSavedSession with %s paths", pathStyle => {
	beforeEach(() => {
		fake.windowsPaths = pathStyle === "win32";
		const root = resolve(fake.windowsPaths ? "C:\\fixtures" : "/fixtures");
		fake.paths = {
			old: join(root, "saved", "old.jsonl"), latest: join(root, "saved", "latest.jsonl"),
			continued: join(root, "saved", "continued.jsonl"), different: join(root, "saved", "different.jsonl"),
			project: join(root, "project"),
		};
		fake.owners = new Map([[fake.paths.latest, "free"]]);
		fake.hosts = [];
		fake.rpc.mockReset();
		fake.summary.mockReset().mockResolvedValue({ id: "latest", file: fake.paths.latest, cwd: fake.paths.project });
	});
	it.each(["elsewhere", "unknown", "unsupported"])("refuses to rename while ownership is %s", async ownership => {
		fake.owners.set(fake.paths.latest, ownership);
		await expect(renameSavedSession(fake.paths.old, "Renamed")).rejects.toThrow("running in omp");
		expect(fake.rpc).not.toHaveBeenCalled();
	});
	it("refuses an app-owned chat and an empty name before starting another process", async () => {
		fake.hosts = [{ sessionFile: fake.paths.latest, phase: "live" }];
		await expect(renameSavedSession(fake.paths.old, "Renamed")).rejects.toThrow("running in omp");
		await expect(renameSavedSession(fake.paths.old, "  ")).rejects.toThrow("Enter a name");
		expect(fake.rpc).not.toHaveBeenCalled();
	});
	it("returns omp's canonical saved name and retains initialization errors", async () => {
		const reportedFile = fake.paths.latest.replaceAll("\\", "/");
		fake.rpc.mockImplementation(async (_folder, requests) => {
			requests[0].validate({ sessionFile: reportedFile, sessionId: "latest" });
			expect(requests[1].params).toEqual({ name: "Typed name" });
			return [{}, undefined, { sessionName: "Canonical name", sessionFile: reportedFile, sessionId: "latest" }];
		});
		await expect(renameSavedSession(fake.paths.old, "  Typed name  ")).resolves.toEqual({ title: "Canonical name", file: fake.paths.latest, id: "latest", movedFrom: null });
		fake.rpc.mockRejectedValue(new Error("No default model selected."));
		await expect(renameSavedSession(fake.paths.old, "Another name")).rejects.toThrow("No default model selected.");
	});
	it("does not report success when omp omits the resulting name or file", async () => {
		fake.rpc.mockResolvedValue([{}, undefined, {}]);
		await expect(renameSavedSession(fake.paths.old, "Name")).rejects.toThrow("did not confirm");
	});
	it("refuses a different RPC identity before the name mutation", async () => {
		fake.rpc.mockImplementation(async (_folder, requests) => {
			requests[0].validate({ sessionFile: fake.paths.different, sessionId: "different" });
			throw new Error("Should not reach a name mutation.");
		});
		await expect(renameSavedSession(fake.paths.old, "Name")).rejects.toThrow("No name was changed");
	});
	it("returns an explicit changed destination when omp continues during the write", async () => {
		fake.summary.mockResolvedValueOnce({ id: "latest", file: fake.paths.latest, cwd: fake.paths.project })
			.mockResolvedValueOnce({ id: "continued", file: fake.paths.continued, cwd: fake.paths.project });
		fake.rpc.mockResolvedValue([{}, undefined, { sessionName: "New name", sessionFile: fake.paths.continued, sessionId: "continued" }]);
		await expect(renameSavedSession(fake.paths.old, "Name")).resolves.toEqual({ title: "New name", file: fake.paths.continued, id: "continued", movedFrom: fake.paths.latest });
	});
	it("refuses an unconfirmed post-write identity", async () => {
		fake.rpc.mockResolvedValue([{}, undefined, { sessionName: "Wrong name", sessionFile: fake.paths.different, sessionId: "different" }]);
		await expect(renameSavedSession(fake.paths.old, "Name")).rejects.toThrow("could not be confirmed");
	});
});
