import { describe, expect, it } from "vitest";
import { commandChatFolder, defaultChatFolder } from "./chatFolder";

describe("default chat folder", () => {
	it("uses /tmp on macOS instead of its per-user temporary directory", () => {
		expect(defaultChatFolder("darwin", "/var/folders/user/T/")).toBe("/tmp");
	});
	it("uses /tmp on Linux even when TMPDIR points elsewhere", () => {
		expect(defaultChatFolder("linux", "/custom/temp")).toBe("/tmp");
	});
	it("uses the Windows system temp folder unchanged", () => {
		expect(defaultChatFolder("win32", "C:\\Users\\Chris\\AppData\\Local\\Temp")).toBe("C:\\Users\\Chris\\AppData\\Local\\Temp");
	});
});

describe("New chat command folder", () => {
	it("keeps the focused chat's project, including the secondary chat in a split", () => {
		expect(commandChatFolder("chat", "/focused", "/last-project")).toBe("/focused");
	});
	it("keeps an explicit slash command's originating chat", () => {
		expect(commandChatFolder("home", "/slash-origin", "/last-project")).toBe("/slash-origin");
	});
	it("keeps the project overview's folder", () => {
		expect(commandChatFolder("project", null, "/overview")).toBe("/overview");
	});
	it.each(["home", "page", "chat"] as const)("uses the default from %s without a showing chat", view => {
		expect(commandChatFolder(view, null, "/last-project")).toBeUndefined();
	});
	it("uses the default on first run without any projects", () => {
		expect(commandChatFolder("home", null, null)).toBeUndefined();
		expect(commandChatFolder("project", null, null)).toBeUndefined();
	});
});
