import { describe, expect, it } from "vitest";
import {
	fetchMcp,
	formatWindowsBatchCommand,
	readBoundedText,
	resolveWindowsStdioTarget,
	SseParser,
	testServer,
} from "./client";

describe("Windows MCP stdio resolution and batch quoting", () => {
	it("prefers direct .exe binaries over .cmd shims via PATHEXT", async () => {
		const files = new Set(["C:\\Tools\\node.exe", "C:\\Tools\\node.cmd", "C:\\Npm\\npx.cmd"]);
		const env = { PATH: "C:\\Tools;C:\\Npm", PATHEXT: ".EXE;.CMD" };
		expect(await resolveWindowsStdioTarget("node", "C:\\Work", env, async p => files.has(p))).toEqual({
			kind: "direct",
			executable: "C:\\Tools\\node.exe",
		});
		expect(await resolveWindowsStdioTarget("npx", "C:\\Work", env, async p => files.has(p))).toEqual({
			kind: "batch",
			executable: "C:\\Npm\\npx.cmd",
		});
	});

	it("resolves path-qualified and explicit extensions cleanly", async () => {
		const files = new Set(["C:\\Work\\bin\\srv.cmd", "C:\\Work\\bin\\tool.exe"]);
		expect(await resolveWindowsStdioTarget(".\\bin\\srv.cmd", "C:\\Work", {}, async p => files.has(p))).toEqual({
			kind: "batch",
			executable: "C:\\Work\\bin\\srv.cmd",
		});
		expect(await resolveWindowsStdioTarget("bin/tool", "C:\\Work", {}, async p => files.has(p))).toEqual({
			kind: "direct",
			executable: "C:\\Work\\bin\\tool.exe",
		});
		expect(await resolveWindowsStdioTarget("missing", "C:\\Work", { PATH: "C:\\Tools" }, async p => files.has(p))).toBeNull();
	});

	it("safely quotes spaces/metacharacters and doubles trailing backslashes for cmd.exe shims", () => {
		expect(formatWindowsBatchCommand("C:\\Npm\\npx.cmd", ["-y", "a & whoami", "C:\\with space\\"])).toBe(
			'"C:\\Npm\\npx.cmd -y "a & whoami" "C:\\with space\\\\""',
		);
	});

	it("rejects quotes, percent expansion, newlines, and NUL bytes in batch shim arguments", () => {
		for (const bad of ['a"b', "%COMSPEC%", "a\nb", "a\rb", "a\0b"]) {
			expect(() => formatWindowsBatchCommand("C:\\Npm\\npx.cmd", [bad])).toThrow(/cannot contain quotes, %, or line breaks/);
		}
	});
});

describe("MCP HTTP/SSE bounds and URL validation", () => {
	it("rejects non-HTTP(S) MCP server URLs before opening any transport", async () => {
		for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ftp://example.com/mcp"]) {
			const result = await testServer({
				config: { type: "http", url },
				timeoutMs: 1000,
				env: {},
				clientInfo: { name: "visual-omp", version: "0.0.0" },
			});
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/Unsupported server URL scheme/);
		}
	});

	it("enforces bounded SSE event parsing and bounded HTTP text reads", async () => {
		const parser = new SseParser(64);
		expect(() => parser.push(`data: ${"x".repeat(70)}\n\n`)).toThrow(/exceeded 64 bytes/);

		const response = new Response("a".repeat(128), { headers: { "content-length": "128" } });
		await expect(readBoundedText(response, 64)).rejects.toThrow(/exceeded 64 bytes/);

		const streamed = new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("a".repeat(40)));
					controller.enqueue(new TextEncoder().encode("b".repeat(40)));
					controller.close();
				},
			}),
		);
		await expect(readBoundedText(streamed, 64)).rejects.toThrow(/exceeded 64 bytes/);

		const truncated = new Response("x".repeat(100));
		expect(await readBoundedText(truncated, 32, true)).toBe("x".repeat(32));

		const bodyless = {
			headers: new Headers(),
			body: null,
			text: async () => "z".repeat(100),
		} as unknown as Response;
		await expect(readBoundedText(bodyless, 32)).rejects.toThrow(/exceeded 32 bytes/);
		expect(await readBoundedText(bodyless, 32, true)).toBe("z".repeat(32));
	});

	it("follows same-origin redirects and same-host HTTPS upgrades, and rejects cross-origin targets", async () => {
		const calls: { url: string; method?: string; headers: Headers; body?: BodyInit | null; redirect?: RequestRedirect }[] = [];
		const fetchTemporary = (async (input: URL | RequestInfo, init?: RequestInit) => {
			calls.push({ url: String(input), method: init?.method, headers: new Headers(init?.headers), body: init?.body, redirect: init?.redirect });
			if (calls.length === 1) return new Response(null, { status: 307, headers: { location: "/v2/mcp" } });
			return new Response("ok");
		}) as typeof fetch;
		const res = await fetchMcp("https://mcp.example/v1/mcp", { method: "POST", headers: { "X-API-Key": "secret" }, body: '{"a":1}' }, fetchTemporary);
		expect(res.url.href).toBe("https://mcp.example/v2/mcp");
		expect(calls.every(call => call.redirect === "manual")).toBe(true);
		expect(calls[1]?.method).toBe("POST");
		expect(calls[1]?.headers.get("x-api-key")).toBe("secret");
		expect(calls[1]?.body).toBe('{"a":1}');

		calls.length = 0;
		const fetchUpgrade = (async (input: URL | RequestInfo, init?: RequestInit) => {
			calls.push({ url: String(input), method: init?.method, headers: new Headers(init?.headers), body: init?.body, redirect: init?.redirect });
			if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "https://mcp.example/mcp" } });
			return new Response("ok");
		}) as typeof fetch;
		await fetchMcp("http://mcp.example/mcp", { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": "secret" }, body: "{}" }, fetchUpgrade);
		expect(calls[1]?.url).toBe("https://mcp.example/mcp");
		expect(calls[1]?.method).toBe("GET");
		expect(calls[1]?.body).toBeUndefined();
		expect(calls[1]?.headers.get("content-type")).toBeNull();

		for (const location of [
			"https://other.example/steal",
			"http://mcp.example/downgrade",
			"file:///etc/passwd",
			"https://user:pass@mcp.example/creds",
		]) {
			const seen: string[] = [];
			const fetcher = (async (input: URL | RequestInfo) => {
				seen.push(String(input));
				return new Response(null, { status: 307, headers: { location } });
			}) as typeof fetch;
			await expect(fetchMcp("https://mcp.example/mcp", { headers: { "X-API-Key": "secret" } }, fetcher)).rejects.toThrow();
			expect(seen).toHaveLength(1);
		}

		let hops = 0;
		const loopFetcher = (async () => {
			hops++;
			return new Response(null, { status: 307, headers: { location: `/hop/${hops}` } });
		}) as typeof fetch;
		await expect(fetchMcp("https://mcp.example/mcp", {}, loopFetcher)).rejects.toThrow(/too many times/);
		expect(hops).toBe(6);
	});
});
