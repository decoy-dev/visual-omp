import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, open, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { constants } from "node:fs";
import type { ReadStream } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { PreviewGrant } from "@shared/contracts/preview";

const electron = vi.hoisted(() => ({
	ready: false,
	whenReady: vi.fn(),
	handle: vi.fn(),
	schemes: vi.fn(),
	ipc: new Map<string, (...args: unknown[]) => unknown>(),
	isolationFile: "",
	rejectIsolationRead: false,
}));
vi.mock("electron", () => ({
	app: { isReady: () => electron.ready, whenReady: electron.whenReady },
	protocol: { handle: electron.handle, registerSchemesAsPrivileged: electron.schemes },
}));
vi.mock("../ipc", () => ({ handleWithEvent: (channel: string, handler: (...args: unknown[]) => unknown) => electron.ipc.set(channel, handler) }));
vi.mock("./preview-isolation-test", () => ({ isIsolationTestDocument: (path: string, saved: boolean, read?: unknown) => saved && electron.isolationFile === path && (!read || !electron.rejectIsolationRead) }));

const files = vi.hoisted(() => ({
	afterOpen: null as ((file: FileHandle, path: unknown, flags: unknown) => Promise<void> | void) | null,
	onOpen: null as ((file: FileHandle) => Promise<void> | void) | null,
	openCalls: 0,
	openError: null as Error | null,
}));
vi.mock("node:fs/promises", async importOriginal => {
	const actual = await importOriginal<typeof FsPromises>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			files.openCalls++;
			if (files.openError) throw files.openError;
			const file = await actual.open(...args);
			await files.onOpen?.(file);
			const afterOpen = files.afterOpen;
			files.afterOpen = null;
			await afterOpen?.(file, args[0], args[1]);
			return file;
		},
	};
});

import {
	grantPreview, handlePreviewRequest, previewPolicy, previewDocumentUrl, previewNavigationRule, preparePreview,
	registerPreviewProtocol, registerPreviewScheme, revokeAllPreviews, revokePreview, savePreview, setPreviewLive,
} from "./preview-protocol";

let folder: string;
const cleanup: string[] = [];
beforeEach(async () => {
	folder = await mkdtemp(join(tmpdir(), "vomp-protocol-"));
	electron.isolationFile = "";
	electron.rejectIsolationRead = false;
	cleanup.push(folder);
});
afterEach(async () => {
	files.afterOpen = null;
	files.onOpen = null;
	files.openError = null;
	revokeAllPreviews();
	await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function page(path = join(folder, "index.html"), root: string | null = folder, related: string[] = []) {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, "<h1>Saved</h1>");
	return grantPreview({ path, root, related });
}
async function get(url: string): Promise<Response> { return handlePreviewRequest(new Request(url)); }
// WHATWG Request normalizes dot segments before a protocol sees them. This also tests unnormalized callers.
async function raw(url: string): Promise<Response> { return handlePreviewRequest({ url, method: "GET" } as Request); }


it("enables only the explicitly gated saved fixture snapshot and keeps its network policy closed", async () => {
	const grant = await page();
	electron.isolationFile = await realpath(join(folder, "index.html"));
	setPreviewLive(grant.token, 1, "<p>Streaming fixture</p>");
	expect(await preparePreview(grant.token, 1)).toEqual({ ok: true, policy: { scripts: false, network: false } });
	expect((await get(`${grant.url}?rev=1`)).headers.get("content-security-policy")).toBe(previewPolicy({ scripts: false, network: false }));
	savePreview(grant.token);
	expect(await preparePreview(grant.token, 1)).toEqual({ ok: true, policy: { scripts: false, network: false }, isolationTest: true });
	const response = await get(`${grant.url}?rev=1`);
	expect(await response.text()).toBe("<h1>Saved</h1>");
	expect(response.headers.get("content-security-policy")).toBe(previewPolicy({ scripts: false, network: false }).replace("script-src 'none'", "script-src 'unsafe-inline'"));
	expect(response.headers.get("access-control-allow-origin")).toBeNull();
	expect((await get(grant.url)).headers.get("content-security-policy")).toBe(previewPolicy({ scripts: false, network: false }));
	const other = await page(join(folder, "other.html"));
	savePreview(other.token);
	expect(await preparePreview(other.token, 1)).toEqual({ ok: true, policy: { scripts: false, network: false } });
	expect((await get(`${other.url}?rev=1`)).headers.get("content-security-policy")).toBe(previewPolicy({ scripts: false, network: false }));
});

it("requires the opened document identity before marking a snapshot script-enabled", async () => {
	const grant = await page();
	electron.isolationFile = await realpath(join(folder, "index.html"));
	electron.rejectIsolationRead = true;
	savePreview(grant.token);
	expect(await preparePreview(grant.token, 1)).toEqual({ ok: false, reason: "notFile" });
	expect((await get(`${grant.url}?rev=1`)).status).toBe(404);
	expect((await get(grant.url)).headers.get("content-security-policy")).toBe(previewPolicy({ scripts: false, network: false }));
});

it("rejects a previously prepared script fixture when its pinned identity changes", async () => {
	const grant = await page();
	electron.isolationFile = await realpath(join(folder, "index.html"));
	savePreview(grant.token);
	expect(await preparePreview(grant.token, 1)).toEqual({ ok: true, policy: { scripts: false, network: false }, isolationTest: true });
	electron.rejectIsolationRead = true;
	expect((await get(`${grant.url}?rev=1`)).status).toBe(403);
	expect(await preparePreview(grant.token, 1)).toEqual({ ok: false, reason: "notFile" });
});
it("uses a lowercase hex token and encodes document path segments", async () => {
	const grant = await page(join(folder, "a b", "poster #1.html"));
	expect(grant.token).toMatch(/^[a-f0-9]{48}$/);
	expect(grant.url).toBe(`vomp-preview://${grant.token}/a%20b/poster%20%231.html`);
	expect(await (await get(grant.url)).text()).toBe("<h1>Saved</h1>");
});

it("chooses the chat root when contained, otherwise the subject folder", async () => {
	const grant = await page(join(folder, "pages", "index.html"));
	await writeFile(join(folder, "style.css"), "body { color: red }");
	expect(grant.assetRoot).toBe(true);
	expect(new URL("/style.css", grant.url).pathname).toBe("/style.css");
	expect((await get(new URL("/style.css", grant.url).href)).status).toBe(200);
	const separate = await mkdtemp(join(tmpdir(), "vomp-unrelated-"));
	cleanup.push(separate);
	const local = await grantPreview({ path: join(folder, "pages", "index.html"), root: separate, related: [join(folder, "style.css")] });
	expect(local.url).toBe(`vomp-preview://${local.token}/index.html`);
	expect(local.assetRoot).toBe(true);
	expect((await get(new URL("/style.css", local.url).href)).status).toBe(404);
});

it("resolves a missing subject through its existing symlinked ancestor", async () => {
	const alias = join(folder, "alias");
	const actual = join(folder, "actual");
	await mkdir(actual);
	await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
	const grant = await grantPreview({ path: join(alias, "new", "index.html"), root: folder, related: [] });
	expect(grant.url).toBe(`vomp-preview://${grant.token}/actual/new/index.html`);
	setPreviewLive(grant.token, 1, "<p>Writing</p>");
	expect(await (await get(grant.url)).text()).toBe("<p>Writing</p>");
	await mkdir(join(actual, "new"));
	await writeFile(join(actual, "new", "index.html"), "saved");
	savePreview(grant.token);
	expect(await (await get(grant.url)).text()).toBe("saved");
});

it("grants only the subject and named related files in the temporary folder", async () => {
	const name = basename(folder);
	const subject = join(tmpdir(), `${name}.html`);
	const related = join(tmpdir(), `${name}.css`);
	const secret = join(tmpdir(), `${name}-secret.css`);
	cleanup.push(subject, related, secret);
	await writeFile(related, "related");
	await writeFile(secret, "secret");
	const grant = await page(subject, tmpdir(), [related, folder]);
	expect(grant.assetRoot).toBe(false);
	expect((await get(grant.url)).status).toBe(200);
	expect(await (await get(new URL(basename(related), grant.url).href)).text()).toBe("related");
	expect((await get(new URL(basename(secret), grant.url).href)).status).toBe(403);
	await writeFile(join(folder, "nested.css"), "not named");
	expect((await get(new URL(`${name}/nested.css`, grant.url).href)).status).toBe(403);
});

it("never widens an asset root through related files", async () => {
	const outside = join(tmpdir(), `${basename(folder)}-outside.css`);
	cleanup.push(outside);
	await writeFile(outside, "outside");
	const grant = await page(undefined, folder, [outside]);
	expect((await get(new URL(basename(outside), grant.url).href)).status).toBe(404);
});

it.each(["../index.html", "%2e%2e/index.html", "sub/%2E%2E/index.html", "a%2fb.css", "a%2Fb.css", "a%5cb.css", "a\\b.css", "%00.css"])("refuses unsafe path %s", async path => {
	const grant = await page();
	expect((await raw(`vomp-preview://${grant.token}/${path}`)).status).toBe(403);
});

it("refuses symlinks leaving the root, including symlinks replaced after granting", async () => {
	const outside = await mkdtemp(join(tmpdir(), "vomp-secret-"));
	cleanup.push(outside);
	await writeFile(join(outside, "secret.css"), "secret");
	const grant = await page();
	await symlink(outside, join(folder, "escape"), process.platform === "win32" ? "junction" : "dir");
	expect((await get(new URL("escape/secret.css", grant.url).href)).status).toBe(403);
	await rm(join(folder, "index.html"));
	await symlink(join(outside, "secret.css"), join(folder, "index.html"));
	expect((await get(grant.url)).status).toBe(403);
});

it("refuses directories and unsupported scripts", async () => {
	const grant = await page();
	await mkdir(join(folder, "directory.html"));
	expect((await get(new URL("directory.html", grant.url).href)).status).toBe(403);
	for (const name of ["code.js", "module.mjs"]) {
		await writeFile(join(folder, name), "content");
		expect((await get(new URL(name, grant.url).href)).status).toBe(415);
	}
});

it.each([["large.html", 2], ["large.css", 2], ["large.svg", 2], ["large.txt", 2], ["large.png", 8], ["large.pdf", 32]] as const)("caps %s reads", async (name, mib) => {
	const grant = await page();
	const file = await open(join(folder, name), "w");
	try { await file.truncate(mib * 1024 * 1024 + 1); } finally { await file.close(); }
	expect((await get(new URL(name, grant.url).href)).status).toBe(413);
});

it("serves the newest live revision and then permanently switches to the saved file", async () => {
	const grant = await page();
	setPreviewLive(grant.token, 2, "newest");
	setPreviewLive(grant.token, 1, "older");
	setPreviewLive(grant.token, 2, "duplicate");
	expect(await preparePreview(grant.token, 1)).toEqual({ ok: true, policy: { scripts: false, network: false } });
	expect(await (await get(`${grant.url}?rev=1`)).text()).toBe("newest");
	savePreview(grant.token);
	setPreviewLive(grant.token, 3, "late stream");
	expect(await preparePreview(grant.token, 3)).toEqual({ ok: true, policy: { scripts: false, network: false } });
	expect(await (await get(`${grant.url}?rev=3`)).text()).toBe("<h1>Saved</h1>");
});

it("caps live UTF-8 bytes and preserves the last accepted revision", async () => {
	const grant = await page();
	setPreviewLive(grant.token, 1, "accepted");
	expect(() => setPreviewLive(grant.token, 2, "😀".repeat(524289))).toThrow("too large");
	expect(await (await get(grant.url)).text()).toBe("accepted");
});

it("sends the scripts-off CSP, no-store and nosniff policy without CORS permission for live and saved HTML", async () => {
	const grant = await page();
	for (const live of [true, false]) {
		if (live) setPreviewLive(grant.token, 1, "<script>fetch('https://example.com')</script>");
		else savePreview(grant.token);
		const response = await get(grant.url);
		expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(response.headers.get("content-security-policy")).toBe(previewPolicy({ scripts: false, network: false }));
		expect(previewPolicy({ scripts: false, network: false })).toContain("script-src 'none'");
		expect(previewPolicy({ scripts: false, network: false })).toContain("connect-src 'none'");
		expect(response.headers.has("access-control-allow-origin")).toBe(false);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	}
});

it.each(["woff", "woff2", "ttf", "otf"])("serves local %s fonts with a font MIME type and CORS permission", async extension => {
	const grant = await page();
	const name = `type.${extension}`;
	await writeFile(join(folder, name), "font bytes");
	for (const method of ["GET", "HEAD"]) {
		const response = await handlePreviewRequest(new Request(new URL(name, grant.url), { method }));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(`font/${extension}`);
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
	}
});

it.each(["html", "css", "png", "jpg", "webp", "svg", "pdf", "txt", "eot"])("serves %s files without CORS permission", async extension => {
	const grant = await page();
	const name = `asset.${extension}`;
	await writeFile(join(folder, name), "asset bytes");
	for (const method of ["GET", "HEAD"]) {
		const response = await handlePreviewRequest(new Request(new URL(name, grant.url), { method }));
		expect(response.status).toBe(200);
		expect(response.headers.has("access-control-allow-origin")).toBe(false);
	}
});

it("withholds CORS permission when a font request is refused", async () => {
	const grant = await page();
	const response = await get(new URL("missing.woff2", grant.url).href);
	expect(response.status).toBe(404);
	expect(response.headers.has("access-control-allow-origin")).toBe(false);
});

it("refuses unknown and revoked tokens, including all tokens after a reload", async () => {
	const first = await page();
	const second = await page();
	expect((await get("vomp-preview://0123456789/index.html")).status).toBe(404);
	revokePreview(first.token);
	expect((await get(first.url)).status).toBe(404);
	expect(previewDocumentUrl(first.url)).toBeNull();
	revokeAllPreviews();
	expect((await get(second.url)).status).toBe(404);
});

it("keeps live updates, saving and revocation with the granting window", async () => {
	const path = join(folder, "index.html");
	await writeFile(path, "disk");
	const grant = await grantPreview({ path, root: folder, related: [] }, 12);
	setPreviewLive(grant.token, 1, "owned", 12);
	setPreviewLive(grant.token, 2, "other", 13);
	savePreview(grant.token, 13);
	revokePreview(grant.token, 13);
	expect(await (await get(grant.url)).text()).toBe("owned");
	revokePreview(grant.token, 12);
	expect((await get(grant.url)).status).toBe(404);
});

describe("streamed video", () => {
	const mib = 1024 * 1024;
	const bytes = "0123456789abcdefghijklmnopqrstuvwxyz";

	interface ObservedFile {
		readonly file: FileHandle;
		readonly stream: ReadStream | undefined;
		readonly closed: Promise<void>;
		readonly backpressured: Promise<void>;
	}

	async function movie(name = "movie.mp4", size?: number, owner: number | null = null) {
		const path = join(folder, name);
		await writeFile(path, bytes);
		if (size !== undefined) {
			const file = await open(path, "r+");
			try { await file.truncate(size); } finally { await file.close(); }
		}
		const grant = await grantPreview({ path, root: folder, related: [] }, owner);
		return { ...grant, path };
	}

	function request(url: string, range?: string, method = "GET", signal?: AbortSignal) {
		return handlePreviewRequest(new Request(url, { method, signal, headers: range === undefined ? {} : { Range: range } }));
	}

	/** Observe the real descriptor and stream without replacing their I/O behavior. */
	function observeFile(): ObservedFile {
		let file!: FileHandle;
		let stream: ReadStream | undefined;
		let closed!: Promise<void>;
		const { promise: backpressured, resolve: paused } = Promise.withResolvers<void>();
		files.afterOpen = opened => {
			file = opened;
			const completion = Promise.withResolvers<void>();
			closed = completion.promise;
			const close = opened.close.bind(opened);
			vi.spyOn(opened, "close").mockImplementation(async () => { await close(); if (!stream) completion.resolve(); });
			const create = opened.createReadStream.bind(opened);
			vi.spyOn(opened, "createReadStream").mockImplementation(options => {
				stream = create(options);
				stream.once("close", completion.resolve);
				stream.on("pause", () => { if (stream!.bytesRead > 0) paused(); });
				return stream;
			});
			vi.spyOn(opened, "readFile");
		};
		return {
			get file() { return file; },
			get stream() { return stream; },
			get closed() { return closed; },
			backpressured,
		};
	}

	async function expectClosed(observed: ObservedFile) {
		await observed.closed;
		expect(observed.file.fd).toBe(-1);
		await expect(observed.file.stat()).rejects.toMatchObject({ code: "EBADF" });
	}

	it.each([
		["movie.mp4", "video/mp4"], ["movie.m4v", "video/mp4"],
		["movie.webm", "video/webm"], ["movie.mov", "video/quicktime"], ["MOVIE.MP4", "video/mp4"],
	])("streams %s with its MIME type, security headers and no CORS permission", async (name, type) => {
		const grant = await movie(name);
		const observed = observeFile();
		const response = await request(grant.url);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(type);
		expect(response.headers.get("content-length")).toBe(String(bytes.length));
		expect(response.headers.get("accept-ranges")).toBe("bytes");
		expect(response.headers.has("content-range")).toBe(false);
		expect(response.headers.has("access-control-allow-origin")).toBe(false);
		expect(response.headers.get("content-security-policy")).toBe(previewPolicy({ scripts: false, network: false }));
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await response.text()).toBe(bytes);
		expect(observed.stream).toBeDefined();
		await expectClosed(observed);
	});

	it.each([
		["bytes=4-9", 4, 9], ["bytes=0-0", 0, 0], ["bytes=32-999", 32, 35],
		["bytes=-5", 31, 35], ["bytes=-999", 0, 35], ["bytes=30-", 30, 35],
		["bytes=0-999999999999999999999", 0, 35], ["bytes=-999999999999999999999", 0, 35],
	])("serves range %s with the exact extent", async (range, start, end) => {
		const grant = await movie();
		const observed = observeFile();
		const response = await request(grant.url, range);
		expect(response.status).toBe(206);
		expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/${bytes.length}`);
		expect(response.headers.get("content-length")).toBe(String(end - start + 1));
		expect(response.headers.get("accept-ranges")).toBe("bytes");
		expect(await response.text()).toBe(bytes.slice(start, end + 1));
		await expectClosed(observed);
	});

	it.each([
		["bytes=100-", 100, 100 + 8 * mib - 1],
		["bytes=0-", 0, 8 * mib - 1],
		["bytes=0-9437183", 0, 9 * mib - 1],
		["bytes=-9437184", mib, 10 * mib - 1],
	])("applies the 8 MiB limit only to open-ended range %s", async (range, start, end) => {
		const grant = await movie("large.mp4", 10 * mib);
		const observed = observeFile();
		const response = await request(grant.url, range);
		expect(response.status).toBe(206);
		expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/${10 * mib}`);
		expect(response.headers.get("content-length")).toBe(String(end - start + 1));
		expect((await response.arrayBuffer()).byteLength).toBe(end - start + 1);
		await expectClosed(observed);
	});

	it("streams an uncapped whole file with byte-bounded backpressure", async () => {
		const size = 40 * mib;
		const grant = await movie("whole.mp4", size);
		const observed = observeFile();
		const response = await request(grant.url);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-length")).toBe(String(size));
		expect(response.headers.has("content-range")).toBe(false);
		expect(observed.file.readFile).not.toHaveBeenCalled();
		const stream = observed.stream!;
		expect(stream.readableHighWaterMark).toBe(64 * 1024);
		// Wait for the actual backpressure transition while the response has no reader.
		await observed.backpressured;
		expect(stream.bytesRead).toBeLessThanOrEqual(3 * 64 * 1024);
		const reader = response.body!.getReader();
		let length = 0;
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			length += chunk.value.byteLength;
			expect(chunk.value.byteLength).toBeLessThanOrEqual(64 * 1024);
		}
		expect(length).toBe(size);
		await expectClosed(observed);
	});

	it.each([
		"bytes=36-", "bytes=999-1000", "bytes=9-4", "bytes=-0", "bytes=-", "bytes=0-1,4-5",
		"items=0-1", "bytes=one-two", "bytes=1.5-2", "bytes=+1-2", "bytes=0--1",
		"bytes=999999999999999999999-", "",
	])("refuses invalid or unsatisfiable range %s and closes the file", async range => {
		const grant = await movie();
		const observed = observeFile();
		const response = await request(grant.url, range);
		expect(response.status).toBe(416);
		expect(response.headers.get("content-range")).toBe(`bytes */${bytes.length}`);
		expect(response.headers.get("accept-ranges")).toBe("bytes");
		expect(response.headers.has("access-control-allow-origin")).toBe(false);
		expect(response.body).toBeNull();
		expect(observed.stream).toBeUndefined();
		await expectClosed(observed);
	});

	it.each([undefined, "bytes=4-9", "bytes=-5", "bytes=30-", "bytes=99-"])("gives HEAD the GET headers for range %s without a body or stream", async range => {
		const grant = await movie();
		const getResponse = await request(grant.url, range);
		await getResponse.arrayBuffer();
		const observed = observeFile();
		const response = await request(grant.url, range, "HEAD");
		expect(response.status).toBe(getResponse.status);
		expect([...response.headers]).toEqual([...getResponse.headers]);
		expect(response.body).toBeNull();
		expect(observed.stream).toBeUndefined();
		await expectClosed(observed);
	});

	it("serves an empty whole file and refuses all ranges on it", async () => {
		const grant = await movie("empty.mp4", 0);
		for (const method of ["GET", "HEAD"]) {
			for (const range of [undefined, "bytes=0-", "bytes=-1", "bytes=0-0"]) {
				const observed = observeFile();
				const response = await request(grant.url, range, method);
				expect(response.status).toBe(range === undefined ? 200 : 416);
				expect(response.headers.get(range === undefined ? "content-length" : "content-range")).toBe(range === undefined ? "0" : "bytes */0");
				expect(response.body).toBeNull();
				await expectClosed(observed);
			}
		}
	});

	it("destroys an active stream and closes its descriptor when the request aborts", async () => {
		const grant = await movie("abort.mp4", 40 * mib);
		const controller = new AbortController();
		const observed = observeFile();
		const response = await request(grant.url, undefined, "GET", controller.signal);
		const reader = response.body!.getReader();
		expect((await reader.read()).done).toBe(false);
		controller.abort();
		await expect(reader.closed).rejects.toMatchObject({ name: "AbortError" });
		await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
		expect(observed.stream!.destroyed).toBe(true);
		await expectClosed(observed);
	});

	it("closes the descriptor when a response consumer cancels", async () => {
		const grant = await movie("cancel.mp4", 40 * mib);
		const observed = observeFile();
		const response = await request(grant.url);
		await response.body!.cancel();
		expect(observed.stream!.destroyed).toBe(true);
		await expectClosed(observed);
	});

	it.each(["end", "error"])("closes the descriptor and releases stream tracking and the abort listener on %s", async mode => {
		const grant = await movie("lifecycle.mp4", mode === "error" ? 40 * mib : undefined);
		const controller = new AbortController();
		const observed = observeFile();
		const received = new Request(grant.url, { signal: controller.signal });
		const remove = vi.spyOn(received.signal, "removeEventListener");
		const response = await handlePreviewRequest(received);
		const destroy = vi.spyOn(observed.stream!, "destroy");
		if (mode === "error") {
			observed.stream!.destroy(new Error("Read failed."));
			await expect(response.arrayBuffer()).rejects.toThrow("Read failed.");
		} else {
			expect(await response.text()).toBe(bytes);
		}
		await expectClosed(observed);
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		const destroyed = destroy.mock.calls.length;
		revokePreview(grant.token);
		controller.abort();
		expect(destroy).toHaveBeenCalledTimes(destroyed);
	});

	it.each(["token", "all"])("destroys every active stream on %s revocation", async mode => {
		const grant = await movie("revoke.mp4", 40 * mib, 12);
		const other = await movie("other.mp4", 40 * mib, 13);
		const streams: { observed: ObservedFile; response: Response }[] = [];
		for (const url of [grant.url, `${grant.url}?rev=2`, other.url]) {
			const observed = observeFile();
			streams.push({ observed, response: await request(url) });
		}
		revokePreview(grant.token, 13);
		expect(streams[0]!.observed.stream!.destroyed).toBe(false);
		if (mode === "token") revokePreview(grant.token, 12);
		else revokeAllPreviews();
		for (const { observed, response } of streams.slice(0, mode === "token" ? 2 : 3)) {
			expect(observed.stream!.destroyed).toBe(true);
			await expect(response.arrayBuffer()).rejects.toThrow();
			await expectClosed(observed);
		}
		if (mode === "token") {
			expect(streams[2]!.observed.stream!.destroyed).toBe(false);
			await streams[2]!.response.body!.cancel();
			await expectClosed(streams[2]!.observed);
		}
		expect((await request(grant.url, "bytes=0-4")).status).toBe(404);
	});

	it.each(["before", "afterOpen"])("closes without streaming when already aborted %s opening", async when => {
		const grant = await movie();
		const controller = new AbortController();
		let file: FileHandle | undefined;
		const calls = files.openCalls;
		files.afterOpen = opened => {
			file = opened;
			if (when === "afterOpen") controller.abort();
		};
		if (when === "before") controller.abort();
		await expect(request(grant.url, undefined, "GET", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		if (when === "before") {
			expect(files.openCalls).toBe(calls);
			expect(file).toBeUndefined();
		} else {
			expect(file!.fd).toBe(-1);
			await expect(file!.stat()).rejects.toMatchObject({ code: "EBADF" });
		}
	});

	it.each(["token", "all"])("refuses a stale opened request after %s revocation and keeps a new grant independent", async mode => {
		const grant = await movie();
		let file!: FileHandle;
		let replacement!: PreviewGrant;
		files.afterOpen = async opened => {
			file = opened;
			if (mode === "token") revokePreview(grant.token);
			else revokeAllPreviews();
			replacement = await grantPreview({ path: grant.path, root: folder, related: [] });
		};
		expect((await request(grant.url, "bytes=0-4")).status).toBe(404);
		expect(file.fd).toBe(-1);
		expect(await (await request(replacement.url, "bytes=0-4")).text()).toBe("01234");
	});

	it("denies video symlinks leaving the grant and revoked tokens", async () => {
		const grant = await movie();
		const outside = await mkdtemp(join(tmpdir(), "vomp-video-outside-"));
		cleanup.push(outside);
		await writeFile(join(outside, "private.mp4"), "private");
		await symlink(outside, join(folder, "escape"), process.platform === "win32" ? "junction" : "dir");
		expect((await request(new URL("escape/private.mp4", grant.url).href, "bytes=0-4")).status).toBe(403);
		await rm(grant.path);
		await symlink(join(outside, "private.mp4"), grant.path);
		expect((await request(grant.url)).status).toBe(403);
		revokePreview(grant.token);
		expect((await request(grant.url)).status).toBe(404);
	});

	it("checks the opened inode again and closes it if a save replaces the path", async () => {
		const grant = await movie();
		let file!: FileHandle;
		files.afterOpen = async (opened, path, flags) => {
			file = opened;
			expect(path).toBe(await realpath(grant.path));
			expect(Number(flags) & constants.O_RDONLY).toBe(constants.O_RDONLY);
			if (constants.O_NOFOLLOW) expect(Number(flags) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
			await rename(grant.path, join(folder, "previous.mp4"));
			await writeFile(grant.path, "replacement");
		};
		expect((await request(grant.url, "bytes=0-4")).status).toBe(403);
		expect(file.fd).toBe(-1);
		expect(await (await request(grant.url)).text()).toBe("replacement");
	});

	it("rechecks containment and closes the opened file when its path becomes an outside symlink", async () => {
		const grant = await movie();
		const outside = join(tmpdir(), `${basename(folder)}-private.mp4`);
		cleanup.push(outside);
		await writeFile(outside, "private");
		let file!: FileHandle;
		files.afterOpen = async opened => {
			file = opened;
			await rename(grant.path, join(folder, "previous.mp4"));
			await symlink(outside, grant.path);
		};
		expect((await request(grant.url)).status).toBe(403);
		expect(file.fd).toBe(-1);
	});

	it("closes the opened descriptor when its path disappears during validation", async () => {
		const grant = await movie();
		let file!: FileHandle;
		files.afterOpen = async opened => {
			file = opened;
			await rm(grant.path);
		};
		expect((await request(grant.url)).status).toBe(404);
		expect(file.fd).toBe(-1);
	});

	it("limits many concurrent unread ranges per grant before opening descriptors", async () => {
		const grant = await movie("limited.mp4", 40 * mib);
		const other = await movie("independent.mp4", 40 * mib);
		const opened: FileHandle[] = [];
		const closed: Promise<unknown>[] = [];
		files.onOpen = file => {
			opened.push(file);
			const create = file.createReadStream.bind(file);
			vi.spyOn(file, "createReadStream").mockImplementation(options => {
				const stream = create(options);
				const completion = Promise.withResolvers<void>();
				closed.push(completion.promise);
				stream.once("close", completion.resolve);
				return stream;
			});
		};
		const calls = files.openCalls;
		const responses = await Promise.all(Array.from({ length: 32 }, (_, index) => request(grant.url, `bytes=${index}-`)));
		expect(responses.filter(response => response.status === 206)).toHaveLength(4);
		expect(responses.filter(response => response.status === 429)).toHaveLength(28);
		expect(files.openCalls - calls).toBe(4);
		const independent = await request(other.url, "bytes=0-");
		expect(independent.status).toBe(206);
		await Promise.all([...responses, independent].map(response => response.body?.cancel()));
		await Promise.all(closed);
		expect(opened.every(file => file.fd === -1)).toBe(true);
		// All four slots are reusable, not just the first released slot.
		const reused = await Promise.all(Array.from({ length: 4 }, () => request(grant.url, undefined, "HEAD")));
		expect(reused.map(response => response.status)).toEqual([200, 200, 200, 200]);
	});

	it("limits unread ranges globally across grants without opening excess descriptors", async () => {
		const grants = await Promise.all(Array.from({ length: 5 }, (_, index) => movie(`global-${index}.mp4`, 40 * mib)));
		const opened: FileHandle[] = [];
		const closed: Promise<unknown>[] = [];
		files.onOpen = file => {
			opened.push(file);
			const create = file.createReadStream.bind(file);
			vi.spyOn(file, "createReadStream").mockImplementation(options => {
				const stream = create(options);
				const completion = Promise.withResolvers<void>();
				closed.push(completion.promise);
				stream.once("close", completion.resolve);
				return stream;
			});
		};
		const calls = files.openCalls;
		const responses = await Promise.all(grants.slice(0, 4).flatMap(grant => Array.from({ length: 4 }, () => request(grant.url, "bytes=0-"))));
		expect(responses.every(response => response.status === 206)).toBe(true);
		expect((await request(grants[4]!.url, "bytes=0-")).status).toBe(429);
		expect(files.openCalls - calls).toBe(16);
		await Promise.all(responses.map(response => response.body!.cancel()));
		await Promise.all(closed);
		expect(opened.every(file => file.fd === -1)).toBe(true);
		expect((await request(grants[4]!.url, undefined, "HEAD")).status).toBe(200);
	});

	it.each(["token", "all"])("keeps pending opens reserved through %s revocation until every descriptor closes", async mode => {
		const grants = await Promise.all(Array.from({ length: 4 }, (_, index) => movie(`pending-${index}.mp4`)));
		const opened: FileHandle[] = [];
		const entered = Promise.withResolvers<void>();
		const settle = Promise.withResolvers<void>();
		files.onOpen = async file => {
			opened.push(file);
			if (opened.length === 16) entered.resolve();
			await settle.promise;
		};
		const calls = files.openCalls;
		const pending = grants.flatMap(grant => Array.from({ length: 4 }, () => request(grant.url)));
		await entered.promise;
		expect((await request(grants[0]!.url)).status).toBe(429);
		expect(files.openCalls - calls).toBe(16);
		if (mode === "all") revokeAllPreviews();
		else for (const grant of grants) revokePreview(grant.token);
		const replacements = await Promise.all(grants.map(grant => grantPreview({ path: grant.path, root: folder, related: [] })));
		// Revocation cannot reset the global count while old opens still own descriptors.
		expect((await request(replacements[0]!.url)).status).toBe(429);
		expect(files.openCalls - calls).toBe(16);
		files.onOpen = null;
		settle.resolve();
		expect((await Promise.all(pending)).every(response => response.status === 404)).toBe(true);
		expect(opened.every(file => file.fd === -1)).toBe(true);
		// Starting sixteen new requests together proves the global reservations were all released.
		const reused = await Promise.all(replacements.flatMap(grant => Array.from({ length: 4 }, () => request(grant.url, undefined, "HEAD"))));
		expect(reused.every(response => response.status === 200)).toBe(true);
	});

	it("releases all pending reservations when the requests abort during opening", async () => {
		const grant = await movie("pending-abort.mp4");
		const controller = new AbortController();
		const entered = Promise.withResolvers<void>();
		const settle = Promise.withResolvers<void>();
		const opened: FileHandle[] = [];
		files.onOpen = async file => {
			opened.push(file);
			if (opened.length === 4) entered.resolve();
			await settle.promise;
		};
		const pending = Promise.allSettled(Array.from({ length: 4 }, () => request(grant.url, undefined, "GET", controller.signal)));
		await entered.promise;
		controller.abort();
		expect((await request(grant.url)).status).toBe(429);
		files.onOpen = null;
		settle.resolve();
		for (const result of await pending) {
			expect(result.status).toBe("rejected");
			if (result.status === "rejected") expect(result.reason).toMatchObject({ name: "AbortError" });
		}
		expect(opened.every(file => file.fd === -1)).toBe(true);
		const reused = await Promise.all(Array.from({ length: 4 }, () => request(grant.url, undefined, "HEAD")));
		expect(reused.every(response => response.status === 200)).toBe(true);
	});

	it.each(["missing", "open error", "invalid range", "HEAD", "stream error", "cancel", "EOF"])("releases every reservation after %s", async mode => {
		const grant = await movie("release.mp4", 40 * mib);
		const opened: FileHandle[] = [];
		files.onOpen = file => { opened.push(file); };
		if (mode === "missing") {
			for (let index = 0; index < 8; index++) expect((await request(new URL("missing.mp4", grant.url).href)).status).toBe(404);
		} else if (mode === "open error") {
			files.openError = new Error("Open failed.");
			const calls = files.openCalls;
			for (let index = 0; index < 8; index++) expect((await request(grant.url)).status).toBe(404);
			expect(files.openCalls - calls).toBe(8);
			files.openError = null;
		} else if (mode === "HEAD" || mode === "invalid range") {
			for (let index = 0; index < 8; index++) {
				expect((await request(grant.url, mode === "invalid range" ? "bytes=999999999-" : undefined, mode === "HEAD" ? "HEAD" : "GET")).status).toBe(mode === "HEAD" ? 200 : 416);
			}
		} else {
			const observed = observeFile();
			const response = await request(grant.url, mode === "EOF" ? "bytes=0-4" : undefined);
			if (mode === "stream error") {
				observed.stream!.destroy(new Error("Read failed."));
				await expect(response.arrayBuffer()).rejects.toThrow("Read failed.");
			} else if (mode === "EOF") expect(await response.text()).toBe("01234");
			else await response.body!.cancel();
			await expectClosed(observed);
		}
		expect(opened.every(file => file.fd === -1)).toBe(true);
		const reused = await Promise.all(Array.from({ length: 4 }, () => request(grant.url, undefined, "HEAD")));
		expect(reused.every(response => response.status === 200)).toBe(true);
	});

	it.each([undefined, "bytes=0-"])("never streams growth beyond the initial advertised extent for %s", async range => {
		const size = 2 * mib;
		const grant = await movie("growing.mp4", size);
		const observed = observeFile();
		const response = await request(grant.url, range);
		await observed.backpressured;
		expect(observed.stream!.bytesRead).toBeLessThanOrEqual(3 * 64 * 1024);
		const writer = await open(grant.path, "r+");
		try {
			await writer.write(Buffer.alloc(mib, 0x78), 0, mib, size);
		} finally { await writer.close(); }
		expect(response.headers.get("content-length")).toBe(String(size));
		const body = new Uint8Array(await response.arrayBuffer());
		expect(body.byteLength).toBe(size);
		expect(body.subarray(bytes.length).every(value => value === 0)).toBe(true);
		await expectClosed(observed);
	});

	it.each([undefined, "bytes=0-"])("errors a paused response when truncation causes premature EOF for %s", async range => {
		const size = 2 * mib;
		const grant = await movie("truncated.mp4", size);
		const observed = observeFile();
		const response = await request(grant.url, range);
		await observed.backpressured;
		expect(observed.stream!.bytesRead).toBeLessThanOrEqual(3 * 64 * 1024);
		const writer = await open(grant.path, "r+");
		try { await writer.truncate(mib); } finally { await writer.close(); }
		expect(response.headers.get("content-length")).toBe(String(size));
		await expect(response.arrayBuffer()).rejects.toThrow("ended before its advertised length");
		await expectClosed(observed);
		const reused = await Promise.all(Array.from({ length: 4 }, () => request(grant.url, undefined, "HEAD")));
		expect(reused.every(response => response.status === 200)).toBe(true);
	});
});

describe("prepared document snapshots", () => {
	it("accepts live text before the file exists, then reports a missing saved document", async () => {
		const grant = await grantPreview({ path: join(folder, "pending.html"), root: folder, related: [] });
		expect(await preparePreview(grant.token, 1)).toEqual({ ok: false, reason: "missing" });
		setPreviewLive(grant.token, 1, "<h1>Writing</h1>");
		expect(await preparePreview(grant.token, 1)).toEqual({ ok: true, policy: { scripts: false, network: false } });
		savePreview(grant.token);
		expect(await preparePreview(grant.token, 2)).toEqual({ ok: false, reason: "missing" });
		await writeFile(join(folder, "pending.html"), "<h1>Saved</h1>");
		expect(await preparePreview(grant.token, 2)).toEqual({ ok: true, policy: { scripts: false, network: false } });
		expect(await (await get(`${grant.url}?rev=1`)).text()).toBe("<h1>Writing</h1>");
		expect(await (await get(`${grant.url}?rev=2`)).text()).toBe("<h1>Saved</h1>");
	});

	it("reports an oversized saved document and still accepts the last bounded live text", async () => {
		const grant = await page();
		const file = await open(join(folder, "index.html"), "w");
		try { await file.truncate(2 * 1024 * 1024 + 1); } finally { await file.close(); }
		expect(await preparePreview(grant.token, 1)).toEqual({ ok: false, reason: "tooLarge" });
		setPreviewLive(grant.token, 1, "<p>Last good text</p>");
		expect(await preparePreview(grant.token, 1)).toEqual({ ok: true, policy: { scripts: false, network: false } });
		savePreview(grant.token);
		expect(await preparePreview(grant.token, 2)).toEqual({ ok: false, reason: "tooLarge" });
		expect(await (await get(`${grant.url}?rev=1`)).text()).toBe("<p>Last good text</p>");
	});

	it("reports a directory or a replaced symlink outside the grant as notFile", async () => {
		const grant = await page();
		await rm(join(folder, "index.html"));
		await mkdir(join(folder, "index.html"));
		expect(await preparePreview(grant.token, 1)).toEqual({ ok: false, reason: "notFile" });
		await rm(join(folder, "index.html"), { recursive: true });
		const outside = join(tmpdir(), `${basename(folder)}-outside.html`);
		cleanup.push(outside);
		await writeFile(outside, "private");
		await symlink(outside, join(folder, "index.html"));
		expect(await preparePreview(grant.token, 1)).toEqual({ ok: false, reason: "notFile" });
	});

	it("requires the granting owner and reports revoked or unknown tokens", async () => {
		const path = join(folder, "owned.html");
		await writeFile(path, "owned");
		const grant = await grantPreview({ path, root: folder, related: [] }, 12);
		expect(await preparePreview(grant.token, 1, 13)).toEqual({ ok: false, reason: "revoked" });
		expect(await preparePreview(grant.token, 1, 12)).toEqual({ ok: true, policy: { scripts: false, network: false } });
		revokePreview(grant.token, 12);
		expect(await preparePreview(grant.token, 1, 12)).toEqual({ ok: false, reason: "revoked" });
		expect(await preparePreview("unknown", 1)).toEqual({ ok: false, reason: "revoked" });
		expect((await get(`${grant.url}?rev=1`)).status).toBe(404);
	});

	it.each(["removed", "replaced", "oversized"])("serves the prepared bytes when the saved document is later %s", async change => {
		const grant = await page();
		expect(await preparePreview(grant.token, 1)).toEqual({ ok: true, policy: { scripts: false, network: false } });
		const path = join(folder, "index.html");
		if (change === "removed") await rm(path);
		else if (change === "replaced") await writeFile(path, "<h1>Different document</h1>");
		else {
			const file = await open(path, "w");
			try { await file.truncate(2 * 1024 * 1024 + 1); } finally { await file.close(); }
		}
		const response = await get(`${grant.url}?rev=1`);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("<h1>Saved</h1>");
		expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(response.headers.get("content-security-policy")).toBe(previewPolicy({ scripts: false, network: false }));
		expect(response.headers.has("access-control-allow-origin")).toBe(false);
		expect((await get(`${grant.url}?rev=999`)).status).toBe(404);
	});

	it("keeps snapshots immutable and releases all but the two newest revisions, then releases them on reload", async () => {
		const grant = await page();
		expect(await preparePreview(grant.token, 1)).toEqual({ ok: true, policy: { scripts: false, network: false } });
		await writeFile(join(folder, "index.html"), "second");
		expect(await preparePreview(grant.token, 1)).toEqual({ ok: true, policy: { scripts: false, network: false } });
		expect(await (await get(`${grant.url}?rev=1`)).text()).toBe("<h1>Saved</h1>");
		expect(await preparePreview(grant.token, 2)).toEqual({ ok: true, policy: { scripts: false, network: false } });
		await writeFile(join(folder, "index.html"), "third");
		expect(await preparePreview(grant.token, 3)).toEqual({ ok: true, policy: { scripts: false, network: false } });
		expect((await get(`${grant.url}?rev=1`)).status).toBe(404);
		expect(await (await get(`${grant.url}?rev=2`)).text()).toBe("second");
		expect(await (await get(`${grant.url}?rev=3`)).text()).toBe("third");
		revokeAllPreviews();
		expect((await get(`${grant.url}?rev=2`)).status).toBe(404);
		expect((await get(`${grant.url}?rev=3`)).status).toBe(404);
	});

	it("continues checking assets on disk without retaining them as document snapshots", async () => {
		const grant = await page();
		await writeFile(join(folder, "style.css"), "first");
		expect(await preparePreview(grant.token, 1)).toEqual({ ok: true, policy: { scripts: false, network: false } });
		const asset = new URL("style.css?rev=1", grant.url).href;
		expect(await (await get(asset)).text()).toBe("first");
		await writeFile(join(folder, "style.css"), "second");
		expect(await (await get(asset)).text()).toBe("second");
		await rm(join(folder, "style.css"));
		expect((await get(asset)).status).toBe(404);
		expect(await (await get(`${grant.url}?rev=1`)).text()).toBe("<h1>Saved</h1>");
	});
});

describe("preview navigation", () => {
	const url = "vomp-preview://abcd/pages/index.html";
	const base = { url, currentUrl: "about:blank", isMainFrame: false, initiatedByMainFrame: true, documentUrl: url };
	it("allows only app-initiated valid subject documents and revisions", () => {
		expect(previewNavigationRule(base)).toEqual({ cancel: false });
		expect(previewNavigationRule({ ...base, url: `${url}?rev=42` })).toEqual({ cancel: false });
		for (const target of ["vomp-preview://abcd/pages/style.css", "vomp-preview://ffff/pages/index.html", `${url}?other=1`, `${url}#part`, "vomp-preview://abcd/pages/%2e%2e/index.html"]) {
			expect(previewNavigationRule({ ...base, url: target }).cancel).toBe(true);
		}
		expect(previewNavigationRule({ ...base, documentUrl: null }).cancel).toBe(true);
	});
	it("blocks preview-page links, refreshes and forms even to the same document", () => {
		for (const target of [url, `${url}?rev=2`, "about:blank", "data:text/html,hello", "file:///etc/passwd"]) {
			expect(previewNavigationRule({ ...base, currentUrl: url, initiatedByMainFrame: false, url: target }).cancel).toBe(true);
		}
	});
	it("reports web destinations for the app's external-link offer", () => {
		for (const target of ["https://example.com/", "http://localhost:3000/"]) {
			expect(previewNavigationRule({ ...base, currentUrl: url, initiatedByMainFrame: false, url: target })).toEqual({ cancel: true, blocked: { token: "abcd", url: target } });
		}
	});
	it("leaves the main-frame guard and ordinary Preview-pane frames unchanged", () => {
		expect(previewNavigationRule({ ...base, isMainFrame: true, initiatedByMainFrame: false })).toEqual({ cancel: false });
		expect(previewNavigationRule({ ...base, currentUrl: "https://example.com/", url: "http://localhost:3000/", initiatedByMainFrame: false, documentUrl: null })).toEqual({ cancel: false });
		expect(previewNavigationRule({ ...base, currentUrl: "https://example.com/", initiatedByMainFrame: false }).cancel).toBe(true);
		expect(previewNavigationRule({ ...base, currentUrl: "about:blank", url: "VOMP-PREVIEW://abcd/pages/index.html", initiatedByMainFrame: false }).cancel).toBe(true);
	});
});

it("registers scheme privileges before readiness and the request handler only once after readiness", async () => {
	const { promise, resolve: ready } = Promise.withResolvers<void>();
	electron.whenReady.mockReturnValue(promise);
	registerPreviewScheme();
	expect(electron.schemes).toHaveBeenCalledWith([{ scheme: "vomp-preview", privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }]);
	registerPreviewProtocol();
	registerPreviewProtocol();
	expect(electron.handle).not.toHaveBeenCalled();
	ready();
	await Promise.resolve();
	expect(electron.handle).toHaveBeenCalledExactlyOnceWith("vomp-preview", handlePreviewRequest);
	const path = join(folder, "ipc.html");
	await writeFile(path, "disk");
	const event = { sender: { id: 44 } };
	const grant = await electron.ipc.get("preview:grant")!(event, { path, root: folder, related: [] }) as PreviewGrant;
	electron.ipc.get("preview:live")!(event, grant.token, 1, "IPC live");
	expect(await (await get(grant.url)).text()).toBe("IPC live");
	expect(await electron.ipc.get("preview:prepare")!(event, grant.token, 1)).toEqual({ ok: true, policy: { scripts: false, network: false } });
	expect(await electron.ipc.get("preview:prepare")!({ sender: { id: 45 } }, grant.token, 1)).toEqual({ ok: false, reason: "revoked" });
	electron.ipc.get("preview:saved")!(event, grant.token);
	expect(await (await get(grant.url)).text()).toBe("disk");
	electron.ipc.get("preview:revoke")!(event, grant.token);
	expect((await get(grant.url)).status).toBe(404);
	expect(await electron.ipc.get("preview:prepare")!(event, grant.token, 1)).toEqual({ ok: false, reason: "revoked" });
});
