import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfficePreviewService } from "./preview-office";
import type { OfficeConversionRuntime } from "./preview-office-runtime";
import { OFFICE_LIMITS } from "@shared/preview-office-zip";

vi.mock("electron", () => ({ app: { on: vi.fn(), getPath: vi.fn() } }));
vi.mock("../ipc", () => ({ handleWithEvent: vi.fn() }));
vi.mock("./preview-protocol", () => ({ hasPreviewGrant: vi.fn(), onPreviewRevoke: vi.fn(), readPreviewBinary: vi.fn() }));
vi.mock("./preview-office-runtime", () => ({ officeRuntime: {} }));
const token = "a".repeat(48), other = "b".repeat(48), third = "c".repeat(48);
let folder: string, service: OfficePreviewService, runtime: OfficeConversionRuntime;
let current: Set<string>;
const read = vi.fn();
beforeEach(async () => {
	folder = await mkdtemp(join(tmpdir(), "vomp-office-test-")); current = new Set([token, other, third]);
	runtime = { detect: vi.fn(async () => "/scratch/soffice"), rewrite: vi.fn(async bytes => bytes), convert: vi.fn(async (_exe, input, out) => {
		expect(await readFile(input)).toEqual(Buffer.from([1, 2, 3]));
		await writeFile(join(out, "input.pdf"), "%PDF-1.7\nfixture\n%%EOF\n"); return true;
	}) };
	read.mockReset().mockImplementation(async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3]), size: 3, mtimeMs: 1 }));
	service = new OfficePreviewService({ root: async () => folder, active: (value, owner) => current.has(value) && owner === null, read, runtime });
});
afterEach(async () => { service.close(); vi.useRealTimers(); await rm(folder, { recursive: true, force: true }); });

describe("LibreOffice slide snapshots", () => {
	it("converts only rewritten snapshot bytes in a private revision directory and removes the input", async () => {
		const result = await service.request(token, 3);
		expect(result).toEqual({ ok: true, pdfPath: join(folder, "slides", token, "3", "input.pdf"), revision: 3 });
		expect(runtime.rewrite).toHaveBeenCalledOnce();
		expect(runtime.convert).toHaveBeenCalledWith("/scratch/soffice", join(folder, "slides", token, "3", "input.pptx"), join(folder, "slides", token, "3"), join(folder, "lo-profile"), expect.any(AbortSignal));
		await expect(stat(join(folder, "slides", token, "3", "input.pptx"))).rejects.toThrow();
		expect(await service.request(token, 3)).toEqual(result);
		expect(runtime.convert).toHaveBeenCalledOnce();
	});
	it("reports an absent LibreOffice without spawning a process", async () => {
		vi.mocked(runtime.detect).mockResolvedValue(null);
		expect(await service.tools()).toEqual({ libreOffice: false });
		expect(await service.request(token, 1)).toEqual({ ok: false, reason: "noLibreOffice" });
		expect(runtime.convert).not.toHaveBeenCalled();
	});
	it("fails closed for unsafe packages and non-owned grants", async () => {
		vi.mocked(runtime.rewrite).mockRejectedValue(new Error("unsafe"));
		expect(await service.request(token, 1)).toEqual({ ok: false, reason: "unsafe" });
		expect(runtime.convert).not.toHaveBeenCalled();
		expect(await service.request(token, 2, 10)).toEqual({ ok: false, reason: "revoked" });
		expect(await service.request("../escape", 2)).toEqual({ ok: false, reason: "revoked" });
	});
	it("keeps only the newest queued request while another subject converts", async () => {
		const gate = Promise.withResolvers<boolean>();
		vi.mocked(runtime.convert).mockImplementationOnce(async (_exe, _input, out) => { await gate.promise; await writeFile(join(out, "input.pdf"), "%PDF-1.7\n%%EOF\n"); return true; });
		const first = service.request(token, 1);
		await vi.waitFor(() => expect(runtime.convert).toHaveBeenCalledOnce());
		const replaced = service.request(other, 1), latest = service.request(third, 2);
		expect(await replaced).toEqual({ ok: false, reason: "revoked" });
		gate.resolve(true); await first;
		expect((await latest).ok).toBe(true);
		expect(runtime.convert).toHaveBeenCalledTimes(2);
	});
	it("aborts a stale active conversion and publishes only the new revision", async () => {
		vi.mocked(runtime.convert).mockImplementationOnce(async (_exe, _input, _out, _profile, signal) => {
			const done = Promise.withResolvers<boolean>(); signal.addEventListener("abort", () => done.resolve(false)); return done.promise;
		});
		const first = service.request(token, 1);
		await vi.waitFor(() => expect(runtime.convert).toHaveBeenCalledOnce());
		const next = service.request(token, 2);
		expect(await first).toEqual({ ok: false, reason: "revoked" });
		expect(await next).toMatchObject({ ok: true, revision: 2 });
		expect(await service.request(token, 1)).toEqual({ ok: false, reason: "revoked" });
		await expect(stat(join(folder, "slides", token, "1"))).rejects.toThrow();
	});
	it("times out after 60 seconds, aborts the process interface and deletes partial output", async () => {
		vi.useFakeTimers();
		vi.mocked(runtime.convert).mockImplementationOnce(async (_exe, _input, _out, _profile, signal) => {
			const done = Promise.withResolvers<boolean>(); signal.addEventListener("abort", () => done.resolve(false)); return done.promise;
		});
		const pending = service.request(token, 1);
		await vi.waitFor(() => expect(runtime.convert).toHaveBeenCalledOnce());
		await vi.advanceTimersByTimeAsync(60_000);
		expect(await pending).toEqual({ ok: false, reason: "timeout" });
		await expect(stat(join(folder, "slides", token, "1"))).rejects.toThrow();
	});
	it("rejects input and output over 32 MiB", async () => {
		read.mockResolvedValueOnce({ ok: false, reason: "tooLarge" });
		expect(await service.request(token, 1)).toEqual({ ok: false, reason: "tooLarge" });
		vi.mocked(runtime.convert).mockImplementationOnce(async (_exe, _input, out) => { await writeFile(join(out, "input.pdf"), new Uint8Array(OFFICE_LIMITS.input + 1)); return true; });
		expect(await service.request(token, 2)).toEqual({ ok: false, reason: "tooLarge" });
	});
	it("removes completed PDFs when the grant is revoked", async () => {
		const result = await service.request(token, 1); expect(result.ok).toBe(true);
		current.delete(token); service.revoke(token);
		await vi.waitFor(async () => { await expect(stat(join(folder, "slides", token))).rejects.toThrow(); });
		expect(await service.request(token, 2)).toEqual({ ok: false, reason: "revoked" });
	});
});

it("quarantines the shared profile after uncertain teardown and settles queued requests", async () => {
	const { OfficeTeardownError } = await import("./preview-office-process");
	vi.mocked(runtime.convert).mockImplementationOnce(async (_exe, _input, _out, _profile, signal) => {
		const done = Promise.withResolvers<boolean>();
		signal.addEventListener("abort", () => done.reject(new OfficeTeardownError()));
		return done.promise;
	});
	const first = service.request(token, 1);
	await vi.waitFor(() => expect(runtime.convert).toHaveBeenCalledOnce());
	const queued = service.request(token, 2);
	expect(await first).toEqual({ ok: false, reason: "converterUnavailable" });
	expect(await queued).toEqual({ ok: false, reason: "converterUnavailable" });
	expect(await service.request(other, 1)).toEqual({ ok: false, reason: "converterUnavailable" });
	expect(runtime.convert).toHaveBeenCalledOnce();
});
