import { beforeEach, describe, expect, it, vi } from "vitest";
import { renameSavedSession } from "./session-rename";
const fake = vi.hoisted(() => ({ owners: new Map<string, string>(), hosts: [] as Array<{ sessionFile: string; phase: string }>, rpc: vi.fn(), summary: vi.fn() }));
vi.mock("./host", () => ({ listHosts: () => fake.hosts }));
vi.mock("./elsewhere", () => ({ sessionOwnership: async () => fake.owners }));
vi.mock("./rpc", () => ({ rpcRequests: fake.rpc }));
vi.mock("./sessions", () => ({ resolveSessionFile: async () => "/saved/latest.jsonl", sessionSummary: fake.summary }));
beforeEach(() => {
	fake.owners = new Map([["/saved/latest.jsonl", "free"]]);
	fake.hosts = [];
	fake.rpc.mockReset();
	fake.summary.mockReset().mockResolvedValue({ id: "latest", file: "/saved/latest.jsonl", cwd: "/project" });
});
describe("renameSavedSession", () => {
	it.each(["elsewhere", "unknown", "unsupported"])("refuses to rename while ownership is %s", async ownership => {
		fake.owners.set("/saved/latest.jsonl", ownership);
		await expect(renameSavedSession("/saved/old.jsonl", "Renamed")).rejects.toThrow("running in omp");
		expect(fake.rpc).not.toHaveBeenCalled();
	});
	it("refuses an app-owned chat and an empty name before starting another process", async () => {
		fake.hosts = [{ sessionFile: "/saved/latest.jsonl", phase: "live" }];
		await expect(renameSavedSession("/saved/old.jsonl", "Renamed")).rejects.toThrow("running in omp");
		await expect(renameSavedSession("/saved/old.jsonl", "  ")).rejects.toThrow("Enter a name");
		expect(fake.rpc).not.toHaveBeenCalled();
	});
	it("returns omp's canonical saved name and retains initialization errors", async () => {
		fake.rpc.mockResolvedValue([{}, undefined, { sessionName: "Canonical name", sessionFile: "/saved/latest.jsonl", sessionId: "latest" }]);
		await expect(renameSavedSession("/saved/old.jsonl", "  Typed name  ")).resolves.toEqual({ title: "Canonical name", file: "/saved/latest.jsonl", id: "latest", movedFrom: null });
		fake.rpc.mockRejectedValue(new Error("No default model selected."));
		await expect(renameSavedSession("/saved/old.jsonl", "Another name")).rejects.toThrow("No default model selected.");
	});
	it("does not report success when omp omits the resulting name or file", async () => {
		fake.rpc.mockResolvedValue([{}, undefined, {}]);
		await expect(renameSavedSession("/saved/old.jsonl", "Name")).rejects.toThrow("did not confirm");
	});
	it("refuses a different RPC identity before the name mutation", async () => {
		fake.rpc.mockImplementation(async (_folder, requests) => {
			requests[0].validate({ sessionFile: "/saved/different.jsonl", sessionId: "different" });
			throw new Error("Should not reach a name mutation.");
		});
		await expect(renameSavedSession("/saved/old.jsonl", "Name")).rejects.toThrow("No name was changed");
	});
	it("returns an explicit changed destination when omp continues during the write", async () => {
		fake.summary.mockResolvedValueOnce({ id: "latest", file: "/saved/latest.jsonl", cwd: "/project" })
			.mockResolvedValueOnce({ id: "continued", file: "/saved/continued.jsonl", cwd: "/project" });
		fake.rpc.mockResolvedValue([{}, undefined, { sessionName: "New name", sessionFile: "/saved/continued.jsonl", sessionId: "continued" }]);
		await expect(renameSavedSession("/saved/old.jsonl", "Name")).resolves.toEqual({ title: "New name", file: "/saved/continued.jsonl", id: "continued", movedFrom: "/saved/latest.jsonl" });
	});
	it("refuses an unconfirmed post-write identity", async () => {
		fake.rpc.mockResolvedValue([{}, undefined, { sessionName: "Wrong name", sessionFile: "/saved/different.jsonl", sessionId: "different" }]);
		await expect(renameSavedSession("/saved/old.jsonl", "Name")).rejects.toThrow("could not be confirmed");
	});
});
