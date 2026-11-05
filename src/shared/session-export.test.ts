import { describe, expect, it } from "vitest";
import { parseSessionExportOutput } from "./session-export";

describe("parseSessionExportOutput", () => {
	it.each(["/project/omp-session-chat.html", "C:\\project\\omp-session-chat.html", "C:\\Users\\A User\\chat.html", "/project/name:chat.html"])("retains the complete path: %s", path => {
		const message = `Session exported to: ${path}`;
		expect(parseSessionExportOutput(["Unrelated output", message])).toEqual({ path, message });
	});
	it("accepts classic success decoration without incorporating it into the path", () => {
		expect(parseSessionExportOutput(["✔ Session exported to: C:\\project\\chat.html"])).toEqual({ path: "C:\\project\\chat.html", message: "✔ Session exported to: C:\\project\\chat.html" });
	});
	it.each(["", "Session exported to:", "Failed to export session: EEXIST", "Session exported to: \nother output"])("rejects output without a completion path: %j", line => {
		expect(parseSessionExportOutput([line])).toBeNull();
	});
});
