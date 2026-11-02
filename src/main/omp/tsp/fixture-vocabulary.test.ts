import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { isKnownAction, isKnownRole, TSP_READ_ONLY_ACTIONS } from "../../../shared/tsp/roles";
import { walkNodes } from "../../../shared/tsp/view-state";
import { TspSession } from "./session";

const committed = new URL("./fixtures/18.15.0/", import.meta.url);
function vocabulary(content: string) {
	const roles = new Set<string>(); const actions = new Set<string>(); const errors: Error[] = [];
	const session = new TspSession({ cols: 110, dark: false, reduceMotion: true, write: () => {}, onError: error => errors.push(error) });
	for (const line of content.trim().split("\n").filter(Boolean)) {
		const message: { verb: string; body: unknown } = JSON.parse(line);
		session.receive({ verb: message.verb, params: {}, body: JSON.stringify(message.body) });
		for (const surface of session.snapshot().surfaces) {
			if (surface.open.role) roles.add(surface.open.role);
			for (const node of walkNodes(surface.document)) {
				if (node.p?.role) roles.add(node.p.role);
				const declared = node.p?.actions;
				for (const action of Array.isArray(declared) ? declared.map(action => action.id) : [declared?.click, declared?.dblclick, ...(declared?.menu ?? [])]) if (action) actions.add(action);
				if (node.k === "prefs") for (const section of node.p?.sections ?? []) for (const row of section.rows) if (row.control.k === "action") actions.add(row.control.act);
			}
		}
	}
	expect(errors).toEqual([]);
	return { roles: [...roles].sort(), actions: [...actions].sort() };
}
it("recognizes every recorded role and explicitly classifies unsupported actions as read-only", () => {
	const files = readdirSync(committed).filter(file => file.endsWith(".messages.jsonl"));
	expect(files.length).toBeGreaterThan(25);
	for (const file of files) {
		const names = vocabulary(readFileSync(new URL(file, committed), "utf8"));
		expect(names.roles.filter(role => !isKnownRole(role)), file).toEqual([]);
		expect(names.actions.filter(action => !isKnownAction(action) && !Object.hasOwn(TSP_READ_ONLY_ACTIONS, action)), file).toEqual([]);
	}
});

const live = process.env.VOMP_TSP_LIVE_FIXTURE_DIR;
it.skipIf(!live)("compares scratch no-model re-recordings from standalone omp 18.15.0 with the committed registry vocabulary", () => {
	expect(process.env.OMP_BIN).toBeTruthy();
	const root = mkdtempSync(join(tmpdir(), "vomp-tsp-version-"));
	try {
		expect(execFileSync(process.env.OMP_BIN!, ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH!, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, PI_CODING_AGENT_DIR: root, PI_CONFIG_DIR: root, TMPDIR: root } }).trim()).toBe("omp/18.15.0");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	const files = readdirSync(live!).filter(file => file.endsWith(".messages.jsonl"));
	expect(files).toEqual(expect.arrayContaining(["hotkeys.messages.jsonl", "jobs.messages.jsonl", "usage.messages.jsonl", "session.messages.jsonl", "changelog.messages.jsonl", "tools.messages.jsonl", "model-picker.messages.jsonl", "settings-screen.messages.jsonl", "hook-select.messages.jsonl", "hook-confirm.messages.jsonl", "hook-input.messages.jsonl", "hook-editor.messages.jsonl"]));
	for (const file of files) {
		const current = vocabulary(readFileSync(join(live!, file), "utf8"));
		const baseline = vocabulary(readFileSync(new URL(file, committed), "utf8"));
		if (JSON.stringify(current) !== JSON.stringify(baseline)) console.info(`TSP live vocabulary difference: ${file}`, {
			addedRoles: current.roles.filter(role => !baseline.roles.includes(role)), removedRoles: baseline.roles.filter(role => !current.roles.includes(role)),
			addedActions: current.actions.filter(action => !baseline.actions.includes(action)), removedActions: baseline.actions.filter(action => !current.actions.includes(action)),
		});
		expect(current.roles.filter(role => !isKnownRole(role)), file).toEqual([]);
		expect(current.actions.filter(action => !isKnownAction(action) && !Object.hasOwn(TSP_READ_ONLY_ACTIONS, action)), file).toEqual([]);
	}
});
