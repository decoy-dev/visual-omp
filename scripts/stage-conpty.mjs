import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Arch } from "electron-builder";

export const CONPTY_FILES = ["conpty.dll", "OpenConsole.exe"];

/** Accept electron-builder's Arch enum, or a CLI architecture for layout checks. */
export function conptyArchitecture(arch) {
	if (arch === Arch.x64 || arch === "x64") return "x64";
	if (arch === Arch.arm64 || arch === "arm64") return "arm64";
	throw new Error(`Unsupported ConPTY target architecture: ${arch}`);
}

/** Stage target-specific runtime files before electron-builder copies node-pty. */
export default async function stageConpty(context) {
	if (context.electronPlatformName !== "win32") return;
	const arch = conptyArchitecture(context.arch);
	const nodePtyDir = join(context.packager.info.appDir, "node_modules", "node-pty");
	const conptyDir = join(nodePtyDir, "third_party", "conpty");
	const versions = (await readdir(conptyDir, { withFileTypes: true })).filter(entry => entry.isDirectory());
	if (versions.length !== 1) {
		throw new Error(`Expected exactly one ConPTY version directory in ${conptyDir}; found ${versions.length}`);
	}
	const sourceDir = join(conptyDir, versions[0].name, `win10-${arch}`);
	const destinationDir = join(nodePtyDir, "build", "Release", "conpty");
	await mkdir(destinationDir, { recursive: true });
	for (const file of CONPTY_FILES) await copyFile(join(sourceDir, file), join(destinationDir, file));
}
