import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeText } from "./files";

describe("writeText", () => {
	let dir = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "vomp-write-text-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes atomically without following a predictable pid temp symlink", async () => {
		const target = join(dir, "config.yml");
		const decoy = join(dir, "decoy.txt");
		writeFileSync(decoy, "untouched");
		symlinkSync(decoy, `${target}.${process.pid}.tmp`);

		await writeText(target, "secret: true\n", { mode: 0o600 });

		expect(readFileSync(target, "utf8")).toBe("secret: true\n");
		expect(readFileSync(decoy, "utf8")).toBe("untouched");
		expect(lstatSync(target).isSymbolicLink()).toBe(false);
		if (process.platform !== "win32") {
			expect(statSync(target).mode & 0o777).toBe(0o600);
		}
	});
});
