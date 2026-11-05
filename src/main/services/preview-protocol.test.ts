import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { PreviewGrant } from "@shared/contracts/preview";

const electron = vi.hoisted(() => ({
	ready: false,
	whenReady: vi.fn(),
	handle: vi.fn(),
	schemes: vi.fn(),
	ipc: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
	app: { isReady: () => electron.ready, whenReady: electron.whenReady },
	protocol: { handle: electron.handle, registerSchemesAsPrivileged: electron.schemes },
}));
vi.mock("../ipc", () => ({ handleWithEvent: (channel: string, handler: (...args: unknown[]) => unknown) => electron.ipc.set(channel, handler) }));

import {
	grantPreview, handlePreviewRequest, PREVIEW_CSP, previewDocumentUrl, previewNavigationRule, preparePreview,
	registerPreviewProtocol, registerPreviewScheme, revokeAllPreviews, revokePreview, savePreview, setPreviewLive,
} from "./preview-protocol";

let folder: string;
const cleanup: string[] = [];
beforeEach(async () => {
	folder = await mkdtemp(join(tmpdir(), "vomp-protocol-"));
	cleanup.push(folder);
});
afterEach(async () => {
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

it("refuses directories, unsupported video and scripts", async () => {
	const grant = await page();
	await mkdir(join(folder, "directory.html"));
	expect((await get(new URL("directory.html", grant.url).href)).status).toBe(403);
	for (const name of ["movie.mp4", "code.js"]) {
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
	expect(await preparePreview(grant.token, 1)).toEqual({ ok: true });
	expect(await (await get(`${grant.url}?rev=1`)).text()).toBe("newest");
	savePreview(grant.token);
	setPreviewLive(grant.token, 3, "late stream");
	expect(await preparePreview(grant.token, 3)).toEqual({ ok: true });
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
		expect(response.headers.get("content-security-policy")).toBe(PREVIEW_CSP);
		expect(PREVIEW_CSP).toContain("script-src 'none'");
		expect(PREVIEW_CSP).toContain("connect-src 'none'");
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

describe("prepared document snapshots", () => {
	it("accepts live text before the file exists, then reports a missing saved document", async () => {
		const grant = await grantPreview({ path: join(folder, "pending.html"), root: folder, related: [] });
		expect(await preparePreview(grant.token, 1)).toEqual({ ok: false, reason: "missing" });
		setPreviewLive(grant.token, 1, "<h1>Writing</h1>");
		expect(await preparePreview(grant.token, 1)).toEqual({ ok: true });
		savePreview(grant.token);
		expect(await preparePreview(grant.token, 2)).toEqual({ ok: false, reason: "missing" });
		await writeFile(join(folder, "pending.html"), "<h1>Saved</h1>");
		expect(await preparePreview(grant.token, 2)).toEqual({ ok: true });
		expect(await (await get(`${grant.url}?rev=1`)).text()).toBe("<h1>Writing</h1>");
		expect(await (await get(`${grant.url}?rev=2`)).text()).toBe("<h1>Saved</h1>");
	});

	it("reports an oversized saved document and still accepts the last bounded live text", async () => {
		const grant = await page();
		const file = await open(join(folder, "index.html"), "w");
		try { await file.truncate(2 * 1024 * 1024 + 1); } finally { await file.close(); }
		expect(await preparePreview(grant.token, 1)).toEqual({ ok: false, reason: "tooLarge" });
		setPreviewLive(grant.token, 1, "<p>Last good text</p>");
		expect(await preparePreview(grant.token, 1)).toEqual({ ok: true });
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
		expect(await preparePreview(grant.token, 1, 12)).toEqual({ ok: true });
		revokePreview(grant.token, 12);
		expect(await preparePreview(grant.token, 1, 12)).toEqual({ ok: false, reason: "revoked" });
		expect(await preparePreview("unknown", 1)).toEqual({ ok: false, reason: "revoked" });
		expect((await get(`${grant.url}?rev=1`)).status).toBe(404);
	});

	it.each(["removed", "replaced", "oversized"])("serves the prepared bytes when the saved document is later %s", async change => {
		const grant = await page();
		expect(await preparePreview(grant.token, 1)).toEqual({ ok: true });
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
		expect(response.headers.get("content-security-policy")).toBe(PREVIEW_CSP);
		expect(response.headers.has("access-control-allow-origin")).toBe(false);
		expect((await get(`${grant.url}?rev=999`)).status).toBe(404);
	});

	it("keeps snapshots immutable and releases all but the two newest revisions, then releases them on reload", async () => {
		const grant = await page();
		expect(await preparePreview(grant.token, 1)).toEqual({ ok: true });
		await writeFile(join(folder, "index.html"), "second");
		expect(await preparePreview(grant.token, 1)).toEqual({ ok: true });
		expect(await (await get(`${grant.url}?rev=1`)).text()).toBe("<h1>Saved</h1>");
		expect(await preparePreview(grant.token, 2)).toEqual({ ok: true });
		await writeFile(join(folder, "index.html"), "third");
		expect(await preparePreview(grant.token, 3)).toEqual({ ok: true });
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
		expect(await preparePreview(grant.token, 1)).toEqual({ ok: true });
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
	expect(await electron.ipc.get("preview:prepare")!(event, grant.token, 1)).toEqual({ ok: true });
	expect(await electron.ipc.get("preview:prepare")!({ sender: { id: 45 } }, grant.token, 1)).toEqual({ ok: false, reason: "revoked" });
	electron.ipc.get("preview:saved")!(event, grant.token);
	expect(await (await get(grant.url)).text()).toBe("disk");
	electron.ipc.get("preview:revoke")!(event, grant.token);
	expect((await get(grant.url)).status).toBe(404);
	expect(await electron.ipc.get("preview:prepare")!(event, grant.token, 1)).toEqual({ ok: false, reason: "revoked" });
});
