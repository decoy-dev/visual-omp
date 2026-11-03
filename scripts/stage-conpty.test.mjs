import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Arch } from "electron-builder";
import stageConpty, { CONPTY_FILES } from "./stage-conpty.mjs";

function context(appDir, arch) {
	return { electronPlatformName: "win32", arch, packager: { info: { appDir } } };
}

for (const [arch, name] of [[Arch.x64, "x64"], [Arch.arm64, "arm64"]]) {
	test(`beforePack stages ${name} from the target context and replaces stale host files`, async () => {
		const appDir = await mkdtemp(join(tmpdir(), "vomp-stage-conpty-"));
		try {
			const nodePtyDir = join(appDir, "node_modules", "node-pty");
			const versionsDir = join(nodePtyDir, "third_party", "conpty");
			for (const sourceArch of ["x64", "arm64"]) {
				const sourceDir = join(versionsDir, "1.23.251008001", `win10-${sourceArch}`);
				await mkdir(sourceDir, { recursive: true });
				for (const file of CONPTY_FILES) await writeFile(join(sourceDir, file), `${sourceArch}:${file}`);
			}
			await writeFile(join(versionsDir, "README.txt"), "Only directories count as versions.");
			const destinationDir = join(nodePtyDir, "build", "Release", "conpty");
			await mkdir(destinationDir, { recursive: true });
			for (const file of CONPTY_FILES) await writeFile(join(destinationDir, file), "stale host binary");
			await stageConpty(context(appDir, arch));
			assert.deepEqual((await readdir(destinationDir)).sort(), [...CONPTY_FILES].sort());
			for (const file of CONPTY_FILES) assert.equal(await readFile(join(destinationDir, file), "utf8"), `${name}:${file}`);
		} finally {
			await rm(appDir, { recursive: true, force: true });
		}
	});
}

for (const count of [0, 2]) {
	test(`beforePack rejects ${count} ConPTY version directories`, async () => {
		const appDir = await mkdtemp(join(tmpdir(), "vomp-stage-conpty-versions-"));
		try {
			const versionsDir = join(appDir, "node_modules", "node-pty", "third_party", "conpty");
			await mkdir(versionsDir, { recursive: true });
			for (let index = 0; index < count; index++) await mkdir(join(versionsDir, `version-${index}`));
			await assert.rejects(stageConpty(context(appDir, Arch.x64)), new RegExp(`Expected exactly one ConPTY version directory.*found ${count}`));
		} finally {
			await rm(appDir, { recursive: true, force: true });
		}
	});
}

test("beforePack does nothing for macOS without reading the architecture or filesystem", async () => {
	await stageConpty({ electronPlatformName: "darwin" });
});

test("beforePack rejects an unsupported Windows architecture", async () => {
	await assert.rejects(stageConpty(context("unused", Arch.ia32)), /Unsupported ConPTY target architecture/);
});

for (const missing of CONPTY_FILES) {
	test(`beforePack rejects missing source ${missing}`, async () => {
		const appDir = await mkdtemp(join(tmpdir(), "vomp-stage-conpty-missing-"));
		try {
			const sourceDir = join(appDir, "node_modules", "node-pty", "third_party", "conpty", "version", "win10-x64");
			await mkdir(sourceDir, { recursive: true });
			for (const file of CONPTY_FILES) if (file !== missing) await writeFile(join(sourceDir, file), "fixture");
			await assert.rejects(stageConpty(context(appDir, Arch.x64)), { code: "ENOENT" });
		} finally {
			await rm(appDir, { recursive: true, force: true });
		}
	});
}
