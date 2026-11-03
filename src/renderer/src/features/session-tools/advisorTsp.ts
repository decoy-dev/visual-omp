import type { AdvisorFile, AdvisorScope } from "@shared/contracts/advisor";
import { advisorOverlay, type AdvisorOverlay, type TspAdvisorAction } from "@shared/tsp/advisor";
import { nodeHasLeft } from "@shared/tsp/dialogs";
import { TSP_ADVISOR, TSP_ROLES } from "@shared/tsp/roles";
import { walkNodes } from "@shared/tsp/view-state";
import { presentationClaims } from "../../state/tsp/presentation-claims";
import { isApprovalRequest, type SessionController } from "../../state/session";
import { TspEditorWatch } from "./drive";

/** File preservation stays main-owned, exactly as on the classic application path. */
export async function applyAdvisorSemantic(session: SessionController, scope: AdvisorScope): Promise<AdvisorFile> {
	const watch = new TspEditorWatch(session);
	let token: string | null = null;
	let finalized = false;
	let ownedKey: string | null = null;
	let driving = false;
	let release = () => {};
	const assertCurrent = () => {
		if (watch.ended || watch.snapshot?.closing || session.getSnapshot().readOnly) throw new Error("The chat changed before advisor configuration finished applying.");
		const guest = session.getSnapshot().guest;
		if (guest?.pendingUiRequests?.some(isApprovalRequest) || guest?.uiRequest && isApprovalRequest(guest.uiRequest)) throw new Error("Answer the approval before applying advisor configuration.");
	};
	const claim = () => {
		const target = driving ? advisorOverlay(watch.snapshot?.surfaces ?? []) : null;
		const key = target ? JSON.stringify([target.surface.open.id, target.node.id]) : null;
		if (key === ownedKey) return;
		release(); ownedKey = key;
		if (target && watch.snapshot) release = presentationClaims.acquire({ hostId: watch.snapshot.hostId, epoch: watch.snapshot.epoch, surfaceId: target.surface.open.id, nodeId: target.node.id });
	};
	const waitFor = (done: () => boolean, failure: string): Promise<void> => {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let off = () => {};
		const finish = (error?: unknown) => { clearTimeout(timer); off(); if (error) reject(error); else resolve(); };
		const timer = setTimeout(() => finish(new Error(failure)), 8000);
		const check = () => {
			try { assertCurrent(); if (done()) finish(); }
			catch (error) { finish(error); }
		};
		off = watch.subscribe(check); check();
		return promise;
	};
	const send = async (target: AdvisorOverlay, act: TspAdvisorAction["act"]) => {
		assertCurrent();
		const snapshot = watch.snapshot!;
		await window.vomp.invoke("host:tsp-advisor", snapshot.hostId, snapshot.generation, { sf: target.surface.open.id, id: target.node.id, scope: target.scope, act }, snapshot.epoch);
	};
	const off = watch.subscribe(claim);
	try {
		assertCurrent();
		await watch.ready();
		token = await window.vomp.invoke("advisor:beginApply", session.projectPath, scope);
		assertCurrent();
		if (!watch.available) throw new Error("Close the open omp menu before applying advisor configuration.");
		driving = true;
		await session.command(TSP_ADVISOR.command);
		await waitFor(() => !!advisorOverlay(watch.snapshot?.surfaces ?? []), "omp did not open its advisor configuration.");
		claim();
		let target = advisorOverlay(watch.snapshot!.surfaces)!;
		if (target.scope !== scope) {
			await send(target, "scope");
			await waitFor(() => {
				const current = advisorOverlay(watch.snapshot!.surfaces);
				if (!current || current.node.id !== target.node.id || current.surface.open.id !== target.surface.open.id) throw new Error("omp closed its advisor configuration before choosing the scope.");
				return current.scope === scope;
			}, "omp did not open the requested advisor configuration scope.");
			target = advisorOverlay(watch.snapshot!.surfaces)!;
		}
		const before = new Map(watch.snapshot!.surfaces.flatMap(surface => [...walkNodes(surface.document)].filter(node => node.k === "toast").map(node => [`${surface.open.id}:${node.id}`, node.p?.text ?? ""] as const)));
		await send(target, "apply");
		await waitFor(() => {
			let saved = false;
			for (const surface of watch.snapshot!.surfaces) for (const node of walkNodes(surface.document)) {
				if (node.k !== "toast" || surface.closed || surface.suspended || surface.documentGeneration !== watch.snapshot!.generation) continue;
				const text = node.p?.text ?? "";
				if (before.get(`${surface.open.id}:${node.id}`) === text) continue;
				if (text.startsWith(TSP_ADVISOR.errorPrefix)) throw new Error(text);
				if (node.p?.role === TSP_ROLES.toastStatus && text.startsWith(scope === "project" ? TSP_ADVISOR.savedProject : TSP_ADVISOR.savedUser)) saved = true;
			}
			return saved && nodeHasLeft(watch.snapshot!.surfaces, target.surface.open.id, target.node.id);
		}, "omp did not confirm applying the advisor configuration.");
		finalized = true;
		return await window.vomp.invoke("advisor:finishApply", token);
	} catch (error) {
		const target = advisorOverlay(watch.snapshot?.surfaces ?? []);
		if (!watch.ended && target && ownedKey === JSON.stringify([target.surface.open.id, target.node.id])) await send(target, "close").catch(() => undefined);
		if (token && !finalized) await window.vomp.invoke("advisor:finishApply", token);
		throw error;
	} finally { off(); release(); watch.dispose(); }
}
