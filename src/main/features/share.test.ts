import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "./share";

const fake = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
	run: vi.fn(),
	resolveSession: vi.fn(),
	save: vi.fn(),
	open: vi.fn(),
}));
vi.mock("electron", () => ({
	app: { getPath: () => "downloads" },
	BrowserWindow: { getFocusedWindow: () => null },
	dialog: { showSaveDialog: (...args: unknown[]) => fake.save(...args), showOpenDialog: (...args: unknown[]) => fake.open(...args) },
}));
vi.mock("../ipc", () => ({ handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => fake.handlers.set(channel, handler) }));
vi.mock("../omp/cli", () => ({ runOmp: (...args: unknown[]) => fake.run(...args) }));
vi.mock("../omp/sessions", () => ({ allSessions: async () => [], resolveSessionFile: (file: string) => fake.resolveSession(file) }));
vi.mock("../env", () => ({ userEnv: async () => ({}) }));

register();
const call = (channel: string, ...args: unknown[]) => fake.handlers.get(channel)!(...args);
const oldFile = join(tmpdir(), "share-regression", "old.jsonl");
const newestFile = join(tmpdir(), "share-regression", "newest.jsonl");
const archive = join(tmpdir(), "share-regression", "archive with spaces.tar");
const folder = join(tmpdir(), "share-regression", "project folder");

beforeEach(() => {
	vi.resetAllMocks();
	fake.resolveSession.mockResolvedValue(newestFile);
	fake.save.mockResolvedValue({ canceled: false, filePath: archive });
	fake.open.mockResolvedValue({ canceled: false, filePaths: [folder] });
	fake.run.mockResolvedValue({ code: 0, stdout: `${archive}\n`, stderr: "" });
});

describe("session archive sharing", () => {
	it("resolves the newest linked session and uses the exact pack CLI with a native save path", async () => {
		fake.run.mockResolvedValue({ code: 0, stdout: `${archive}\n`, stderr: "warning: 2 referenced blob(s) are missing\n" });
		await expect(call("share:pack", oldFile)).resolves.toEqual({ path: archive, report: "warning: 2 referenced blob(s) are missing" });
		expect(fake.resolveSession).toHaveBeenCalledWith(oldFile);
		expect(fake.save).toHaveBeenCalledWith(expect.objectContaining({ filters: [{ name: "omp session archive", extensions: ["tar"] }] }));
		expect(fake.run).toHaveBeenCalledWith(["session", "pack", newestFile, archive], { timeoutMs: 180_000 });
	});

	it("does not run pack after the Save dialog is cancelled", async () => {
		fake.save.mockResolvedValue({ canceled: true });
		await expect(call("share:pack", oldFile)).resolves.toBeNull();
		expect(fake.run).not.toHaveBeenCalled();
	});

	it("chooses an archive and a project before unpacking and retains omp's copy outcome", async () => {
		fake.open.mockResolvedValueOnce({ canceled: false, filePaths: [archive] }).mockResolvedValueOnce({ canceled: false, filePaths: [folder] });
		fake.run.mockResolvedValue({ code: 0, stdout: `${newestFile}\n`, stderr: "The local copy of this session diverged; unpacked as a fork (id).\n" });
		await expect(call("share:unpack")).resolves.toEqual({ path: newestFile, report: "The local copy of this session diverged; unpacked as a fork (id)." });
		expect(fake.run).toHaveBeenCalledWith(["session", "unpack", archive, "--cwd", folder], { timeoutMs: 180_000 });
		expect(fake.resolveSession).not.toHaveBeenCalled();
	});

	it.each(["archive", "folder"])("does not unpack when the %s chooser is cancelled", async stage => {
		if (stage === "folder") fake.open.mockResolvedValueOnce({ canceled: false, filePaths: [archive] });
		fake.open.mockResolvedValueOnce({ canceled: true, filePaths: [] });
		await expect(call("share:unpack")).resolves.toBeNull();
		expect(fake.open).toHaveBeenCalledTimes(stage === "folder" ? 2 : 1);
		expect(fake.run).not.toHaveBeenCalled();
	});

	it("reports omp's ownership refusal without claiming the output path was written", async () => {
		fake.run.mockResolvedValue({ code: 1, stdout: `${archive}\n`, stderr: "Cannot pack: another live omp process writes this session." });
		await expect(call("share:pack", oldFile)).rejects.toThrow("another live omp process");
	});

	it.each(["", "Finished", "relative.tar", "first.tar\nsecond.tar"])("rejects unconfirmed pack output %j", async stdout => {
		fake.run.mockResolvedValue({ code: 0, stdout, stderr: "" });
		await expect(call("share:pack", oldFile)).rejects.toThrow();
	});
});

describe("anonymized copies", () => {
	it("uses anonymize <newest session> -o <chosen directory> and retains review and partial-export details", async () => {
		const stdout = `Anonymized 2 transcripts → ${folder}\nSkipped 1 malformed record in session.jsonl\nReview before sharing.\n`;
		fake.run.mockResolvedValue({ code: 0, stdout, stderr: "" });
		await expect(call("share:anonymize", oldFile)).resolves.toEqual({ path: folder, transcriptCount: 2, report: stdout.trim() });
		expect(fake.run).toHaveBeenCalledWith(["anonymize", newestFile, "-o", folder], { timeoutMs: 180_000 });
		expect(fake.open).toHaveBeenCalledWith(expect.objectContaining({ properties: ["openDirectory", "createDirectory"] }));
	});

	it("returns null without a command when the folder chooser is cancelled", async () => {
		fake.open.mockResolvedValue({ canceled: true, filePaths: [] });
		await expect(call("share:anonymize", oldFile)).resolves.toBeNull();
		expect(fake.run).not.toHaveBeenCalled();
	});

	it("retains omp's refusal for a nonempty output folder", async () => {
		fake.run.mockResolvedValue({ code: 2, stdout: "", stderr: "Output is not empty; choose a new or empty directory" });
		await expect(call("share:anonymize", oldFile)).rejects.toThrow("not empty");
	});

	it("does not invent a path after exit zero without the completion line", async () => {
		fake.run.mockResolvedValue({ code: 0, stdout: "Review before sharing.", stderr: "" });
		await expect(call("share:anonymize", oldFile)).rejects.toThrow("Review before sharing");
	});
});

describe("linked saved sessions", () => {
	it("resolves linked sessions for existing link and HTML operations too", async () => {
		fake.run.mockResolvedValueOnce({ code: 0, stdout: "Share URL: https://share.omp.sh/s/id#key\n", stderr: "" });
		await call("share:link", oldFile, { gist: true });
		expect(fake.run).toHaveBeenLastCalledWith(["share", newestFile, "--gist"], { timeoutMs: 180_000 });
		const html = resolve("out.html");
		fake.run.mockResolvedValueOnce({ code: 0, stdout: `Exported to: ${html}\n`, stderr: "" });
		await expect(call("share:exportHtml", oldFile, html)).resolves.toBe(html);
		expect(fake.run).toHaveBeenLastCalledWith(["--export", newestFile, html], { timeoutMs: 180_000 });
	});

	it("propagates failed resolution before offering a destination or invoking omp", async () => {
		fake.resolveSession.mockRejectedValue(new Error("Session link could not be resolved"));
		await expect(call("share:pack", oldFile)).rejects.toThrow("could not be resolved");
		expect(fake.save).not.toHaveBeenCalled();
		expect(fake.run).not.toHaveBeenCalled();
	});
});
