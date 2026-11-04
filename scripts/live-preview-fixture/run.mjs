import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { requireFixture } from "./environment.mjs";

const [root, ...args] = process.argv.slice(2);
if (!root || !args.length) throw new Error("Usage: node run.mjs <fixture-root> [--cwd <directory>] <command> [args...]");
let cwd = join(resolve(root), "work");
if (args[0] === "--cwd") {
  args.shift();
  cwd = resolve(args.shift());
}
const command = args.shift();
if (!command) throw new Error("A command is required.");
const child = spawn(command, args, { cwd, env: await requireFixture(root), stdio: "inherit" });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
