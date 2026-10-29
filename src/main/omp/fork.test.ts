import { readFile, stat } from "node:fs/promises";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { forkSavedSession } from "./fork";
import type * as RpcModule from "./rpc";

const fixture = vi.hoisted(() => ({
	request: vi.fn(),
	env: {} as NodeJS.ProcessEnv,
	file: "",
}));
vi.mock("./rpc", async importOriginal => {
	const actual = await importOriginal<typeof RpcModule>();
	return { ...actual, rpcRequests: (...args: Parameters<typeof RpcModule.rpcRequests>) => fixture.request(...args) };
});
vi.mock("./sessions", () => ({ resolveSessionFile: async (file: string) => fixture.file || file }));
vi.mock("./locate", () => ({ ompPath: async () => process.env.VOMP_OWNERSHIP_FIXTURE_BIN }));
vi.mock("../env", () => ({ userEnv: async () => fixture.env }));
vi.mock("./refused", () => ({ ompStartError: async (error: unknown) => error }));

beforeEach(() => {
	fixture.request.mockReset();
	fixture.file = "";
});

it("returns the new session identity only after omp confirms the copy", async () => {
	fixture.request.mockResolvedValue([{ cancelled: false }, { sessionFile: "/copy.jsonl", sessionId: "copy-id" }]);
	await expect(forkSavedSession("/source.jsonl", "/project", "message-1")).resolves.toEqual({ file: "/copy.jsonl", id: "copy-id" });
});

it("refuses cancellation instead of opening the original as a copy", async () => {
	fixture.request.mockResolvedValue([{ cancelled: true }, { sessionFile: "/source.jsonl", sessionId: "source" }]);
	await expect(forkSavedSession("/source.jsonl", "/project")).rejects.toThrow("cancelled");
});

it("rejects a successful response that retained the source file", async () => {
	fixture.file = "/continued.jsonl";
	fixture.request.mockResolvedValue([{ cancelled: false }, { sessionFile: "/continued.jsonl", sessionId: "source" }]);
	await expect(forkSavedSession("/source.jsonl", "/project")).rejects.toThrow("did not create a copy");
});

describe.skipIf(!process.env.VOMP_OWNERSHIP_FIXTURE_BIN)("omp 18.14 live-source RPC fork", () => {
	it.each([undefined, "user-1", "assistant-1"])("preserves source bytes and mtime when forking at %s", async entryId => {
		const source = process.env.VOMP_OWNERSHIP_FIXTURE_FILE!;
		fixture.env = {
			...process.env,
			HOME: process.env.VOMP_OWNERSHIP_FIXTURE_HOME!,
			PI_CODING_AGENT_DIR: process.env.VOMP_OWNERSHIP_FIXTURE_AGENT!,
			PI_TEST_SESSION_OWNERS_DIR: process.env.VOMP_OWNERSHIP_FIXTURE_LEASES!,
			ANTHROPIC_API_KEY: "fixture-no-network",
		};
		const actual = await vi.importActual<typeof RpcModule>("./rpc");
		fixture.request.mockImplementation(actual.rpcRequests);
		const before = await readFile(source);
		const beforeStat = await stat(source, { bigint: true });
		const fork = await forkSavedSession(source, process.env.VOMP_OWNERSHIP_FIXTURE_AGENT!, entryId);
		expect(fork.file).not.toBe(source);
		expect(await readFile(source)).toEqual(before);
		expect((await stat(source, { bigint: true })).mtimeNs).toBe(beforeStat.mtimeNs);
		const copy = (await readFile(fork.file, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
		expect(copy.some(entry => entry.type === "session" && entry.id === fork.id)).toBe(true);
		if (entryId === "user-1") expect(copy.some(entry => entry.id === "assistant-1")).toBe(false);
		else expect(copy.some(entry => entry.id === "assistant-1")).toBe(true);
	});
});
