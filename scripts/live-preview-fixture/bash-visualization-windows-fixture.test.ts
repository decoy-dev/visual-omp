import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps the sentinel idle until named pressure and launches only its exact nested command", async () => {
	const root = await mkdtemp(join(tmpdir(), "vomp-windows-sentinel-test-"));
	const home = join(root, "home"); await mkdir(home);
	const standin = join(root, "native-standin.mjs");
	// This unit-only child records argv and exits through an owned file. It is not omp or a Windows API test.
	// Integration clock: fake timers cannot advance the real child process's file-based pressure timer.
	await writeFile(standin, `import {existsSync,writeFileSync} from 'node:fs';import {join} from 'node:path';const root=${JSON.stringify(root)};writeFileSync(join(root,'argv.json'),JSON.stringify({pid:process.pid,parent:process.ppid,args:process.argv.slice(2)}));const finish=()=>{writeFileSync(join(root,'ended'),'done');process.exit(0)};setInterval(()=>{if(existsSync(join(root,'stop')))finish()},10);setTimeout(finish,4000);`);
	const args = ["--mode", "rpc", "two words", 'quote"arg', "café"];
	const child = spawn(process.execPath, [fileURLToPath(new URL("./bash-visualization-windows-sentinel.mjs", import.meta.url)), "node", root, process.execPath, standin, ...args], {
		cwd: root, windowsHide: true, stdio: "ignore", env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(root, "agent"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state") },
	});
	const exit = Promise.withResolvers<number | null>();
	child.once("error", exit.reject); child.once("exit", exit.resolve);
	void exit.promise.catch(() => {});
	const json = async (name: string) => JSON.parse(await readFile(join(root, name), "utf8")) as Record<string, unknown>;
	async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean) {
		const end = Date.now() + 3000;
		while (Date.now() < end) {
			try { const value = await read(); if (predicate(value)) return value; } catch { /* The child publishes atomically. */ }
			await sleep(10);
		}
		throw new Error("The isolated sentinel did not publish its expected state");
	}
	try {
		const state = await waitFor(() => json("node.json"), value => typeof value.ompPid === "number");
		const receipt = await waitFor(() => json("argv.json"), value => Array.isArray(value.args));
		expect(state.retainedBytes).toBe(0);
		expect(state.pid).toBe(child.pid);
		expect(state.parentPid).toBe(process.pid);
		expect(state.ompPid).toBe(receipt.pid);
		expect(receipt.parent).toBe(child.pid);
		expect(receipt.args).toEqual(args);
		expect(state.ompArgs).toEqual([standin, ...args]);
		await writeFile(join(root, "pressure-start"), "start");
		const pressured = await waitFor(() => json("node.json"), value => typeof value.retainedBytes === "number" && value.retainedBytes >= 32 * 1024 ** 2);
		expect(pressured.ompPid).toBe(receipt.pid);
	} finally {
		await writeFile(join(root, "stop"), "stop");
		try { expect(await exit.promise).toBe(0); } finally { await rm(root, { recursive: true, force: true }); }
	}
}, 10_000);
