/**
 * Which entry in omp's collab registry (`omp collab list --json`) hosts a chat's room.
 *
 * The registry names each host by the pid of the omp process, which is not always the process the
 * app spawned. On Windows, an omp installed with `bun install -g` is Bun's `omp.exe` launcher,
 * which starts `bun.exe` as a child, and that child hosts the room. The control link is the proof
 * of a match, so hosts registered under the spawned pid are tried first, then hosts that connected
 * to a relay after the spawn. Hosts that started earlier belong to other chats or terminals and
 * are never queried.
 */

export interface RegisteredHost {
	instanceId: string;
	pid: number;
	/** Epoch milliseconds when the host first connected to its relay. */
	startedAt: number;
}

export interface RoomHostSearch {
	/** pid of the process the app spawned. */
	pid: number | undefined;
	/** Epoch milliseconds just before the spawn. */
	spawnedAt: number;
	/** The chat's private relay (`ws://localhost:<port>`), which only the spawned omp connects to. */
	relayUrl: string;
	roomId: string;
	/** Instance ids whose links name another relay; the search adds to it so retries skip them. */
	ruledOut: Set<string>;
	/** The host's control link (`omp collab link <instanceId> --json`). */
	linkFor(instanceId: string): Promise<string>;
}

export async function findRoomHost<T extends RegisteredHost>(hosts: readonly T[], search: RoomHostSearch): Promise<{ host: T; link: string } | null> {
	const spawned = hosts.filter(host => host.pid === search.pid);
	const later = hosts.filter(host => host.pid !== search.pid && host.startedAt >= search.spawnedAt);
	for (const host of [...spawned, ...later]) {
		if (search.ruledOut.has(host.instanceId)) continue;
		let link: string;
		try {
			link = await search.linkFor(host.instanceId);
		} catch {
			// A host can exit or still be publishing; ask again on the next attempt.
			continue;
		}
		if (link.includes(`/r/${search.roomId}.`)) return { host, link };
		if (!link.includes(`${search.relayUrl}/r/`)) search.ruledOut.add(host.instanceId);
	}
	return null;
}
