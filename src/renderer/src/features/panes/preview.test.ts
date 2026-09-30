import { describe, expect, it } from "vitest";
import { normalizePreviewUrl } from "./preview-url";

describe("normalizePreviewUrl", () => {
	it("adds http:// to local addresses and https:// to other hosts", () => {
		expect(normalizePreviewUrl("localhost:3000")).toBe("http://localhost:3000/");
		expect(normalizePreviewUrl(":5173/app")).toBe("http://localhost:5173/app");
		expect(normalizePreviewUrl("127.0.0.1:8000")).toBe("http://127.0.0.1:8000/");
		expect(normalizePreviewUrl("example.com")).toBe("https://example.com/");
	});

	it("maps 0.0.0.0 to localhost", () => {
		expect(normalizePreviewUrl("http://0.0.0.0:8080")).toBe("http://localhost:8080/");
	});

	it("refuses plain http to remote hosts and non-web schemes", () => {
		expect(normalizePreviewUrl("http://example.com")).toBeNull();
		expect(normalizePreviewUrl("file:///etc/passwd")).toBeNull();
		expect(normalizePreviewUrl("javascript:alert(1)")).toBeNull();
		expect(normalizePreviewUrl("   ")).toBeNull();
	});
});
