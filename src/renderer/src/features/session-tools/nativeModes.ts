import type { ModeRequest, SessionModes } from "@shared/contracts/native";
import type { SessionController } from "../../state/session";
import { screenPoller } from "./status";

export async function sessionModes(session: SessionController): Promise<SessionModes> {
	await session.ensureLive();
	await session.whenLive();
	const hostId = session.hostId;
	if (!hostId) throw new Error("The chat's omp host is unavailable");
	const snapshot = await window.vomp.invoke("native:snapshot", hostId);
	if (!snapshot.modes) throw new Error("omp's native mode controls are not ready");
	return snapshot.modes;
}

/** omp owns validation, busy/conflict decisions and mode persistence. A switch never submits a prompt. */
export async function setSessionMode(session: SessionController, request: ModeRequest): Promise<SessionModes> {
	await sessionModes(session);
	const result = await window.vomp.invoke("native:setMode", session.hostId!, request);
	if (!result.ok) throw new Error(result.message);
	await screenPoller(session).refresh();
	return result.state;
}
