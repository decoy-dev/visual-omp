import { describe, expect, it } from "vitest";
import { findRoomHost, type RegisteredHost } from "./room-host";

const relayUrl = "ws://localhost:50180";
const roomId = "8La3MsRvImQgtFaBKNre6Q";
const linkTo = (relay: string, room: string) => `http://localhost:1/#${relay}/r/${room}.secret`;

function searchFor(links: Record<string, string | Error>, pid = 7132) {
	const asked: string[] = [];
	const search = {
		pid,
		spawnedAt: 1000,
		relayUrl,
		roomId,
		ruledOut: new Set<string>(),
		async linkFor(instanceId: string) {
			asked.push(instanceId);
			const link = links[instanceId];
			if (link instanceof Error) throw link;
			if (link === undefined) throw new Error(`no host ${instanceId}`);
			return link;
		},
	};
	return { search, asked };
}

describe("findRoomHost", () => {
	it("finds a room hosted by a child of the spawned launcher", async () => {
		// Bun's omp.exe launcher (7132) starts bun.exe (20012), which registers the host.
		const hosts: RegisteredHost[] = [{ instanceId: "child", pid: 20012, startedAt: 1500 }];
		const { search } = searchFor({ child: linkTo(relayUrl, roomId) });
		expect(await findRoomHost(hosts, search)).toEqual({ host: hosts[0], link: linkTo(relayUrl, roomId) });
	});

	it("never queries hosts that connected before the spawn", async () => {
		const hosts: RegisteredHost[] = [{ instanceId: "terminal", pid: 300, startedAt: 999 }];
		const { search, asked } = searchFor({ terminal: linkTo("ws://localhost:50100", "otherroom123") });
		expect(await findRoomHost(hosts, search)).toBeNull();
		expect(asked).toEqual([]);
	});

	it("asks each host on another relay once across retries", async () => {
		const hosts: RegisteredHost[] = [
			{ instanceId: "other", pid: 400, startedAt: 1200 },
			{ instanceId: "ours", pid: 20012, startedAt: 1300 },
		];
		const { search, asked } = searchFor({ other: linkTo("ws://localhost:50300", "otherroom123"), ours: new Error("not published") });
		expect(await findRoomHost(hosts, search)).toBeNull();
		expect(await findRoomHost(hosts, search)).toBeNull();
		expect(asked).toEqual(["other", "ours", "ours"]);
	});

	it("keeps asking a host on this relay until it reports the room", async () => {
		const hosts: RegisteredHost[] = [{ instanceId: "ours", pid: 7132, startedAt: 1100 }];
		const links: Record<string, string> = { ours: linkTo(relayUrl, "previousroom1") };
		const { search } = searchFor(links);
		expect(await findRoomHost(hosts, search)).toBeNull();
		links.ours = linkTo(relayUrl, roomId);
		expect(await findRoomHost(hosts, search)).toEqual({ host: hosts[0], link: linkTo(relayUrl, roomId) });
	});
});
