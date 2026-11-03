import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { loadConfigFromFile } from "vite";
import { Arch } from "electron-builder";
import afterPack, { assertConptyLayout } from "./after-pack.mjs";

const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");

const conptyFiles = ["conpty.dll", "OpenConsole.exe"];

function peFixture(arch) {
	const bytes = Buffer.alloc(256);
	bytes.writeUInt16LE(0x5a4d, 0);
	bytes.writeUInt32LE(0x80, 0x3c);
	bytes.writeUInt32LE(0x00004550, 0x80);
	bytes.writeUInt16LE(arch === "x64" ? 0x8664 : 0xaa64, 0x84);
	return bytes;
}

function conptyDirectory(appOutDir) {
	return join(appOutDir, "resources", "app.asar.unpacked", "node_modules", "node-pty", "build", "Release", "conpty");
}

async function writeConpty(appOutDir, arch) {
	const directory = conptyDirectory(appOutDir);
	await mkdir(directory, { recursive: true });
	for (const file of conptyFiles) await writeFile(join(directory, file), peFixture(arch));
	return conptyFiles.map(file => join(directory, file));
}

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
			if (platform === "win32") await writeConpty(appOutDir, "x64");
			await afterPack({
				appOutDir,
				electronPlatformName: platform,
				arch: Arch.x64,
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
		await writeConpty(appOutDir, "x64");
		await assert.rejects(afterPack({
			appOutDir,
			electronPlatformName: "win32",
			arch: Arch.x64,
			packager: { appInfo: { productFilename: "visual-omp" } },
		}), /Could not find sentinel/);
	} finally {
		await rm(appOutDir, { recursive: true, force: true });
	}
});

test("packaging wires fuses before signing and preserves unpacked node-pty", async () => {
	const config = parse(await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));
	assert.equal(config.beforePack, "./scripts/stage-conpty.mjs");
	assert.equal(config.afterExtract, "./scripts/stage-conpty.mjs");
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

for (const [arch, name] of [[Arch.x64, "x64"], [Arch.arm64, "arm64"], ["x64", "x64"], ["arm64", "arm64"]]) {
	test(`ConPTY layout accepts ${name} PE machine for architecture ${arch}`, async () => {
		const appOutDir = await mkdtemp(join(tmpdir(), "vomp-conpty-layout-"));
		try {
			const files = await writeConpty(appOutDir, name);
			assert.deepEqual(await assertConptyLayout(appOutDir, arch), files);
		} finally {
			await rm(appOutDir, { recursive: true, force: true });
		}
	});
}

for (const file of conptyFiles) {
	test(`ConPTY layout rejects missing ${file}`, async () => {
		const appOutDir = await mkdtemp(join(tmpdir(), "vomp-conpty-layout-missing-"));
		try {
			await writeConpty(appOutDir, "x64");
			await rm(join(conptyDirectory(appOutDir), file));
			await assert.rejects(assertConptyLayout(appOutDir, Arch.x64), error =>
				error.message.includes("Missing or unreadable packaged ConPTY file") && error.message.includes(file));
		} finally {
			await rm(appOutDir, { recursive: true, force: true });
		}
	});

	for (const [arch, wrongArch] of [["x64", "arm64"], ["arm64", "x64"]]) {
		test(`ConPTY layout rejects ${wrongArch} ${file} for ${arch}`, async () => {
			const appOutDir = await mkdtemp(join(tmpdir(), "vomp-conpty-layout-machine-"));
			try {
				await writeConpty(appOutDir, arch);
				await writeFile(join(conptyDirectory(appOutDir), file), peFixture(wrongArch));
				await assert.rejects(assertConptyLayout(appOutDir, arch), error =>
					error.message.includes(file) && error.message.includes(`expected ${arch}`));
			} finally {
				await rm(appOutDir, { recursive: true, force: true });
			}
		});
	}
}

for (const [name, corrupt] of [
	["truncated DOS header", () => Buffer.alloc(10)],
	["missing DOS signature", bytes => { bytes.writeUInt16LE(0, 0); return bytes; }],
	["missing PE signature", bytes => { bytes.writeUInt32LE(0, 0x80); return bytes; }],
	["PE offset outside file", bytes => { bytes.writeUInt32LE(0xffffffff, 0x3c); return bytes; }],
	["PE offset inside DOS header", bytes => { bytes.writeUInt32LE(0, 0x3c); return bytes; }],
	["truncated COFF header", bytes => bytes.subarray(0, 0x80 + 23)],
]) {
	test(`ConPTY layout rejects ${name}`, async () => {
		const appOutDir = await mkdtemp(join(tmpdir(), "vomp-conpty-layout-invalid-"));
		try {
			await writeConpty(appOutDir, "x64");
			await writeFile(join(conptyDirectory(appOutDir), "OpenConsole.exe"), corrupt(peFixture("x64")));
			await assert.rejects(assertConptyLayout(appOutDir, Arch.x64), /Invalid PE.*OpenConsole\.exe/);
		} finally {
			await rm(appOutDir, { recursive: true, force: true });
		}
	});
}

test("afterPack rejects an invalid Windows ConPTY layout before writing fuses", async () => {
	const appOutDir = await mkdtemp(join(tmpdir(), "vomp-conpty-layout-hook-"));
	try {
		const executable = join(appOutDir, "visual-omp.exe");
		const fixture = Buffer.concat([sentinel, Buffer.from([1, 9]), Buffer.from("111111111")]);
		await writeFile(executable, fixture);
		await assert.rejects(afterPack({
			appOutDir,
			arch: Arch.x64,
			electronPlatformName: "win32",
			packager: { appInfo: { productFilename: "visual-omp" } },
		}), /Missing or unreadable packaged ConPTY file/);
		assert.deepEqual(await readFile(executable), fixture);
	} finally {
		await rm(appOutDir, { recursive: true, force: true });
	}
});
