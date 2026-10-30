import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { allowsAppPermission, allowsClipboardWrite, allowsMicrophone, isAppOrigin, isAppUrl, setAppRendererUrl } from "./app-origin";

describe("app document permissions", () => {
	it("accepts only the configured document, retaining hash routing", () => {
		setAppRendererUrl("file:///Applications/visual-omp.app/Contents/Resources/app.asar/out/renderer/index.html");
		expect(isAppUrl("file:///Applications/visual-omp.app/Contents/Resources/app.asar/out/renderer/index.html#settings")).toBe(true);
		expect(isAppUrl("file:///tmp/index.html")).toBe(false);
		expect(isAppUrl("https://hostile.example")).toBe(false);
		expect(isAppUrl("invalid")).toBe(false);
		expect(isAppOrigin("file://")).toBe(true);
		expect(isAppOrigin("null")).toBe(false);
	});

	it("compares development origins exactly", () => {
		setAppRendererUrl("http://localhost:5173");
		expect(isAppUrl("http://localhost:5173/")).toBe(true);
		expect(isAppUrl("http://localhost:5173/preview")).toBe(false);
		expect(isAppOrigin("http://localhost:5173")).toBe(true);
		expect(isAppOrigin("http://localhost:5174")).toBe(false);
		expect(isAppOrigin("http://localhost:5173.hostile.example")).toBe(false);
	});

	it("allows only microphone requests from the app main frame", () => {
		setAppRendererUrl("http://localhost:5173");
		const request = { isMainFrame: true, requestingUrl: "http://localhost:5173/", mediaTypes: ["audio"] };
		expect(allowsMicrophone("media", request)).toBe(true);
		expect(allowsMicrophone("media", { ...request, mediaTypes: undefined, mediaType: "audio" })).toBe(true);
		expect(allowsMicrophone("media", { ...request, isMainFrame: false })).toBe(false);
		expect(allowsMicrophone("media", { ...request, requestingUrl: "http://localhost:8080/" })).toBe(false);
		expect(allowsMicrophone("media", { ...request, mediaTypes: ["audio", "video"] })).toBe(false);
		expect(allowsMicrophone("media", { ...request, mediaTypes: [] })).toBe(false);
		expect(allowsMicrophone("media", { ...request, mediaTypes: undefined })).toBe(false);
		expect(allowsMicrophone("notifications", request)).toBe(false);
	});

	it("lets the app document write to the clipboard, never read it, and never from another document", () => {
		setAppRendererUrl("http://localhost:5173");
		const request = { isMainFrame: true, requestingUrl: "http://localhost:5173/" };
		expect(allowsClipboardWrite("clipboard-sanitized-write", request)).toBe(true);
		// Permission checks may omit the requesting URL; the handler matched the webContents and the frame flag the frame.
		expect(allowsClipboardWrite("clipboard-sanitized-write", { isMainFrame: true })).toBe(true);
		expect(allowsClipboardWrite("clipboard-sanitized-write", {})).toBe(false);
		expect(allowsClipboardWrite("clipboard-sanitized-write", { isMainFrame: false })).toBe(false);
		expect(allowsClipboardWrite("clipboard-sanitized-write", { ...request, isMainFrame: false })).toBe(false);
		expect(allowsClipboardWrite("clipboard-sanitized-write", { ...request, requestingUrl: "https://hostile.example/" })).toBe(false);
		expect(allowsAppPermission("clipboard-read", request)).toBe(false);
		expect(allowsAppPermission("clipboard-sanitized-write", request)).toBe(true);
		expect(allowsAppPermission("media", { ...request, mediaTypes: ["audio"] })).toBe(true);
		expect(allowsAppPermission("notifications", request)).toBe(false);
	});
});

it("keeps preview content sandboxed without popup permission", () => {
	const source = readFileSync(new URL("../../renderer/src/features/panes/PreviewPane.tsx", import.meta.url), "utf8");
	const sandbox = /sandbox="([^"]+)"/.exec(source)?.[1]?.split(" ");
	expect(sandbox).toContain("allow-scripts");
	expect(sandbox).not.toContain("allow-popups");
	expect(sandbox).not.toContain("allow-popups-to-escape-sandbox");
});
