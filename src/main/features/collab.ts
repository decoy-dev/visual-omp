/**
 * Live sharing: publish a chat's loopback collab room to omp's public relay (see
 * `@shared/contracts/collab` and `RoomBridge` in `../omp/relay`).
 */
import { z } from "zod";
import { dialog, powerSaveBlocker } from "electron";
import type { LiveShareState } from "@shared/contracts/collab";
import { broadcast, handle } from "../ipc";
import { readConfig } from "../omp/config-file";
import { getHost, onHostState } from "../omp/host";
import { type BridgeStatus, relayHosting, type RoomBridge } from "../omp/relay";
import { DEFAULT_RELAY_ORIGIN, formatWebLink, normalizeRelayOrigin, parseRoomLink, webBase } from "./collab/links";

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
	webUrl: string | undefined;
	active: boolean;
	unsubscribe(): void;
}

const shares = new Map<string, Share>();
const pending = new Map<string, { cancelled: boolean; result: Promise<LiveShareState> }>();
let sleepBlocker: number | null = null;

function updateSleepBlocker(): void {
	const active = [...shares.values()].some(share => share.active);
	if (active && sleepBlocker === null) sleepBlocker = powerSaveBlocker.start("prevent-app-suspension");
	if (!active && sleepBlocker !== null) {
		powerSaveBlocker.stop(sleepBlocker);
		sleepBlocker = null;
	}
}

function announce(share: Share): void {
	share.state = { ...share.state, keepsAwake: share.active && sleepBlocker !== null };
	broadcast("collab:shareState", share.state);
}

function finish(share: Share, reason: "stopped" | "room-closed", error: string | null = null): void {
	share.active = false;
	share.unsubscribe();
	relayHosting(share.state.roomId)?.unpublish(share.state.roomId);
	share.bridge.stop(reason);
	share.state = { ...share.state, phase: "stopped", remoteGuests: 0, error, endedReason: reason };
	updateSleepBlocker();
	announce(share);
}

/** Reuse the endpoints approved at Start sharing; a rotation never accepts new project settings. */
function connectRoom(share: Share, link: string): void {
	const room = parseRoomLink(link);
	const relay = relayHosting(room.roomId);
	if (!relay) throw new Error("This chat isn't running right now.");
	share.unsubscribe();
	share.bridge.stop("room-closed");
	const bridge = relay.publish(room.roomId, share.state.relayOrigin);
	share.bridge = bridge;
	share.state = {
		...withStatus(share.state, bridge.status),
		roomId: room.roomId,
		controlLink: formatWebLink(share.state.relayOrigin, room.roomId, room.key, room.writeToken, share.webUrl),
		viewLink: formatWebLink(share.state.relayOrigin, room.roomId, room.key, null, share.webUrl),
		linkChanged: share.state.linkChanged || room.roomId !== share.state.roomId,
	};
	listen(share);
	announce(share);
}

function waitForRoom(share: Share): void {
	share.state = { ...share.state, phase: "reconnecting", controlLink: "", viewLink: "", remoteGuests: 0, error: null, endedReason: null };
	announce(share);
}

function listen(share: Share): void {
	share.unsubscribe = share.bridge.onStatus(status => {
		if (!share.active) return;
		if (status.phase === "stopped" && status.reason === "room-closed") {
			waitForRoom(share);
		} else if (status.phase === "stopped") {
			finish(share, "stopped", status.error);
		} else {
			share.state = withStatus(share.state, status);
			announce(share);
		}
	});
}

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

async function publish(hostId: string, request: { cancelled: boolean }): Promise<LiveShareState> {
	const host = getHost(hostId);
	if (!host.state.link) throw new Error("This chat isn't running yet. Send a message or wait a moment, then try again.");
	const formatLocalLink = host.state.link;
	const room = parseRoomLink(host.state.link);
	const existing = shares.get(hostId);
	if (existing && existing.state.roomId === room.roomId && existing.state.phase !== "stopped") return existing.state;
	if (existing?.active) return existing.state;
	const relay = relayHosting(room.roomId);
	if (!relay) throw new Error("This chat isn't running right now.");
	const { relayUrl, webUrl } = await relaySettings(host.state.cwd);
	const relayOrigin = publicOrigin(relayUrl, relay.url);
	const browserUrl = webBase(relayOrigin, webUrl);
	if (relayOrigin !== DEFAULT_RELAY_ORIGIN || browserUrl !== webBase(DEFAULT_RELAY_ORIGIN, undefined)) {
		const { response } = await dialog.showMessageBox({
			type: "warning",
			title: "Share through a custom server?",
			message: "This chat will use a custom sharing server.",
			detail: `Relay: ${relayOrigin}\nBrowser client: ${browserUrl}\n\nThe browser client receives the chat key and can read this conversation. A control link also permits sending prompts. Continue only if you trust these servers.`,
			buttons: ["Cancel", "Share chat"],
			defaultId: 0,
			cancelId: 0,
			noLink: true,
		});
		if (response !== 1) throw new Error("Sharing was cancelled.");
	}
	if (request.cancelled || getHost(hostId) !== host || host.state.link === null || host.state.link !== formatLocalLink) {
		throw new Error("The chat changed before sharing started. Try sharing again.");
	}
	const bridge = relay.publish(room.roomId, relayOrigin);
	const share: Share = {
		bridge,
		webUrl,
		active: true,
		unsubscribe: () => {},
		state: withStatus({
			hostId,
			roomId: room.roomId,
			phase: bridge.status.phase,
			relayOrigin,
			controlLink: formatWebLink(relayOrigin, room.roomId, room.key, room.writeToken, webUrl),
			viewLink: formatWebLink(relayOrigin, room.roomId, room.key, null, webUrl),
			linkChanged: false,
			keepsAwake: false,
			remoteGuests: 0,
			error: null,
			endedReason: null,
		}, bridge.status),
	};
	shares.set(hostId, share);
	try {
		updateSleepBlocker();
	} catch (error) {
		finish(share, "stopped");
		throw error;
	}
	listen(share);
	announce(share);
	return share.state;
}

function unpublish(hostId: string): void {
	const request = pending.get(hostId);
	if (request) request.cancelled = true;
	const share = shares.get(hostId);
	if (share) finish(share, "stopped");
}

export function register(): void {
	onHostState(state => {
		const share = shares.get(state.hostId);
		if (!share?.active) return;
		if (state.phase === "exited") {
			finish(share, "room-closed");
		} else if (!state.link) {
			if (share.state.controlLink) waitForRoom(share);
		} else {
			try {
				if (parseRoomLink(state.link).roomId !== share.state.roomId) connectRoom(share, state.link);
			} catch (error) {
				finish(share, "room-closed", error instanceof Error ? error.message : String(error));
			}
		}
	});
	handle("collab:publish", hostId => {
		const running = pending.get(hostId);
		if (running) return running.result;
		const request = { cancelled: false, result: null! as Promise<LiveShareState> };
		request.result = publish(hostId, request).finally(() => {
			if (pending.get(hostId) === request) pending.delete(hostId);
		});
		pending.set(hostId, request);
		return request.result;
	});
	handle("collab:unpublish", hostId => unpublish(hostId));
	handle("collab:shared", hostId => shares.get(hostId)?.state ?? null);
}
