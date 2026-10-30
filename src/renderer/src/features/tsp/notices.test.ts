import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { TspFrame, TspNode } from "@shared/tsp";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { TSP_CLAIMS, TSP_NOTICE_ROLES, TSP_ROLES, isReplicatedRole } from "@shared/tsp/roles";
import { describe, expect, it } from "vitest";
import { TspDocument } from "../../../../main/omp/tsp/apply";
import usageRecording from "../../../../main/omp/tsp/fixtures/18.14.0/usage.messages.jsonl?raw";
import { TspNoticeProjection, placeTspNotices } from "./notices";

const user = (id: string) => ({ id, parentId: null, type: "message", message: { role: "user", content: "hello" } }) as SessionEntry;
const custom = (id: string, content: string, parentId = "u1") => ({ id, parentId, type: "custom_message", customType: "example", display: true, content }) as SessionEntry;
const error = (value: string, role: string = TSP_ROLES.noticeError): TspNode => ({ id: "notice", k: "text", p: { role, text: value } });
const toast = (value: string): TspNode => ({ id: "status", k: "toast", p: { role: TSP_ROLES.toastStatus, text: value } });
function snapshot(nodes: TspNode[], epoch = 1, generation = 1): TspHostSnapshot {
	return {
		hostId: "host", epoch, generation, revision: 1, negotiated: true, lifecycle: "live", documentGeneration: generation,
		availability: { available: true, reason: null }, failure: null,
		surfaces: [{ open: { id: "surface", mode: "inline", role: TSP_ROLES.session }, sequence: 1, closed: false, suspended: false, focus: null, settled: [], documentGeneration: generation,
			document: { id: "root", k: "col", c: [{ id: "main", k: "col", c: nodes.filter(node => node.k !== "toast") }, { id: "layer", k: "col", c: nodes.filter(node => node.k === "toast") }] } }],
	};
}

describe("TSP transcript notices", () => {
	it("claims only implemented notice roles and keeps collab transcript roles separate", () => {
		for (const role of Object.keys(TSP_NOTICE_ROLES)) { expect(TSP_CLAIMS[role]).toBe("transcript-notices"); expect(isReplicatedRole(role)).toBe(false); }
		for (const role of [TSP_ROLES.user, TSP_ROLES.assistant, TSP_ROLES.thinking, TSP_ROLES.tool, TSP_ROLES.agent]) expect(isReplicatedRole(role)).toBe(true);
	});
	it("anchors an error after the latest collab entry and retains one row across replay", () => {
		const projection = new TspNoticeProjection();
		projection.collab([user("u1")], []);
		projection.apply(snapshot([error("Unable to load model.")]));
		projection.collab([user("u1"), custom("other", "Different output")], []);
		projection.apply(snapshot([error("Unable to load model.")]));
		expect(projection.getSnapshot()).toMatchObject([{ anchor: "u1", turn: "u1", level: "error", content: "Unable to load model." }]);
	});
	it("updates a reused toast row without moving its original anchor", () => {
		const projection = new TspNoticeProjection();
		projection.collab([user("u1")], []); projection.apply(snapshot([toast("Loading…")]));
		const id = projection.getSnapshot()[0]?.id;
		projection.collab([user("u1"), custom("later", "Other output")], []); projection.apply(snapshot([toast("Complete.")]));
		expect(projection.getSnapshot()).toMatchObject([{ id, anchor: "u1", content: "Complete." }]);
	});
	it("skips omp's notices about this app's own collab connection but keeps other guests", () => {
		for (const own of ["collab: visual-omp joined the collab session", "collab: visual-omp joined the collab session (read-only)", "collab: visual-omp left the collab session"]) {
			const projection = new TspNoticeProjection();
			projection.collab([user("u1")], []); projection.apply(snapshot([toast(own)]));
			expect(projection.getSnapshot()).toEqual([]);
		}
		const projection = new TspNoticeProjection();
		projection.collab([user("u1")], []); projection.apply(snapshot([toast("collab: Alice joined the collab session")]));
		expect(projection.getSnapshot()).toMatchObject([{ content: "collab: Alice joined the collab session" }]);
	});
	it.each(["event", "custom"] as const)("suppresses a duplicate collab %s in either arrival order", source => {
		for (const collabFirst of [false, true]) {
			const projection = new TspNoticeProjection();
			projection.collab([user("u1")], []);
			const duplicate = () => projection.collab(source === "custom" ? [user("u1"), custom("duplicate", "No model.")] : [user("u1")], source === "event" ? [{ id: 1, level: "warning", message: "No model.", at: 1 }] : []);
			if (collabFirst) duplicate();
			projection.apply(snapshot([error("No model.", TSP_ROLES.noticeWarning)]));
			if (!collabFirst) duplicate();
			expect(projection.getSnapshot()).toEqual([]);
		}
	});
	it("keeps the same text in a later turn and clears old rows on a new epoch", () => {
		const projection = new TspNoticeProjection();
		projection.collab([user("u1"), custom("duplicate", "No model.")], []);
		projection.collab([user("u1"), custom("duplicate", "No model."), user("u2")], []);
		projection.apply(snapshot([error("No model.")]));
		expect(projection.getSnapshot()).toHaveLength(1);
		projection.apply(snapshot([], 2)); expect(projection.getSnapshot()).toEqual([]);
		projection.apply(snapshot([error("New process.")], 2));
		expect(projection.getSnapshot()).toMatchObject([{ id: "tsp:2:surface:notice", content: "New process." }]);
	});
	it("does not project unchanged old document notices into another room", () => {
		const projection = new TspNoticeProjection();
		projection.collab([user("old")], []); projection.apply(snapshot([error("Old warning.")]));
		projection.rotate(); projection.collab([user("new")], []); projection.apply(snapshot([error("Old warning.")], 1, 2));
		expect(projection.getSnapshot()).toEqual([]);
		projection.apply(snapshot([error("New warning.")], 1, 2));
		expect(projection.getSnapshot()).toMatchObject([{ anchor: "new", content: "New warning." }]);
		projection.reset(); expect(projection.getSnapshot()).toEqual([]);
	});
	it("places notices only beside visible anchors on the displayed branch", () => {
		const projection = new TspNoticeProjection(); projection.collab([], []); projection.apply(snapshot([error("Startup warning.")]));
		projection.collab([user("u1")], []); projection.apply(snapshot([{ ...error("Later warning."), id: "later" }]));
		const entries = [user("u1"), user("u2")];
		expect(placeTspNotices(entries, 0, projection.getSnapshot()).top).toHaveLength(1);
		expect(placeTspNotices(entries, 0, projection.getSnapshot()).after.get("u1")).toHaveLength(1);
		expect(placeTspNotices(entries, 1, projection.getSnapshot()).after.size).toBe(0);
		expect(placeTspNotices([user("branch")], 0, projection.getSnapshot()).after.size).toBe(0);
	});
	it("projects the recorded usage and startup warnings once", () => {
		const projection = new TspNoticeProjection();
		projection.collab([], []);
		const document = new TspDocument("s:1");
		for (const line of usageRecording.trim().split("\n")) {
			const message = JSON.parse(line) as { verb: string; body: TspFrame };
			if (message.verb !== "f") continue;
			expect(document.applyFrame(message.body)).toEqual([]);
			const current = snapshot([]);
			current.surfaces[0]!.document = document.snapshot();
			projection.apply(current);
			projection.apply(current);
		}
		expect(projection.getSnapshot().filter(notice => notice.content === "No usage data available.")).toHaveLength(1);
		expect(projection.getSnapshot().filter(notice => notice.content.startsWith("No default model selected."))).toHaveLength(1);
	});
	it("attributes historical custom messages by their parent branch rather than file order", () => {
		const projection = new TspNoticeProjection();
		const first = user("u1");
		const abandoned = { ...user("u2"), parentId: "u1" };
		const notice = custom("fork-notice", "Same output.", "u1");
		const entries = [first, abandoned, notice];
		projection.collab(entries, [], [first, abandoned]);
		projection.apply(snapshot([error("Same output.")]));
		expect(projection.getSnapshot()).toMatchObject([{ anchor: "u2", turn: "u2" }]);
		projection.collab(entries, [], [first, notice]);
		projection.apply(snapshot([{ ...error("Same output."), id: "fork-error" }]));
		expect(projection.getSnapshot()).toHaveLength(1);
	});
});
