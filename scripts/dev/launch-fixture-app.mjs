// Run this script inside the Windows VM, including from an interactive scheduled task.
// It reconstructs the fixture environment instead of relying on the task's inherited env.
import { spawn } from "node:child_process";
import { stat, mkdir, realpath } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { requireFixture } from "../live-preview-fixture/environment.mjs";

const args = process.argv.slice(2);
const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const root = value("--root");
const exe = value("--exe");
const port = Number(value("--port", 9335));
const mainPort = Number(value("--main-port", 9336));
if (!root || !exe || !Number.isInteger(port) || port <= 0 || port > 65535 || !Number.isInteger(mainPort) || mainPort <= 0 || mainPort > 65535 || port === mainPort) {
  throw new Error("Usage: node scripts/dev/launch-fixture-app.mjs --root <fixture-root> --exe <unpacked-app-exe> [--port 9335] [--main-port 9336] [--enable-inspector]");
}
const environment = await requireFixture(root);
const binary = resolve(exe);
if (!(await stat(binary)).isFile()) throw new Error("The app executable must be a file.");
if (args.includes("--enable-inspector")) {
  // Release builds disable Node CLI inspection. Change only a disposable, fixture-local copy.
  const path = relative(await realpath(root), await realpath(binary));
  if (path === ".." || path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(path) || !binary.toLowerCase().endsWith(".exe")) {
    throw new Error("--enable-inspector requires a copied Windows executable beneath the fixture root.");
  }
  const { flipFuses, FuseVersion, FuseV1Options } = await import("@electron/fuses");
  await flipFuses(binary, { version: FuseVersion.V1, [FuseV1Options.EnableNodeCliInspectArguments]: true });
}
const profile = join(resolve(root), "app-profile");
await mkdir(profile, { recursive: true });
const child = spawn(binary, [
  `--user-data-dir=${profile}`,
  "--remote-debugging-address=127.0.0.1",
  `--remote-debugging-port=${port}`,
  `--inspect=127.0.0.1:${mainPort}`,
  // Occlusion must not invalidate the visible phase. Explicit hide still pauses rAF.
  "--disable-backgrounding-occluded-windows",
], { cwd: join(resolve(root), "work"), env: environment, stdio: "inherit" });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
console.log(`Fixture app profile: ${profile}`);
