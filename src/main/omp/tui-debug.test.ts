import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TuiDebugClient } from "./tui-debug";

// Upstream-shaped socket replies exercise the overlay projection used by readiness.
type Overlay = { hidden?: boolean; root: { kind: string } };
let directory: string;
let server: Server;
let client: TuiDebugClient;
let registered: number;
let overlays: Overlay[];
let requests: string[];
const sockets = new Set<Socket>();

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "vd-"));
	const path = process.platform === "win32" ? `\\\\.\\pipe\\vomp-debug-test-${randomUUID()}` : join(directory, "tui.sock");
	registered = 0;
	overlays = [];
	requests = [];
	server = createServer(socket => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", chunk => {
			buffer += chunk;
			let newline: number;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				const request = JSON.parse(buffer.slice(0, newline)) as { op: string };
				buffer = buffer.slice(newline + 1);
				requests.push(request.op);
				const response = request.op === "info"
					? { ok: true, overlays: registered, focused: "CustomEditor", alt_screen: false }
					: request.op === "tree"
						? { ok: true, tree: { root: { kind: "TUI" }, overlays } }
						: { ok: false, error: `unexpected fixture op ${request.op}` };
				socket.write(`${JSON.stringify(response)}\n`);
			}
		});
	});
	const listening = once(server, "listening");
	server.listen(path);
	await listening;
	client = new TuiDebugClient(path);
});

afterEach(async () => {
	client.close();
	for (const socket of sockets) socket.destroy();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	server.close(error => error ? reject(error) : resolve());
	await promise;
	await rm(directory, { recursive: true, force: true });
});


describe("TuiDebugClient visible overlay projection", () => {
	it("does not report hidden registrations as open menus", async () => {
		registered = 2;
		overlays = [
			{ hidden: true, root: { kind: "ExtensionPanel" } },
			{ hidden: true, root: { kind: "AnotherPanel" } },
		];

		const focus = await client.info();
		expect(focus).toEqual({ focused: "CustomEditor", overlays: 0, overlayKinds: [], altScreen: false });
		expect(requests).toEqual(["info", "tree"]);
	});

	it("reports visible modal overlays beside hidden registrations", async () => {
		registered = 3;
		overlays = [
			{ hidden: true, root: { kind: "ExtensionPanel" } },
			{ root: { kind: "HookSelector" } },
			{ hidden: false, root: { kind: "ModelPicker" } },
		];

		const focus = await client.info();
		expect(focus.overlays).toBe(2);
		expect(focus.overlayKinds).toEqual(["HookSelector", "ModelPicker"]);
	});

	it("uses the tree count when an overlay closes between info and tree", async () => {
		registered = 1;
		overlays = [];

		const focus = await client.info();
		expect(focus.overlays).toBe(focus.overlayKinds.length);
		expect(focus.overlays).toBe(0);
	});

	it("does not request a tree when upstream has no registered overlays", async () => {
		expect(await client.info()).toEqual({ focused: "CustomEditor", overlays: 0, overlayKinds: [], altScreen: false });
		expect(requests).toEqual(["info"]);
	});
});

describe("TuiDebugClient read guard", () => {
	it("refuses every debug read before connecting or requesting socket data", async () => {
		const attempted: string[] = [];
		const guarded = new TuiDebugClient("unreachable-debug-socket", operation => {
			attempted.push(operation);
			throw new Error("Painted reads are unavailable for this host.");
		});
		try {
			for (const read of [() => guarded.info(), () => guarded.screen(), () => guarded.paint(), () => guarded.values()]) {
				await expect(read()).rejects.toThrow("Painted reads are unavailable");
			}
			expect(attempted).toEqual(["info", "text", "text", "values"]);
			expect(requests).toEqual([]);
		} finally { guarded.close(); }
	});

	it("guards the separate tree request when info reports a registered overlay", async () => {
		client.close();
		const address = server.address();
		if (typeof address !== "string") throw new Error("Expected the fixture socket path.");
		const attempted: string[] = [];
		client = new TuiDebugClient(address, operation => {
			attempted.push(operation);
			if (operation === "tree") throw new Error("Tree reads are unavailable.");
		});
		registered = 1;
		await expect(client.info()).rejects.toThrow("Tree reads are unavailable");
		expect(attempted).toEqual(["info", "tree"]);
		expect(requests).toEqual(["info"]);
	});
});
