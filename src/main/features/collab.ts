/**
 * Live sharing: publish a chat's loopback collab room to omp's public relay (see
 * `@shared/contracts/collab` and `RoomBridge` in `../omp/relay`).
 */
import { z } from "zod";
import type { LiveShareState } from "@shared/contracts/collab";
import { broadcast, handle } from "../ipc";
import { readConfig } from "../omp/config-file";
import { getHost } from "../omp/host";
import { type BridgeStatus, relayHosting, type RoomBridge } from "../omp/relay";
import { DEFAULT_RELAY_ORIGIN, formatWebLink, normalizeRelayOrigin, parseRoomLink } from "./collab/links";

const CollabSettings = z.object({
	collab: z
		.object({ relayUrl: z.string().optional(), webUrl: z.string().optional() })
		.partial()
		.optional()
		.catch(undefined),
});

interface Share {
	bridge: RoomBridge;
	state: LiveShareState;
	unsubscribe(): void;
}

const shares = new Map<string, Share>();

/** `collab.relayUrl` / `collab.webUrl` from the project layer, else the global layer. */
async function relaySettings(cwd: string): Promise<{ relayUrl: string | undefined; webUrl: string | undefined }> {
	const [project, global] = await Promise.all([
		readConfig("project", cwd).catch(() => ({ data: {} })),
		readConfig("global").catch(() => ({ data: {} })),
	]);
	const projectCollab = CollabSettings.safeParse(project.data).data?.collab;
	const globalCollab = CollabSettings.safeParse(global.data).data?.collab;
	return {
		relayUrl: projectCollab?.relayUrl ?? globalCollab?.relayUrl,
		webUrl: projectCollab?.webUrl ?? globalCollab?.webUrl,
	};
}

/** Use the configured relay unless it points at this chat's private loopback relay. */
function publicOrigin(relayUrl: string | undefined, localRelayUrl: string): string {
	if (!relayUrl?.trim()) return DEFAULT_RELAY_ORIGIN;
	const origin = normalizeRelayOrigin(relayUrl.trim());
	if (origin === normalizeRelayOrigin(localRelayUrl)) return DEFAULT_RELAY_ORIGIN;
	return origin;
}

function withStatus(state: LiveShareState, status: BridgeStatus): LiveShareState {
	return {
		...state,
		phase: status.phase,
		remoteGuests: status.remoteGuests,
		error: status.error,
		endedReason: status.reason,
	};
}

async function publish(hostId: string): Promise<LiveShareState> {
	const host = getHost(hostId);
	if (!host.state.link) throw new Error("This chat isn't running yet. Send a message or wait a moment, then try again.");
	const room = parseRoomLink(host.state.link);
	const existing = shares.get(hostId);
	if (existing && existing.state.roomId === room.roomId && existing.state.phase !== "stopped") return existing.state;
	if (existing) unpublish(hostId);
	const relay = relayHosting(room.roomId);
	if (!relay) throw new Error("This chat isn't running right now.");
	const { relayUrl, webUrl } = await relaySettings(host.state.cwd);
	const relayOrigin = publicOrigin(relayUrl, relay.url);
	const bridge = relay.publish(room.roomId, relayOrigin);
	const base: LiveShareState = {
		hostId,
		roomId: room.roomId,
		phase: bridge.status.phase,
		relayOrigin,
		controlLink: formatWebLink(relayOrigin, room.roomId, room.key, room.writeToken, webUrl),
		viewLink: formatWebLink(relayOrigin, room.roomId, room.key, null, webUrl),
		remoteGuests: 0,
		error: null,
		endedReason: null,
	};
	const share: Share = {
		bridge,
		state: withStatus(base, bridge.status),
		unsubscribe: bridge.onStatus(status => {
			share.state = withStatus(share.state, status);
			broadcast("collab:shareState", share.state);
			if (status.phase === "stopped") share.unsubscribe();
		}),
	};
	shares.set(hostId, share);
	broadcast("collab:shareState", share.state);
	return share.state;
}

function unpublish(hostId: string): void {
	const share = shares.get(hostId);
	if (!share) return;
	if (share.state.phase !== "stopped") relayHosting(share.state.roomId)?.unpublish(share.state.roomId);
	// A bridge whose relay is already gone has nobody left to stop it.
	share.bridge.stop("stopped");
}

export function register(): void {
	handle("collab:publish", hostId => publish(hostId));
	handle("collab:unpublish", hostId => unpublish(hostId));
	handle("collab:shared", hostId => shares.get(hostId)?.state ?? null);
}
