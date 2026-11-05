import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeSkillFile } from "../features/skills/parse";
import { VISUAL_PROOFS_SKILL, VisualProofsService } from "./visual-proofs";

vi.mock("../omp/config-file", () => ({ ompAgentDir: async () => process.env.PI_CODING_AGENT_DIR }));

let root: string;
let file: string;
let enabled: boolean;
const availability = vi.fn<() => Promise<"skillsDisabled" | "ignored" | null>>();
const changed = vi.fn();
let service: VisualProofsService;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "vomp-proofs-"));
	file = join(root, "skills", "visual-proofs", "SKILL.md");
	enabled = false;
	availability.mockReset().mockResolvedValue(null);
	changed.mockReset();
	service = new VisualProofsService({ agentDir: async () => root, availability, changed, getEnabled: () => enabled, setEnabled: next => { enabled = next; } });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

async function save(content: string) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, content); }

describe("managed visual-proofs skill", () => {
	it("defaults off and adds/removes only its SKILL.md through opt-in", async () => {
		expect(await service.status()).toEqual({ state: "off" });
		expect(await service.set(true)).toEqual({ state: "on" });
		expect(enabled).toBe(true);
		expect(await readFile(file, "utf8")).toBe(VISUAL_PROOFS_SKILL);
		expect(await readdir(dirname(file))).toEqual(["SKILL.md"]);
		await writeFile(join(dirname(file), "personal.txt"), "Keep this file.");
		expect(await service.set(false)).toEqual({ state: "off" });
		expect(enabled).toBe(false);
		expect(await readdir(dirname(file))).toEqual(["personal.txt"]);
		expect(changed).toHaveBeenCalledTimes(2);
	});

	it.each(["", "# My skill\nmanaged-by: visual-omp", "---\nname: visual-proofs\ndescription: My own proof workflow.\n---\nKeep this."])("leaves unowned content unchanged (%j)", async content => {
		await save(content);
		expect(await service.set(true)).toEqual({ state: "conflict", path: file });
		expect(await service.set(false)).toEqual({ state: "conflict", path: file });
		expect(await readFile(file, "utf8")).toBe(content);
		expect(enabled).toBe(false);
		expect(changed).not.toHaveBeenCalled();
	});

	it("repairs an old managed version and a missing skill on opted-in startup", async () => {
		enabled = true;
		await save(VISUAL_PROOFS_SKILL.replace("managed-version: 1", "managed-version: 0"));
		expect(await service.status()).toEqual({ state: "outdated" });
		expect(await service.sync()).toEqual({ state: "on" });
		expect(await readFile(file, "utf8")).toBe(VISUAL_PROOFS_SKILL);
		await rm(file);
		expect(await service.sync()).toEqual({ state: "on" });
		expect(await readFile(file, "utf8")).toBe(VISUAL_PROOFS_SKILL);
	});

	it("updates an opted-in older file on startup even when omp currently filters it", async () => {
		enabled = true;
		availability.mockResolvedValue("ignored");
		await save(VISUAL_PROOFS_SKILL.replace("managed-version: 1", "managed-version: 0"));
		expect(await service.sync()).toEqual({ state: "unavailable", reason: "ignored" });
		expect(await readFile(file, "utf8")).toBe(VISUAL_PROOFS_SKILL);
		expect(enabled).toBe(true);
	});

	it.each(["null", ".inf", "unknown", "1.5"])("repairs a malformed managed version %s", async version => {
		enabled = true;
		await save(VISUAL_PROOFS_SKILL.replace("managed-version: 1", `managed-version: ${version}`));
		expect(await service.status()).toEqual({ state: "outdated" });
		expect(await service.sync()).toEqual({ state: "on" });
		expect(await readFile(file, "utf8")).toBe(VISUAL_PROOFS_SKILL);
	});

	it("does not downgrade a newer managed skill or touch one when startup is off", async () => {
		const newer = VISUAL_PROOFS_SKILL.replace("managed-version: 1", "managed-version: 2");
		await save(newer);
		expect(await service.sync()).toEqual({ state: "off" });
		expect(await service.set(true)).toEqual({ state: "on" });
		expect(await readFile(file, "utf8")).toBe(newer);
		expect(changed).not.toHaveBeenCalled();
	});

	it.each(["skillsDisabled", "ignored"] as const)("reports %s without changing omp's settings or enabling the preference", async reason => {
		availability.mockResolvedValue(reason);
		expect(await service.set(true)).toEqual({ state: "unavailable", reason });
		expect(enabled).toBe(false);
		await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
		expect(changed).not.toHaveBeenCalled();
	});

	it("reports filters changed after opt-in and still permits removing the managed file", async () => {
		await service.set(true);
		availability.mockResolvedValue("ignored");
		expect(await service.status()).toEqual({ state: "unavailable", reason: "ignored" });
		expect(await service.set(false)).toEqual({ state: "off" });
	});

	it("persists off after status detects a personal replacement and does not reinstall after it moves", async () => {
		await service.set(true);
		const personal = "---\nname: visual-proofs\ndescription: My own proof workflow.\n---\nKeep this file.\n";
		await writeFile(file, personal);
		expect(await service.status()).toEqual({ state: "conflict", path: file });
		expect(enabled).toBe(false);
		expect(await readFile(file, "utf8")).toBe(personal);
		await rename(file, `${file}.personal`);
		expect(await service.status()).toEqual({ state: "off" });
		const restarted = new VisualProofsService({
			agentDir: async () => root, availability, changed,
			getEnabled: () => enabled, setEnabled: next => { enabled = next; },
		});
		expect(await restarted.sync()).toEqual({ state: "off" });
		await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(`${file}.personal`, "utf8")).toBe(personal);
	});

	it("preserves a hand-written replacement made while availability is checked", async () => {
		await save(VISUAL_PROOFS_SKILL.replace("managed-version: 1", "managed-version: 0"));
		availability.mockImplementation(async () => { await writeFile(file, "My replacement skill."); return null; });
		expect(await service.set(true)).toEqual({ state: "conflict", path: file });
		expect(await readFile(file, "utf8")).toBe("My replacement skill.");
		expect(await readdir(dirname(file))).toEqual(["SKILL.md"]);
		expect(enabled).toBe(false);
	});

	it("rejects linked files and directories without changing their targets", async () => {
		const target = join(root, "personal.md");
		await writeFile(target, VISUAL_PROOFS_SKILL);
		await mkdir(dirname(file), { recursive: true });
		await symlink(target, file);
		expect(await service.set(false)).toEqual({ state: "unavailable", reason: "unreadable" });
		await rm(dirname(file), { recursive: true });
		const folder = join(root, "personal");
		await mkdir(folder);
		await writeFile(join(folder, "SKILL.md"), VISUAL_PROOFS_SKILL);
		await symlink(folder, dirname(file), process.platform === "win32" ? "junction" : "dir");
		expect(await service.set(true)).toEqual({ state: "unavailable", reason: "unreadable" });
		expect(await readFile(target, "utf8")).toBe(VISUAL_PROOFS_SKILL);
		expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe(VISUAL_PROOFS_SKILL);
	});

	it("honors the resolved omp agent directory through the existing resolver", async () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", root);
		const resolved = new VisualProofsService({ availability, changed, getEnabled: () => enabled, setEnabled: next => { enabled = next; } });
		expect(await resolved.set(true)).toEqual({ state: "on" });
		expect(await readFile(file, "utf8")).toBe(VISUAL_PROOFS_SKILL);
	});

	it("serializes overlapping changes and rejects malformed requests", async () => {
		expect(await Promise.all([service.set(true), service.set(false)])).toEqual([{ state: "on" }, { state: "off" }]);
		expect(enabled).toBe(false);
		await expect(service.set("yes" as unknown as boolean)).rejects.toThrow("boolean");
	});

	it("has valid native skill metadata and a mandatory, fail-closed wait", () => {
		const parsed = analyzeSkillFile(VISUAL_PROOFS_SKILL, "visual-proofs", "native");
		expect(parsed.issues).toEqual([]);
		expect(parsed.frontmatter).toMatchObject({ name: "visual-proofs", "managed-by": "visual-omp", "managed-version": 1 });
		expect(parsed.body).toContain("The proof is ready. Continue with the full render?");
		expect(parsed.body).toContain("Continue only after an explicit Yes");
		expect(parsed.body).toContain("Do not launch that work in parallel");
		expect(parsed.body).toContain("Print each proof's absolute path");
		expect(parsed.body).not.toMatch(/[\u2013\u2014]/);
	});
});
