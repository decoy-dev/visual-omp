import { describe, expect, it } from "vitest";
import { restrictedFoldersForEdit } from "./permissionsModel";

describe("restricted folder edits", () => {
	it("retains global restrictions when starting a project-specific list", () => {
		expect(restrictedFoldersForEdit({ globalValue: ["/private", "~/records"], projectValue: null }, "project")).toEqual(["/private", "~/records"]);
	});
	it("never promotes project restrictions into the global scope", () => {
		expect(restrictedFoldersForEdit({ globalValue: null, projectValue: ["/project-secret"] }, "global")).toEqual([]);
	});
	it("keeps an explicitly empty project list and the global list independent", () => {
		const setting = { globalValue: ["/global-secret"], projectValue: [] };
		expect(restrictedFoldersForEdit(setting, "project")).toEqual([]);
		expect(restrictedFoldersForEdit(setting, "global")).toEqual(["/global-secret"]);
	});
});
