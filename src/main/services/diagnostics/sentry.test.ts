import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsLog, type DiagnosticEvent } from "./log";
import { diagnosticInstallId, redactHome, sentryEndpoints, sentryEnvelope, SentrySender, type SenderOptions } from "./sentry";

const folders: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
const dsn = "https://publickey@o123.ingest.sentry.io/456";
const gone = { event: "renderer-gone", windowId: 1, reason: "oom", exitCode: -1, reload: true } as const;
async function fixture(extra: Partial<SenderOptions> = {}) {
	const folder = await mkdtemp(join(tmpdir(), "vomp-sentry-"));
	folders.push(folder);
	const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
	const log = new DiagnosticsLog(join(folder, "diagnostics.log"));
	const sender = new SentrySender({
		dsn, packaged: true, developmentOverride: false, enabled: true, version: "0.7.7", platform: "win32", arch: "x64",
		transport: "tsp", classic: false, home: "C:\\Users\\person", installId: Promise.resolve("0123456789abcdef0123456789abcdef"), log, fetch, ...extra,
	});
	return { folder, sender, fetch, log };
}

describe("Sentry wire format and privacy", () => {
	it("derives public ingestion endpoints with optional self-hosted path prefixes", () => {
		expect(sentryEndpoints(dsn)).toEqual({ key: "publickey", envelope: "https://o123.ingest.sentry.io/api/456/envelope/", minidump: "https://o123.ingest.sentry.io/api/456/minidump/?sentry_key=publickey" });
		expect(sentryEndpoints("https://abc@sentry.example/prefix/42")?.envelope).toBe("https://sentry.example/prefix/api/42/envelope/");
	});
	it.each(["", "invalid", "http://abc@example.com/1", "https://abc:secret@example.com/1", "https://abc@example.com/no-project", "https://example.com/1", "https://abc@example.com/1?token=secret"])("rejects invalid DSN %s", input => {
		expect(sentryEndpoints(input)).toBeNull();
	});
	it("redacts home paths case-insensitively in POSIX and Windows forms, including nested values", () => {
		expect(redactHome("/Users/person/log /Users/person/file", "/Users/person")).toBe("~/log ~/file");
		expect(redactHome("C:\\Users\\Person\\file C:/Users/person/file", "C:\\Users\\person")).toBe("~\\file ~/file");
		const envelope = sentryEnvelope({ event_id: "abc", message: "C:\\Users\\person\\file", extra: { files: ["C:/Users/person/file"] } }, "C:\\Users\\person");
		expect(envelope).not.toContain("person");
		const [header, item, payload] = envelope.trimEnd().split("\n");
		expect(JSON.parse(header!)).toMatchObject({ event_id: "abc" });
		expect(JSON.parse(item!)).toEqual({ type: "event", content_type: "application/json", length: Buffer.byteLength(payload!) });
		expect(JSON.parse(payload!)).toMatchObject({ message: "~\\file", extra: { files: ["~/file"] } });
	});
	it("posts only schema-filtered event data, release tags, random installation id and a bounded log", async () => {
		const { sender, fetch, log } = await fixture();
		log.write({ event: "renderer-visibility", windowId: 1, state: "hidden" });
		sender.capture({ ...gone, prompt: "SECRET", token: "PRIVATE" } as DiagnosticEvent);
		await sender.flush();
		expect(fetch).toHaveBeenCalledOnce();
		const [url, request] = fetch.mock.calls[0]!;
		expect(url).toBe("https://o123.ingest.sentry.io/api/456/envelope/");
		expect(request.headers["X-Sentry-Auth"]).toBe("Sentry sentry_version=7, sentry_key=publickey, sentry_client=visual-omp/0.7.7");
		const payload = JSON.parse(request.body.trimEnd().split("\n")[2]);
		expect(payload).toMatchObject({ release: "visual-omp@0.7.7", environment: "production", user: { id: "0123456789abcdef0123456789abcdef" }, tags: { platform: "win32", arch: "x64", transport: "tsp", classic: "false" } });
		expect(payload.extra.diagnostics).toContain("renderer-visibility");
		expect(request.body).not.toMatch(/SECRET|PRIVATE|ip_address|environmentVariables/);
	});
	it("persists an installation id unrelated to profile location", async () => {
		const { folder } = await fixture();
		const file = join(folder, "id");
		const first = await diagnosticInstallId(file);
		expect(first).toMatch(/^[a-f0-9]{32}$/);
		expect(await diagnosticInstallId(file)).toBe(first);
	});
});

describe("Sentry sending boundaries", () => {
	it.each([{ enabled: false }, { dsn: "" }, { packaged: false, developmentOverride: false }])("keeps reporting off for %j", async options => {
		const { sender, fetch } = await fixture(options);
		sender.capture(gone);
		await sender.flush();
		expect(fetch).not.toHaveBeenCalled();
	});
	it("allows an explicit development endpoint and follows the switch immediately", async () => {
		const { sender, fetch } = await fixture({ packaged: false, developmentOverride: true, enabled: false });
		sender.capture(gone);
		sender.setEnabled(true);
		sender.capture(gone);
		await sender.flush();
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch.mock.calls[0]![1].body).toContain('"environment":"development"');
		sender.setEnabled(false);
		sender.capture({ ...gone, reason: "crashed" });
		await sender.flush();
		expect(fetch).toHaveBeenCalledOnce();
	});
	it("cancels a pending report when the switch turns off", async () => {
		const { sender, fetch } = await fixture();
		const { promise: pending, resolve: unblock } = Promise.withResolvers<void>();
		fetch.mockImplementation(async (_url: unknown, request: RequestInit) => { await pending; if (request.signal?.aborted) throw new Error("aborted"); return { ok: true, status: 200 }; });
		sender.capture(gone);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		sender.setEnabled(false);
		expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true);
		unblock();
		await sender.flush();
	});
	it("sends only long stalls and abnormal failures, not ordinary events or clean exits", async () => {
		const { sender, fetch } = await fixture();
		sender.capture({ event: "window-responsive", windowId: 1, durationMs: 9999 });
		sender.capture({ event: "window-responsive", windowId: 1, durationMs: null });
		sender.capture({ event: "renderer-visibility", windowId: 1, state: "hidden" });
		sender.capture({ ...gone, reason: "clean-exit" });
		await sender.flush();
		expect(fetch).not.toHaveBeenCalled();
		sender.capture({ event: "window-responsive", windowId: 1, durationMs: 10_000, recovered: true });
		await sender.flush();
		expect(fetch).toHaveBeenCalledOnce();
	});
	it("deduplicates identical failures and caps distinct events at ten per hour", async () => {
		let now = 100;
		const { sender, fetch } = await fixture({ now: () => now });
		sender.capture(gone);
		sender.capture({ ...gone, windowId: 5, reload: false });
		await sender.flush();
		for (let exitCode = 1; exitCode < 15; exitCode++) {
			sender.capture({ ...gone, exitCode });
			await sender.flush();
		}
		expect(fetch).toHaveBeenCalledTimes(10);
		now += 3600_000;
		sender.capture(gone);
		await sender.flush();
		expect(fetch).toHaveBeenCalledTimes(11);
	});
	it("keeps HTTP and network failures local, without retries or response text", async () => {
		const { sender, fetch, log } = await fixture();
		fetch.mockResolvedValueOnce({ ok: false, status: 429 }).mockRejectedValueOnce(new Error("private response"));
		sender.capture(gone);
		sender.capture({ ...gone, reason: "crashed" });
		await sender.flush();
		const text = await log.recent();
		expect(text).toContain('"outcome":"failed","status":429');
		expect(text).toContain('"outcome":"failed","status":null');
		expect(text).not.toContain("private response");
		expect(fetch).toHaveBeenCalledTimes(2);
	});
	it.each(["log", "install-id"] as const)("bounds preparation when %s never settles and never sends after late fulfillment", async stalled => {
		const { sender, fetch, log } = await fixture();
		const { promise, resolve } = Promise.withResolvers<string>();
		if (stalled === "log") vi.spyOn(log, "recent").mockReturnValue(promise);
		else sender.options.installId = promise;
		vi.useFakeTimers();
		sender.capture(gone);
		await vi.advanceTimersByTimeAsync(1500);
		await sender.flush();
		expect(fetch).not.toHaveBeenCalled();
		resolve(stalled === "log" ? "" : "0123456789abcdef0123456789abcdef");
		await vi.advanceTimersByTimeAsync(0);
		expect(fetch).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		await log.flush();
	});
	it("limits in-flight report preparation to three independently of the hourly budget", async () => {
		const { sender, log } = await fixture();
		const recent = vi.spyOn(log, "recent").mockReturnValue(Promise.withResolvers<string>().promise);
		vi.useFakeTimers();
		for (let exitCode = 1; exitCode <= 8; exitCode++) sender.capture({ ...gone, exitCode });
		expect(recent).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(1500);
		await sender.flush();
		sender.capture({ ...gone, exitCode: 9 });
		expect(recent).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(1500);
		await sender.flush();
		await log.flush();
	});
	it("settles a never-ending network request within five seconds even if fetch ignores abort", async () => {
		const { sender, fetch, log } = await fixture();
		vi.spyOn(log, "recent").mockResolvedValue("");
		fetch.mockReturnValue(Promise.withResolvers<Response>().promise);
		vi.useFakeTimers();
		sender.capture(gone);
		await vi.advanceTimersByTimeAsync(5000);
		await sender.flush();
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		await log.flush();
	});
});
