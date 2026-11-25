import { describe, expect, it } from "vitest";
import { fetchRemoteImage, MAX_REMOTE_IMAGE_BYTES } from "./remote-image";

describe("fetchRemoteImage", () => {
	it("fetches allowed image MIME types without credentials or referrer", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const payload = new Uint8Array([137, 80, 78, 71]);
		const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
			calls.push({ url: String(input), init });
			return new Response(payload, { status: 200, headers: { "content-type": "image/png; charset=binary" } });
		}) as typeof fetch;

		const result = await fetchRemoteImage("https://images.example/photo.png", fetcher);
		expect(result.mimeType).toBe("image/png");
		expect(result.bytes).toEqual(payload);
		expect(calls[0]?.init?.redirect).toBe("manual");
		expect(calls[0]?.init?.credentials).toBe("omit");
		expect(calls[0]?.init?.referrerPolicy).toBe("no-referrer");

		const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
		const svgRes = await fetchRemoteImage("https://images.example/diagram.svg", (async () => new Response(svg, { headers: { "content-type": "image/svg+xml" } })) as typeof fetch);
		expect(svgRes.mimeType).toBe("image/svg+xml");
		expect(svgRes.bytes).toEqual(svg);
	});

	it("follows valid HTTPS redirects and blocks protocol downgrades, non-http targets, and loops", async () => {
		let hops = 0;
		const redirectOk = (async () => {
			hops++;
			if (hops === 1) return new Response(null, { status: 302, headers: { location: "https://cdn.example/img.jpg" } });
			return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpg" } });
		}) as typeof fetch;
		const upgraded = await fetchRemoteImage("http://images.example/img.jpg", redirectOk);
		expect(upgraded.mimeType).toBe("image/jpeg");
		expect(hops).toBe(2);

		for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "https://user:pass@images.example/a.png"]) {
			await expect(fetchRemoteImage(bad, (async () => new Response()) as typeof fetch)).rejects.toThrow();
		}

		await expect(
			fetchRemoteImage(
				"https://images.example/a.png",
				(async () => new Response(null, { status: 302, headers: { location: "http://images.example/downgraded.png" } })) as typeof fetch,
			),
		).rejects.toThrow(/HTTPS to HTTP/);

		await expect(
			fetchRemoteImage(
				"https://images.example/a.png",
				(async () => new Response(null, { status: 302, headers: { location: "https://images.example/loop" } })) as typeof fetch,
			),
		).rejects.toThrow(/too many times/);
	});

	it("rejects disallowed MIME types, empty bodies, and oversized responses", async () => {
		await expect(
			fetchRemoteImage("https://images.example/page", (async () => new Response("<html/>", { headers: { "content-type": "text/html" } })) as typeof fetch),
		).rejects.toThrow(/supported image type/);

		await expect(
			fetchRemoteImage("https://images.example/empty.png", (async () => new Response(new Uint8Array(), { headers: { "content-type": "image/png" } })) as typeof fetch),
		).rejects.toThrow(/empty/);

		await expect(
			fetchRemoteImage(
				"https://images.example/huge.png",
				(async () => new Response(new Uint8Array(8), { headers: { "content-type": "image/png", "content-length": String(MAX_REMOTE_IMAGE_BYTES + 1) } })) as typeof fetch,
			),
		).rejects.toThrow(/exceeded/);

		const streamed = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(40));
				controller.enqueue(new Uint8Array(40));
				controller.close();
			},
		});
		await expect(
			fetchRemoteImage("https://images.example/stream.png", (async () => new Response(streamed, { headers: { "content-type": "image/png" } })) as typeof fetch, 64),
		).rejects.toThrow(/exceeded 64 bytes/);
	});
});
