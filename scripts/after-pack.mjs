import { join } from "node:path";
import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";

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
