import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { IPty } from "node-pty";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PersistentRpc } from "./rpc";
import { createNativeBridge, type NativeBridge } from "./native-bridge";
import { draftEnvironment } from "./draft-environment";

// Explicit opt-in prevents normal tests from launching the owner's installed omp or using their agent directory.
const runtime = vi.hoisted(() => ({ binary: process.env.VOMP_DRAFT_SECURITY_BINARY, agentDir: process.env.VOMP_DRAFT_SECURITY_AGENT_DIR, env: {} as NodeJS.ProcessEnv }));
vi.mock("./locate", () => ({ ompPath: async () => runtime.binary! }));
vi.mock("../env", () => ({ userEnv: async () => runtime.env }));
vi.mock("../ipc", () => ({ broadcast: vi.fn() }));
const clients: PersistentRpc[] = [];
const ptys: IPty[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const bridges: NativeBridge[] = [];
const directories: string[] = [];
const agentFiles = new Map<string, string | null>();
const sockets: string[] = [];

async function save(path: string, content: string): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, content);
}
async function saveAgent(path: string, content: string): Promise<void> {
	if (!agentFiles.has(path)) agentFiles.set(path, await readFile(path, "utf8").catch(() => null));
	await save(path, content);
}

async function debugRequest(path: string, op: string) {
	const result = Promise.withResolvers<unknown>();
	const socket = connect(path);
	let bytes = "";
	socket.once("connect", () => socket.write(`${JSON.stringify({ op })}\n`));
	socket.on("data", data => {
		bytes += String(data);
		if (!bytes.includes("\n")) return;
		try { result.resolve(JSON.parse(bytes.slice(0, bytes.indexOf("\n")))); } catch (error) { result.reject(error); }
	});
	socket.once("error", result.reject);
	// A real debug socket needs an OS watchdog rather than a guessed readiness sleep.
	const timer = setTimeout(() => result.reject(new Error("TUI debug response timed out.")), 5000);
	try { return z.object({ ok: z.boolean(), values: z.record(z.string(), z.unknown()).optional(), lines: z.array(z.string()).optional() }).parse(await result.promise); }
	finally { clearTimeout(timer); socket.destroy(); }
}
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "composer-runtime-"));
	directories.push(root);
	const home = join(root, "home"), agent = runtime.agentDir!, project = join(root, "project");
	await Promise.all([home, agent, project].map(path => mkdir(path, { recursive: true })));
	runtime.env = { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agent, XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join(root, "run") };
	return { root, home, agent, project };
}
async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const ended = Promise.withResolvers<void>();
	child.once("exit", () => ended.resolve());
	child.stdin.end();
	// This real-process integration needs an OS teardown watchdog; fake timers cannot deliver a child exit.
	const timer = setTimeout(() => child.kill(), 3000);
	await ended.promise;
	clearTimeout(timer);
}
afterEach(async () => {
	for (const client of clients.splice(0)) client.close(true);
	await Promise.all(children.splice(0).map(stop));
	await Promise.all(bridges.splice(0).map(bridge => bridge.close()));
	for (const [path, previous] of agentFiles) {
		if (previous === null) await rm(path, { force: true });
		else await writeFile(path, previous);
	}
	agentFiles.clear();
	for (const child of ptys.splice(0)) { try { child.kill(); } catch { /* It may already have exited through debug quit. */ } }
	await Promise.all(sockets.splice(0).map(path => rm(path, { force: true })));
	await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe.skipIf(!runtime.binary || !runtime.agentDir)("isolated omp 18.14 composer runtime", () => {
	it("never executes project MCP commands, extension modules or inherited preloads in either draft process", async () => {
		const files = await fixture();
		const mcpMarker = join(files.root, "mcp-executed"), extensionMarker = join(files.root, "extension-executed"), preloadMarker = join(files.root, "preload-executed");
		const extension = join(files.project, ".omp/extensions/hostile.mjs");
		await save(extension, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(extensionMarker)},'executed'); export default function(){}\n`);
		const preload = join(files.root, "preload.cjs");
		await save(preload, `require('node:fs').writeFileSync(${JSON.stringify(preloadMarker)},'executed');\n`);
		const mcp = JSON.stringify({ mcpServers: { hostile: { type: "stdio", command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(mcpMarker)},'executed')`] } } });
		await save(join(files.project, ".omp/mcp.json"), mcp);
		await save(join(files.project, ".mcp.json"), mcp);
		await saveAgent(join(files.agent, "mcp.json"), mcp);
		const hostileConfig = join(files.root, "hostile.yml");
		await save(hostileConfig, JSON.stringify({ extensions: [extension], disabledProviders: [], mcp: { enableProjectConfig: true } }));
		await save(join(files.project, ".omp/config.yml"), JSON.stringify({ extensions: [extension] }));
		runtime.env = { ...runtime.env, NODE_OPTIONS: `--require ${preload}`, BUN_OPTIONS: `--preload ${extension}`, PI_CONFIG_FILES: hostileConfig, VOMP_NATIVE_BRIDGE: "http://127.0.0.1:1/host-control", OMP_TUI_DEBUG: join(files.root, "host-control.sock") };
		const word = new PersistentRpc(files.project, ["--model", "anthropic/claude-sonnet-4-6", "--config", hostileConfig]); clients.push(word);
		await expect(word.request("predict_word", { text: "please rev", cursor: 10 })).resolves.toHaveProperty("suffix");
		const speechConfig = join(files.root, "speech.yml");
		await save(speechConfig, "stt:\n  enabled: true\n");
		const voice = new PersistentRpc(files.project, ["--model", "anthropic/claude-sonnet-4-6", "--config", hostileConfig, "--config", speechConfig]); clients.push(voice);
		// Stop with no capture tests voice-process startup without touching the mic or downloading a speech model.
		await expect(voice.request("dictation_stop", {})).resolves.toEqual({ text: "" });
		for (const marker of [mcpMarker, extensionMarker, preloadMarker]) expect(existsSync(marker), marker).toBe(false);
	}, 120_000);

	it("uses effective user/project discovery, nested aliases, toggles and precedence from the compiled SDK", async () => {
		const files = await fixture();
		await save(join(files.home, ".claude/commands/user-side.md"), "---\nside: true\n---\nUser question\n");
		await save(join(files.project, ".claude/commands/folder/deep.md"), "---\nside: true\n---\nNested question\n");
		await save(join(files.project, ".claude/commands/folder/collision.md"), "---\nside: true\n---\nNested question\n");
		await save(join(files.project, ".claude/commands/collision.md"), "Root command\n");
		await save(join(files.project, ".claude/commands/shadowed.md"), "---\nside: true\n---\nShadowed file\n");
		await save(join(files.project, ".claude/commands/shared.md"), "---\nside: true\n---\nClaude file\n");
		await saveAgent(join(files.agent, "commands/shared.md"), "---\nside: true\n---\nUser native file\n");
		await save(join(files.project, ".omp/commands/shared.md"), "Project native command\n");
		const shadowExtension = join(files.root, "registered-command.mjs");
		await save(shadowExtension, "export default function(pi){pi.registerCommand('shadowed',{description:'Registered extension command',handler:async()=>{}})}\n");
		const cases = [
			{ user: true, project: true, disabled: [] as string[], present: ["user-side", "deep", "folder:deep", "folder:collision"], absent: ["collision", "shared", "shadowed"] },
			{ user: false, project: true, disabled: [] as string[], present: ["deep", "folder:deep"], absent: ["user-side", "collision", "shared", "shadowed"] },
			{ user: true, project: false, disabled: [] as string[], present: ["user-side"], absent: ["deep", "folder:deep", "folder:collision", "shared", "shadowed"] },
			{ user: true, project: true, disabled: ["claude"], present: [], absent: ["user-side", "deep", "folder:deep", "folder:collision", "shared", "shadowed"] },
		];
		for (const [index, test] of cases.entries()) {
			const config = join(files.root, `commands-${index}.yml`);
			await save(config, JSON.stringify({ commands: { enableClaudeUser: test.user, enableClaudeProject: test.project }, disabledProviders: test.disabled }));
			const privateDir = join(files.root, `bridge-${index}`); await mkdir(privateDir);
			const bridge = await createNativeBridge(`composer-${index}`, privateDir); bridges.push(bridge);
			const child = spawn(runtime.binary!, ["--mode", "rpc", "--model", "anthropic/claude-sonnet-4-6", "--no-session", "--no-extensions", "--no-context-files", "--no-rules", "--no-skills", "--no-lsp", "--no-title", "--no-tools", "--config", config, "-e", bridge.extensionPath, "-e", shadowExtension], { cwd: files.project, env: { ...draftEnvironment(runtime.env), VOMP_NATIVE_BRIDGE: bridge.url }, stdio: "pipe" });
			children.push(child); child.stdout.resume();
			let diagnostic = ""; child.stderr.on("data", data => { diagnostic += String(data); });
			const exited = Promise.withResolvers<never>();
			child.once("exit", code => exited.reject(new Error(`Discovery fixture exited (${code}): ${diagnostic}`)));
			const names = await Promise.race([bridge.sideCommands(), exited.promise]);
			for (const name of test.present) expect(names, `case ${index}`).toContain(name);
			for (const name of test.absent) expect(names, `case ${index}`).not.toContain(name);
			await stop(child);
			// The bridge's own source remains the tested generated extension, not a replacement harness.
			expect(await readFile(bridge.extensionPath, "utf8")).toContain("discoverSlashCommands");
		}
	}, 120_000);
	it("reads and clears a real wrapped TUI draft over 120 code units through the exact SDK API", async () => {
		const files = await fixture();
		const full = `Please inspect https://example.test/${"long_identifier_".repeat(15)}?a=one|two&b=日本語🧭 and preserve literal | pipes.`;
		const editorFixture = join(files.root, "editor-fixture.mjs");
		await save(editorFixture, `export default function(pi){pi.on('session_start',async(_event,ctx)=>{ctx.ui.setEditorText(${JSON.stringify(full)})})}\n`);
		const privateDir = join(files.root, "editor-bridge"); await mkdir(privateDir);
		const bridge = await createNativeBridge("wrapped-editor", privateDir); bridges.push(bridge);
		const debugPath = `/tmp/composer-wrap-${process.pid}-${Date.now()}.sock`; sockets.push(debugPath);
		// Load the native PTY binding only in this explicitly opted-in platform integration case.
		const { spawn: spawnPty } = await import("node-pty");
		const child = spawnPty(runtime.binary!, ["--model", "anthropic/claude-sonnet-4-6", "--no-session", "--no-extensions", "--no-context-files", "--no-rules", "--no-skills", "--no-lsp", "--no-title", "--no-tools", "-e", bridge.extensionPath, "-e", editorFixture], { cwd: files.project, env: { ...draftEnvironment(runtime.env), VOMP_NATIVE_BRIDGE: bridge.url, OMP_TUI_DEBUG: debugPath, TERM: "xterm-256color" }, name: "xterm-256color", cols: 60, rows: 30 });
		ptys.push(child);
		let diagnostic = "";
		child.onData(data => { diagnostic = (diagnostic + data).slice(-8000); });
		const failed = Promise.withResolvers<never>(), ended = Promise.withResolvers<void>();
		child.onExit(event => { ended.resolve(); failed.reject(new Error(`Wrapped fixture exited (${event.exitCode}): ${diagnostic}`)); });
		await Promise.race([bridge.sideCommands(), failed.promise]).catch(error => { throw new Error(`${String(error)}\n${diagnostic}`); });
		const sessionId = bridge.snapshot.location!.sessionId;
		const exact = await bridge.editorDraft({ operation: "peek", sessionId });
		expect(exact.text).toBe(full);
		const values = await debugRequest(debugPath, "values");
		const editor = Object.values(values.values ?? {}).map(value => z.object({ textPreview: z.string(), textLength: z.number(), previewTruncated: z.boolean() }).safeParse(value)).find(value => value.success && value.data.textLength === full.length);
		expect(editor?.success && editor.data.previewTruncated).toBe(true);
		expect(editor?.success && editor.data.textPreview).toBe(full.slice(0, 120));
		const paint = await debugRequest(debugPath, "text");
		expect(paint.lines?.some(line => line.includes("https://example.test/"))).toBe(true);
		expect(paint.lines?.join("\n")).not.toContain(full);
		const taken = await bridge.editorDraft({ operation: "take", sessionId, expected: full });
		expect(taken).toEqual({ text: full, cleared: true });
		await expect(bridge.editorDraft({ operation: "peek", sessionId })).resolves.toEqual({ text: "", cleared: true });
		if (process.env.VOMP_COMPOSER_EVIDENCE_DIR) {
			await mkdir(process.env.VOMP_COMPOSER_EVIDENCE_DIR, { recursive: true });
			await writeFile(join(process.env.VOMP_COMPOSER_EVIDENCE_DIR, "wrapped-editor.json"), JSON.stringify({ full, values, paint, taken }, null, 2));
		}
		await debugRequest(debugPath, "quit");
		await ended.promise;
	}, 120_000);
});
