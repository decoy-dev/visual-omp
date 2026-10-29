import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@shared/ipc";
import { loadPinnedSessionIds, migrateSessionPins, toggleConversationPin, toggleSessionPin } from "./session-pins";

const fake = vi.hoisted(() => ({ root: "", legacy: undefined as string[] | undefined, rpc: vi.fn(), finish: vi.fn() }));
vi.mock("../env", () => ({ userEnv: async () => ({ PI_CODING_AGENT_DIR: fake.root }) }));
vi.mock("../prefs", () => ({ getPrefs: () => ({ pinnedSessions: fake.legacy }), finishSessionPinMigration: () => { fake.legacy = undefined; fake.finish(); } }));
vi.mock("./rpc", () => ({ rpcRequest: fake.rpc }));
const summary = (id: string, previousSessionIds: string[] = []): SessionSummary => ({ id, file: `/saved/${id}.jsonl`, cwd: "/project", title: null, createdAt: 0, updatedAt: 0, parentSession: null, preview: null, archived: false, previousSessionIds });
beforeEach(async () => {
	fake.root = await mkdtemp(join(tmpdir(), "vomp-pins-"));
	fake.legacy = undefined;
	fake.rpc.mockReset();
	fake.finish.mockClear();
});
afterEach(async () => { await rm(fake.root, { recursive: true, force: true }); });

describe("omp session pins", () => {
	it("reads omp's global id array and ignores non-string values", async () => {
		expect(await loadPinnedSessionIds()).toEqual(new Set());
		await writeFile(join(fake.root, "session-pins.json"), JSON.stringify(["one", 3, null, "one", "two"]));
		expect(await loadPinnedSessionIds()).toEqual(new Set(["one", "two"]));
	});
	it("accepts only a consumed builtin with omp's confirmed pin state", async () => {
		fake.rpc.mockImplementation(async (_cwd, _type, options) => {
			options.onMessage({ type: "command_output", text: "Session pinned to the top of the resume list." });
			return { agentInvoked: false };
		});
		expect(await toggleSessionPin("one")).toBe(true);
		fake.rpc.mockImplementation(async (_cwd, _type, options) => {
			options.onMessage({ type: "command_output", text: 'Session "missing" not found.' });
			return { agentInvoked: false };
		});
		await expect(toggleSessionPin("missing")).rejects.toThrow("not found");
		fake.rpc.mockResolvedValue({ agentInvoked: true });
		await expect(toggleSessionPin("one")).rejects.toThrow("did not confirm");
	});
	it("unpins predecessor ids along with the visible continuation", async () => {
		await writeFile(join(fake.root, "session-pins.json"), JSON.stringify(["old", "latest", "unrelated"]));
		fake.rpc.mockImplementation(async (_cwd, _type, options, params) => {
			const id = params.message.slice("/pin ".length);
			const pins = await loadPinnedSessionIds();
			pins.delete(id);
			await writeFile(join(fake.root, "session-pins.json"), JSON.stringify([...pins]));
			options.onMessage({ type: "command_output", text: "Session unpinned." });
			return { agentInvoked: false };
		});
		expect(await toggleConversationPin(summary("latest", ["old"]))).toBe(false);
		expect(await loadPinnedSessionIds()).toEqual(new Set(["unrelated"]));
	});
	it("migrates once without unpinning existing or duplicate continuation pins", async () => {
		fake.legacy = ["already", "old", "latest", "deleted"];
		await writeFile(join(fake.root, "session-pins.json"), JSON.stringify(["already", "terminal"]));
		fake.rpc.mockImplementation(async (_cwd, _type, options) => {
			const pins = await loadPinnedSessionIds(); pins.add("latest");
			await writeFile(join(fake.root, "session-pins.json"), JSON.stringify([...pins]));
			options.onMessage({ type: "command_output", text: "Session pinned to the top of the resume list." });
			return { agentInvoked: false };
		});
		await Promise.all([migrateSessionPins([summary("already"), summary("latest", ["old"])]), migrateSessionPins([summary("latest", ["old"])])]);
		expect(await loadPinnedSessionIds()).toEqual(new Set(["already", "terminal", "latest"]));
		expect(fake.rpc).toHaveBeenCalledTimes(1);
		expect(fake.finish).toHaveBeenCalledTimes(1);
		await migrateSessionPins([summary("latest")]);
		expect(fake.rpc).toHaveBeenCalledTimes(1);
	});
	it("retains the legacy migration after failure and resumes without undoing a completed pin", async () => {
		fake.legacy = ["one", "two"];
		await writeFile(join(fake.root, "session-pins.json"), JSON.stringify(["one"]));
		fake.rpc.mockRejectedValue(new Error("omp stopped"));
		await expect(migrateSessionPins([summary("one"), summary("two")])).rejects.toThrow("omp stopped");
		expect(fake.legacy).toEqual(["one", "two"]);
		expect(JSON.parse(await readFile(join(fake.root, "session-pins.json"), "utf8"))).toEqual(["one"]);
	});
	it("accepts imported underscore ids and rejects delimiters or oversized ids before RPC", async () => {
		fake.rpc.mockImplementation(async (_cwd, _type, options) => {
			options.onMessage({ type: "command_output", text: "Session pinned to the top of the resume list." });
			return { agentInvoked: false };
		});
		expect(await toggleSessionPin("imported_chat-1")).toBe(true);
		for (const id of ["bad/id", "bad\nid", "", "a".repeat(129)]) await expect(toggleSessionPin(id)).rejects.toThrow("valid omp session id");
		expect(fake.rpc).toHaveBeenCalledTimes(1);
	});
});
