import { describe, expect, it } from "vitest";
import { refusalMessage, smartAppControlOn, startRefusal } from "./refused";

/** What `child_process.spawn` throws for a CreateProcess error libuv cannot name. */
const unknownSpawn = () => Object.assign(new Error("spawn UNKNOWN"), { code: "UNKNOWN", errno: -4094, syscall: "spawn" });
const regOutput = (value: string) =>
	`\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy\r\n    VerifiedAndReputablePolicyState    REG_DWORD    ${value}\r\n\r\n`;
const path = "C:\\omp\\omp.exe";

describe("startRefusal", () => {
	it("tells an unexplained failure from a confirmed policy refusal", () => {
		expect(startRefusal(unknownSpawn(), "win32")).toBe("unexplained");
		expect(startRefusal(new Error("Cannot create process, error code: 4551"), "win32")).toBe("appControl");
		expect(startRefusal(new Error("Cannot create process, error code: 1260"), "win32")).toBe("groupPolicy");
	});

	it("leaves other start failures and other platforms alone", () => {
		expect(startRefusal(unknownSpawn(), "darwin")).toBeNull();
		expect(startRefusal(Object.assign(new Error("spawn omp ENOENT"), { code: "ENOENT", syscall: "spawn omp" }), "win32")).toBeNull();
		expect(startRefusal(new Error("Cannot create process, error code: 2"), "win32")).toBeNull();
		expect(startRefusal(new Error("Cannot create process, error code: 45510"), "win32")).toBeNull();
	});
});

describe("smartAppControlOn", () => {
	it("is on only in the enforcing state", () => {
		expect(smartAppControlOn(regOutput("0x1"))).toBe(true);
		expect(smartAppControlOn(regOutput("0x2"))).toBe(false);
		expect(smartAppControlOn(regOutput("0x0"))).toBe(false);
		expect(smartAppControlOn(regOutput("0x10"))).toBe(false);
		expect(smartAppControlOn("ERROR: The system was unable to find the specified registry key or value.\r\n")).toBe(false);
	});
});

describe("refusalMessage", () => {
	it("names Smart App Control only as a possible cause when it is on", () => {
		const message = refusalMessage("unexplained", path, "spawn UNKNOWN", true);
		expect(message).toContain("Smart App Control is on and may be the cause");
		expect(message).toContain("spawn UNKNOWN");
		expect(refusalMessage("unexplained", path, "spawn UNKNOWN", false)).not.toContain("Smart App Control");
	});

	it("never blames Smart App Control for a Group Policy refusal", () => {
		const message = refusalMessage("groupPolicy", path, "Cannot create process, error code: 1260", true);
		expect(message).not.toContain("Smart App Control");
		expect(message).toContain("error code: 1260");
	});
});
