import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";
import { CONPTY_FILES, conptyArchitecture } from "./stage-conpty.mjs";

/** Validate the unpacked Windows runtime without loading or executing its binaries. */
export async function assertConptyLayout(appOutDir, arch) {
	const target = conptyArchitecture(arch);
	const expectedMachine = target === "x64" ? 0x8664 : 0xaa64;
	const directory = resolve(appOutDir, "resources", "app.asar.unpacked", "node_modules", "node-pty", "build", "Release", "conpty");
	const files = CONPTY_FILES.map(file => join(directory, file));
	for (const file of files) {
		let bytes;
		try {
			bytes = await readFile(file);
		} catch (cause) {
			throw new Error(`Missing or unreadable packaged ConPTY file: ${file}`, { cause });
		}
		if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) {
			throw new Error(`Invalid PE DOS header in packaged ConPTY file: ${file}`);
		}
		const peOffset = bytes.readUInt32LE(0x3c);
		if (peOffset < 64 || peOffset > bytes.length - 24 || bytes.readUInt32LE(peOffset) !== 0x00004550) {
			throw new Error(`Invalid PE signature in packaged ConPTY file: ${file}`);
		}
		const machine = bytes.readUInt16LE(peOffset + 4);
		if (machine !== expectedMachine) {
			throw new Error(`Packaged ConPTY file ${file} has PE machine 0x${machine.toString(16)}; expected ${target} (0x${expectedMachine.toString(16)})`);
		}
	}
	return files;
}

/**
 * electron-builder calls afterPack after writing ASAR integrity metadata and before signing.
 * ASAR-only startup restricts the entry archive; it does not prevent node-pty from loading
 * its unpacked addon and spawn-helper. Integrity validates the archive, not unpacked files.
 * Do not reset the ad hoc signature here: the existing mac.sign hook signs the whole bundle
 * after these bytes change. A fuse failure rejects packaging rather than shipping defaults.
 */
export default async function afterPack(context) {
	const extension = { darwin: ".app", win32: ".exe" }[context.electronPlatformName];
	if (extension === undefined) throw new Error(`Unsupported fuse target: ${context.electronPlatformName}`);
	if (context.electronPlatformName === "win32") await assertConptyLayout(context.appOutDir, context.arch);
	const executable = join(context.appOutDir, `${context.packager.appInfo.productFilename}${extension}`);
	await flipFuses(executable, {
		version: FuseVersion.V1,
		// Windows node-pty kills console descendants through child_process.fork, which needs
		// Electron's Node mode. Keep it enabled there until node-pty offers another cleanup path.
		[FuseV1Options.RunAsNode]: context.electronPlatformName === "win32",
		[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
		[FuseV1Options.EnableNodeCliInspectArguments]: false,
		[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
		[FuseV1Options.OnlyLoadAppFromAsar]: true,
	});
}
