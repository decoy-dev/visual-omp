import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { loadConfigFromFile } from "vite";
import afterPack from "./after-pack.mjs";

const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");

for (const platform of ["darwin", "win32"]) {
	test(`afterPack hardens the ${platform} packaged binary without running it`, async () => {
		const appOutDir = await mkdtemp(join(tmpdir(), "vomp-fuses-"));
		try {
			const executable = platform === "darwin"
				? join(appOutDir, "visual-omp.app", "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework")
				: join(appOutDir, "visual-omp.exe");
			// An inert fixture with a fuse wire exercises the real byte writer. The ninth fuse
			// represents a future Electron option that this hook must leave unchanged.
			const prefix = Buffer.from("inert binary fixture");
			const suffix = Buffer.from("unchanged suffix");
			await mkdir(dirname(executable), { recursive: true });
			await writeFile(executable, Buffer.concat([prefix, sentinel, Buffer.from([1, 9]), Buffer.from("111111111"), suffix]));
			await afterPack({
				appOutDir,
				electronPlatformName: platform,
				packager: { appInfo: { productFilename: "visual-omp" } },
			});
			assert.deepEqual(await readFile(executable), Buffer.concat([
				prefix, sentinel, Buffer.from([1, 9]), Buffer.from(platform === "darwin" ? "010011111" : "110011111"), suffix,
			]));
		} finally {
			await rm(appOutDir, { recursive: true, force: true });
		}
	});
}

test("afterPack rejects packaging when fuse writes fail", async () => {
	const appOutDir = await mkdtemp(join(tmpdir(), "vomp-fuses-error-"));
	try {
		await writeFile(join(appOutDir, "visual-omp.exe"), "missing fuse wire");
		await assert.rejects(afterPack({
			appOutDir,
			electronPlatformName: "win32",
			packager: { appInfo: { productFilename: "visual-omp" } },
		}), /Could not find sentinel/);
	} finally {
		await rm(appOutDir, { recursive: true, force: true });
	}
});

test("packaging wires fuses before signing and preserves unpacked node-pty", async () => {
	const config = parse(await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));
	assert.equal(config.afterPack, "./scripts/after-pack.mjs");
	assert.equal(config.afterSign, undefined);
	assert.equal(config.mac.sign, "./scripts/sign-mac.mjs");
	assert.equal(config.asar, true);
	assert.deepEqual(config.asarUnpack, ["node_modules/node-pty/**/*"]);
	assert.notEqual(config.disableAsarIntegrity, true);
});

test("main builds disable ws native loaders and reject any remaining bare require", async () => {
	const loaded = await loadConfigFromFile(
		{ command: "build", mode: "production" },
		fileURLToPath(new URL("../electron.vite.config.ts", import.meta.url)),
	);
	assert.ok(loaded);
	const { main } = loaded.config;
	assert.equal(JSON.parse(main.define["process.env.WS_NO_BUFFER_UTIL"]), "1");
	assert.equal(JSON.parse(main.define["process.env.WS_NO_UTF_8_VALIDATE"]), "1");
	assert.deepEqual(main.build.commonjsOptions.ignore, ["bufferutil", "utf-8-validate"]);
	const guard = main.plugins.find(plugin => plugin.name === "vomp:no-ws-native-loaders");
	assert.ok(guard);
	const context = { error(message) { throw new Error(message); } };
	for (const name of ["bufferutil", "utf-8-validate"]) {
		assert.throws(() => guard.generateBundle.call(context, {}, {
			main: { type: "chunk", fileName: "index.js", code: `require("${name}")` },
		}), /Optional ws native loader remains in index\.js/);
	}
	assert.doesNotThrow(() => guard.generateBundle.call(context, {}, {
		main: { type: "chunk", fileName: "index.js", code: 'require("node-pty")' },
	}));
});
