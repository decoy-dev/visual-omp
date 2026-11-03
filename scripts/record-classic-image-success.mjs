import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const bin = process.env.OMP_BIN;
const source = process.env.OMP_SOURCE;
const version = process.env.VOMP_CLASSIC_FIXTURE_VERSION;
const destination = process.env.VOMP_CLASSIC_FIXTURE_DIR;
if (!bin || !source || !version || !destination) throw new Error("Set OMP_BIN, OMP_SOURCE, VOMP_CLASSIC_FIXTURE_VERSION and VOMP_CLASSIC_FIXTURE_DIR.");
// Keep node-pty external and resolvable from this checkout. Never launch Electron.
const scratch = await mkdtemp(resolve(".classic-image-recorder-"));
try {
	const outfile = join(scratch, "capture.mjs");
	await build({ entryPoints: [resolve("src/main/omp/classic-image-success.ts")], outfile, bundle: true, platform: "node", format: "esm", external: ["node-pty"], alias: { "@shared": resolve("src/shared") }, plugins: [{
		name: "standalone-renderer-broadcast",
		setup(build) {
			build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "standalone" }));
			// NativeBridge's renderer broadcast has no renderer in this standalone recorder.
			build.onLoad({ filter: /.*/, namespace: "standalone" }, () => ({ contents: "export const BrowserWindow = { getAllWindows: () => [] }; export const ipcMain = {};", loader: "js" }));
		},
	}] });
	const { captureClassicImageSuccess } = await import(pathToFileURL(outfile).href);
	const result = await captureClassicImageSuccess(resolve(bin), version, resolve(source), resolve(destination));
	console.log(JSON.stringify({ version: result.version, theme: result.theme, cases: result.cases.map(item => {
		const users = result.requests[item.providerIndex].messages.filter(message => message.role === "user");
		return { name: item.name, helperAccepted: item.helperAccepted, acknowledged: item.acknowledged, providerIndex: item.providerIndex, latestUserImages: users.at(-1).content.filter(part => part.type === "image_url").length, priorUserImages: users.slice(0, -1).reduce((sum, message) => sum + message.content.filter(part => part.type === "image_url").length, 0), cleared: item.cleared };
	}) }, null, 2));
} finally {
	await rm(scratch, { recursive: true, force: true });
}
