import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readReleaseTour } from "./release-tour";
import { projectPath } from "../omp/project-path";

let root: string;
let profile: string;
let seed: string;
let session: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "vomp-tour-startup-")));
	profile = join(root, "app-profile");
	seed = join(root, "tour-layout.json");
	session = join(root, "session.jsonl");
	mkdirSync(profile);
	writeFileSync(session, "{}\n");
	writeFileSync(join(root, "fixture.json"), JSON.stringify({ root }));
	writeFileSync(seed, JSON.stringify({ tabs: [{ id: "tour-one", title: "Check this chat", projectPath: root, sessionFile: session }] }));
	env = { VOMP_DEV_PROFILE: profile, VOMP_TOUR_CHATS: seed };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("ignores all tour environment variables in packaged builds", () => {
	expect(readReleaseTour(true, "/missing", { VOMP_TOUR_CHATS: "/missing" })).toBeUndefined();
});
it("leaves an ordinary development launch unchanged", () => {
	expect(readReleaseTour(false, profile, {})).toBeUndefined();
});
it("accepts fixture-local sessions and folders", () => {
	mkdirSync(join(root, "chat"));
	writeFileSync(seed, JSON.stringify({ tabs: [{ id: "tour-one", title: "Check", projectPath: join(root, "chat"), sessionFile: session }] }));
	expect(readReleaseTour(false, profile, env)).toMatchObject({ tabs: [{ sessionFile: session }] });
});
it("refuses missing or mismatched scratch profile overrides", () => {
	expect(() => readReleaseTour(false, profile, { VOMP_TOUR_CHATS: seed })).toThrow("absolute scratch profile");
	mkdirSync(join(root, "other-profile"));
	expect(() => readReleaseTour(false, join(root, "other-profile"), env)).toThrow("absolute scratch profile");
});
it("rejects an empty seed and paths outside the fixture root", () => {
	writeFileSync(seed, JSON.stringify({ tabs: [] }));
	expect(() => readReleaseTour(false, profile, env)).toThrow("fixture-local");
	writeFileSync(seed, JSON.stringify({ tabs: [{ projectPath: tmpdir(), sessionFile: session }] }));
	expect(() => readReleaseTour(false, profile, env)).toThrow("fixture-local");
});
it("rejects symlink escapes", () => {
	const outside = realpathSync(mkdtempSync(join(tmpdir(), "vomp-tour-outside-")));
	try {
		symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
		writeFileSync(seed, JSON.stringify({ tabs: [{ projectPath: join(root, "escape"), sessionFile: session }] }));
		expect(() => readReleaseTour(false, profile, env)).toThrow("fixture-local");
	} finally { rmSync(outside, { recursive: true, force: true }); }
});

it("rejects a seed-file symlink outside the fixture root", () => {
	const outside = realpathSync(mkdtempSync(join(tmpdir(), "vomp-tour-seed-outside-")));
	const linked = join(root, "linked-layout.json");
	try {
		const target = join(outside, "layout.json");
		writeFileSync(target, JSON.stringify({ tabs: [] }));
		symlinkSync(target, linked);
		expect(() => readReleaseTour(false, profile, { ...env, VOMP_TOUR_CHATS: linked })).toThrow("seed file must be inside");
	} finally { rmSync(outside, { recursive: true, force: true }); }
});

it("derives project selection from validated tabs and drops outside expanded projects", () => {
	const project = join(root, "chat");
	mkdirSync(project);
	writeFileSync(seed, JSON.stringify({
		tabs: [{ id: "tour-one", title: "Check", projectPath: project, sessionFile: session, extraPath: tmpdir() }],
		activeTabId: "tour-one", activeProject: tmpdir(), expandedProjects: [tmpdir()], arbitraryPath: tmpdir(),
	}));
	const result = readReleaseTour(false, profile, env);
	expect(result).toMatchObject({ activeProject: projectPath(project), expandedProjects: [], tabs: [{ projectPath: projectPath(project) }] });
	expect(result).not.toHaveProperty("arbitraryPath");
	expect(result).not.toHaveProperty("tabs.0.extraPath");
});
