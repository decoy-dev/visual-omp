import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve, win32 } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createWindowsShellJob, type WindowsShellJob } from "../../src/main/omp/shell-visualization-windows";
import { SHELL_WINDOWS_MONITOR } from "../../src/main/omp/shell-visualization-windows-source";
import { shellWorkerEnvironment } from "../../src/main/omp/shell-visualization-worker";
import { OMP_DISCOVERY_ISOLATION } from "../../src/main/omp/discovery-isolation";
import visualizationEvidence from "./bash-visualization-worker.mjs";

// Bundle as ESM with pi-natives external; its import belongs to installed omp.
export const evidenceExtensionSource = `export default ${visualizationEvidence.toString()};\n`;

export const CASE_LIMITS = {
	startupMs: 15_000, captureMs: 15_000, requestMs: 2_000, sampleMs: 100,
	jobRssBytes: 512 * 1024 ** 2, monitorRssBytes: 160 * 1024 ** 2,
	outputBytes: 2 * 1024 ** 2, presentationBytes: 2 * 1024 ** 2, traceBytes: 16 * 1024 ** 2,
	bridgeBytes: 32 * 1024 ** 2,
} as const;
export interface CaseArgs { omp: string; output: string }
export function parseCaseArgs(args: string[]): CaseArgs {
	const values: Partial<CaseArgs> = {};
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index];
		if (flag !== "--omp" && flag !== "--output") throw new Error("Use --omp <absolute executable> --output <new absolute directory>.");
		const key = flag === "--omp" ? "omp" : "output";
		const value = args[index + 1];
		if (!value || value.startsWith("--") || values[key] !== undefined || !win32.isAbsolute(value) || !/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(value) || value.includes("\0")) throw new Error(`Invalid or repeated ${flag}.`);
		values[key] = win32.normalize(value);
	}
	if (!values.omp || !values.output) throw new Error("Both --omp and --output are required.");
	if (!/\.(exe|com)$/i.test(values.omp)) throw new Error("--omp must name a native Windows executable.");
	if (!/^[a-z]:[\\/]/i.test(values.output) || win32.dirname(values.output) === values.output) throw new Error("--output must name a new directory below a Windows drive root.");
	return values as CaseArgs;
}
export function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
export function driveAlias(path: string, mount = false): string {
	if (!/^[a-z]:[\\/]/i.test(path)) throw new Error("A drive-qualified fixture path is required.");
	return `${mount ? "/mnt" : ""}/${path[0]!.toLowerCase()}${path.slice(2).replaceAll("\\", "/")}`;
}
const nativePath = (path: string) => path.replaceAll("\\", "/");
export function caseEnvironment(source: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
	return { ...shellWorkerEnvironment(source, root), OMP_SKIP_SETUP: "1", PI_NO_PTY: "1", PI_BASH_NO_LOGIN: "1", PI_NOTIFICATIONS: "off", OTEL_SDK_DISABLED: "true" };
}
export function caseConfig() {
	return { ...OMP_DISCOVERY_ISOLATION, setupVersion: 999, startup: { setupWizard: false, checkUpdate: false, changelogMode: "hidden", quiet: true },
		update: { auto: false }, marketplace: { autoUpdate: "off" }, recap: { enabled: false }, memory: { backend: "off" },
		autolearn: { enabled: false }, collab: { autoStart: "off" }, gc: { autoCompress: false }, skills: { enabled: false }, lsp: { enabled: false },
		modelRoles: { default: "fixture/windows-cases", smol: "fixture/windows-cases", tiny: "fixture/windows-cases" } };
}
export function caseProcessArgs(extension: string): string[] {
	return ["--mode", "rpc", "--no-session", "--no-extensions", "--no-context-files", "--no-rules", "--no-skills", "--no-lsp", "--no-title", "--no-tools", "--model", "fixture/windows-cases", "--thinking", "off", "-e", extension];
}
export interface WindowsCase { id: string; group: string; script: string; cwd: string; expected: string[]; status: number }
export function constructWindowsCases(root: string, system32: string): WindowsCase[] {
	const folder = win32.join(root, "dir one");
	const alias = driveAlias(folder), mounted = driveAlias(folder, true), native = nativePath(folder);
	const binA = nativePath(win32.join(root, "bin-a")), binB = nativePath(win32.join(root, "bin-b"));
	const system = nativePath(system32), q = shellQuote;
	const list: WindowsCase[] = [];
	const add = (id: string, group: string, script: string, expected: string[], cwd = folder) => list.push({ id, group, script, expected, cwd, status: 0 });
	add("leading-and-engine-control", "hoisted-separators", `cd ${q(alias)} && printf 'leading-and-ok\\n'; pwd`, ["leading-and-ok", "dir one"], root);
	add("leading-semicolon-engine-control", "hoisted-separators", `cd ${q(mounted)}; printf 'leading-semicolon-ok\\n'; pwd`, ["leading-semicolon-ok", "dir one"], root);
	add("nonleading-msys-cd", "engine-cd", `true && cd ${q(alias)} && printf 'PWD=%s\\nOLDPWD=%s\\n' "$PWD" "$OLDPWD"`, ["PWD=", "dir one", "OLDPWD="], root);
	add("flagged-mounted-cd", "engine-cd", `cd -P ${q(mounted)} && printf 'flagged-ok\\n'; pwd`, ["flagged-ok", "dir one"], root);
	add("native-pwd-oldpwd-control", "engine-cd", `cd ${q(native)} && printf 'PWD=%s\\nOLDPWD=%s\\n' "$PWD" "$OLDPWD"; cd - && pwd`, ["PWD=", "OLDPWD=", "dir one"], root);
	add("msys-tests-and-redirects", "msys-consumers", `d=${q(alias)}; [ -f "$d/a b.txt" ] && printf 'file-test-ok\\n'; read -r line < "$d/a b.txt"; printf '%s\\n' "$line" > "$d/out.txt"; read -r again < "$d/out.txt"; printf 'redirect=%s\\n' "$again"; . "$d/source me.sh"`, ["file-test-ok", "redirect=apple pie", "source-ok"]);
	add("msys-program-alias", "msys-consumers", `${q(driveAlias(win32.join(system32, "where.exe"), true))} ${q("/?")} > ${q(nativePath(win32.join(folder, "where help.txt")))}; status=$?; printf 'where-help-status=%s\\n' "$status"; exit "$status"`, ["where-help-status=0"]);
	// Verify the exact executable before allowing a /c grammar. PATH contains only the verified System32.
	const findGuard = `[ -f ${q(nativePath(win32.join(system32, "find.exe")))} ] || exit 91; PATH=${q(system)}; `;
	add("cmd-find-empty", "cmd-find-quoting", findGuard + `find /c /v "" "a b.txt"`, ["3"]);
	add("cmd-find-slash-operand", "cmd-find-quoting", findGuard + `printf 'apple pie\\r\\nbanana split\\r\\nGET /api/users\\r\\n' | find /i "/API"`, ["GET /api/users"]);
	add("gnu-find-bounded", "gnu-and-other-cmd-controls", `PATH=${q(system)}; find ${q(alias)} -maxdepth 1 -name '*.txt'`, ["a b.txt"]);
	add("cmd-sort", "gnu-and-other-cmd-controls", `PATH=${q(system)}; sort "a b.txt" /r`, ["apple pie", "banana split", "GET /api/users"]);
	add("gnu-sort", "gnu-and-other-cmd-controls", `PATH=${q(system)}; sort -r "a b.txt"`, ["apple pie", "banana split", "GET /api/users"]);
	// Help avoids collecting account names, SIDs or other identity output.
	add("cmd-whoami-help", "gnu-and-other-cmd-controls", `PATH=${q(system)}; whoami ${q("/?")} > "whoami help.txt"; status=$?; printf 'whoami-help-status=%s\\n' "$status"; exit "$status"`, ["whoami-help-status=0"]);
	add("same-shell-path-rebind", "same-shell-path-rebind", `PATH=${q(binA + ";" + system)}; vomp_case_tool; PATH=${q(binB + ";" + system)}; printf 'hash-after-set=%s\\n' "\${#BASH_CMDS[@]}"; vomp_case_tool`, ["helper-A", "hash-after-set=0", "helper-B"]);
	add("same-shell-path-append-unset", "same-shell-path-rebind", `PATH=${q(binA + ";" + system)}; vomp_case_tool; PATH+=${q(";" + binB)}; printf 'hash-after-append=%s\\n' "\${#BASH_CMDS[@]}"; vomp_case_tool; unset PATH; printf 'hash-after-unset=%s\\n' "\${#BASH_CMDS[@]}"; PATH=${q(binB + ";" + system)}; vomp_case_tool`, ["helper-A", "hash-after-append=0", "hash-after-unset=0", "helper-B"]);
	add("pathext-order-rebind", "pathext-rebind", `PATH=${q(binA + ";" + system)}; PATHEXT='.BAT;.CMD'; vomp_case_ext; PATHEXT='.CMD;.BAT'; printf 'hash-after-pathext=%s\\n' "\${#BASH_CMDS[@]}"; vomp_case_ext`, ["extension-BAT", "hash-after-pathext=0", "extension-CMD"]);
	return list;
}

interface Capture {
	result: unknown; output: string; outputTruncated?: boolean; failures?: string[]; trace: { script: string; history?: unknown[] };
	presentations: { view: string; cursor: number; presentation: unknown }[];
}
interface Reply { data?: unknown; error?: string; [key: string]: unknown }
interface CaseRecord { id: string; group: string; script: string; cwd: string; status?: unknown; failures: string[]; equality: unknown[]; [key: string]: unknown }
const message = (error: unknown) => error instanceof Error ? error.stack ?? error.message : String(error);
const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export async function runWindowsCases(args: CaseArgs): Promise<void> {
	if (process.platform !== "win32") throw new Error("This runner executes only on Windows.");
	// mkdir is deliberately exclusive. Evidence and scratch files are retained on success and failure.
	await mkdir(args.output);
	const root = join(args.output, "scratch fixture");
	const env = caseEnvironment(process.env, root);
	const systemRoot = env.SYSTEMROOT ?? env.WINDIR;
	const evidence: { [key: string]: unknown; cases: CaseRecord[]; failures: string[]; modelRequests: unknown[] } = {
		startedAt: new Date().toISOString(), args, limits: CASE_LIMITS, cases: [], failures: [], modelRequests: [],
		scope: "Engine-level native Shell.run controls. Direct capture bypasses TypeScript BashTool leading-cd hoisting. details.cwd, cdSeparator, tool/card C4 and actual UI behavior are unexercised.",
		processContract: "One capture omp process also restores and presents; the existing extension permits restore/present for the capture role. No additional presentation process is required.",
	};
	const save = () => writeFile(join(args.output, "results.json"), JSON.stringify(evidence, null, 2));
	let job: WindowsShellJob | undefined;
	let interval: NodeJS.Timeout | undefined;
	let sampling = false;
	let closed = false;
	let fatal: Error | undefined;
	let next: ServerResponse | undefined;
	const ready = Promise.withResolvers<Record<string, unknown>>();
	void ready.promise.catch(() => {});
	const pending = new Map<string, { resolve(value: Reply): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
	const token = randomUUID();
	const fail = (error: Error) => {
		if (closed || fatal) return;
		fatal = error; evidence.failures.push(message(error)); ready.reject(error);
		for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
		pending.clear();
		// The production primitive owns the entire private tree and confirms stop acknowledgement.
		if (job) void job.stop().catch(error => { evidence.failures.push(message(error)); });
	};
	const server = createServer(async (req, res) => {
		try {
			if (req.url?.startsWith("/provider/")) {
				evidence.modelRequests.push({ method: req.method, path: req.url, at: new Date().toISOString() });
				res.writeHead(503).end("Fixture forbids model calls"); return;
			}
			if (!req.url?.startsWith(`/${token}/`)) { res.writeHead(404).end(); return; }
			const path = req.url.slice(token.length + 1);
			if (path === "/next" && req.method === "GET") {
				if (closed || fatal) { res.writeHead(410).end(); return; }
				if (next) { res.writeHead(409).end(); return; }
				next = res; res.once("close", () => { if (next === res) next = undefined; }); return;
			}
			const chunks: Buffer[] = []; let bytes = 0;
			for await (const chunk of req) {
				const buffer = Buffer.from(chunk); bytes += buffer.length;
				if (bytes > CASE_LIMITS.bridgeBytes) { res.writeHead(413).end(); fail(new Error("Bridge response byte limit")); return; }
				chunks.push(buffer);
			}
			const value = JSON.parse(Buffer.concat(chunks).toString()) as Reply;
			if (path === "/ready") ready.resolve(value);
			else if (path === "/failure") fail(new Error(String(value.error)));
			else if (path === "/result" && typeof value.id === "string") {
				const item = pending.get(value.id);
				if (item) { clearTimeout(item.timer); pending.delete(value.id); item.resolve(value); }
			}
			res.end("{}");
		} catch (error) { res.writeHead(400).end(); fail(new Error(message(error))); }
	});
	const request = async (value: Record<string, unknown>, timeoutMs: number = CASE_LIMITS.requestMs): Promise<Reply> => {
		if (fatal) throw fatal;
		const id = randomUUID();
		const result = Promise.withResolvers<Reply>();
		const timer = setTimeout(() => fail(new Error(`Deadline for ${String(value.op)}`)), timeoutMs);
		pending.set(id, { ...result, timer });
		void result.promise.catch(() => {});
		// Requests are sequential. Wait for the extension's next long poll without starting another process.
		const deadline = Date.now() + timeoutMs;
		while (!next && !fatal && Date.now() < deadline) await sleep(5);
		if (next && !fatal) { const response = next; next = undefined; response.end(JSON.stringify({ ...value, id })); }
		return result.promise;
	};
	try {
		assert(systemRoot && /^[a-z]:[\\/]/i.test(systemRoot), "A drive-qualified SystemRoot is required.");
		const system32 = win32.join(systemRoot, "System32");
		const verified: Record<string, string> = {};
		for (const name of ["find.exe", "sort.exe", "where.exe", "whoami.exe"]) {
			const path = win32.join(system32, name);
			assert((await stat(path)).isFile(), `Required System32 executable missing: ${name}`); verified[name] = path;
		}
		evidence.system32 = { directory: system32, verified, cmdCasePath: nativePath(system32), findGuard: "Exact file preflight plus in-shell file check and System32-only PATH before each cmd FIND." };
		assert((await stat(args.omp)).isFile(), "The omp executable is missing.");
		evidence.ompSha256 = createHash("sha256").update(await readFile(args.omp)).digest("hex");
		for (const path of [...Object.values(env).filter((value): value is string => typeof value === "string" && value.startsWith(root)), root, join(root, "work"), join(root, "dir one"), join(root, "bin-a"), join(root, "bin-b")]) await mkdir(path, { recursive: true });
		await writeFile(join(root, "dir one", "a b.txt"), "apple pie\r\nbanana split\r\nGET /api/users\r\n");
		await writeFile(join(root, "dir one", "source me.sh"), "printf 'source-ok\\n'\n");
		for (const [bin, label] of [["bin-a", "A"], ["bin-b", "B"]]) await writeFile(join(root, bin!, "vomp_case_tool.cmd"), `@echo off\r\necho helper-${label}\r\n`);
		for (const extension of ["bat", "cmd"]) await writeFile(join(root, "bin-a", `vomp_case_ext.${extension}`), `@echo off\r\necho extension-${extension.toUpperCase()}\r\n`);
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject); server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address(); assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		await writeFile(join(root, "agent", "config.yml"), JSON.stringify(caseConfig()));
		await writeFile(join(root, "agent", "models.yml"), JSON.stringify({ providers: { fixture: { baseUrl: base + "/provider/v1", apiKey: "local-fixture-only", api: "openai-completions", models: [{ id: "windows-cases", name: "Windows engine fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }] } } }));
		const extension = join(root, "evidence.mjs"), script = join(root, "monitor.ps1"), config = join(root, "monitor.json");
		await writeFile(extension, evidenceExtensionSource);
		await writeFile(script, SHELL_WINDOWS_MONITOR);
		await writeFile(config, JSON.stringify({ executable: args.omp, args: caseProcessArgs(extension), cwd: join(root, "work") }));
		env.VOMP_SHELL_EVIDENCE_BRIDGE = `${base}/${token}`; env.VOMP_SHELL_EVIDENCE_ROLE = "capture";
		evidence.isolation = { environmentKeys: Object.keys(env), config: caseConfig(), modelEndpoint: base + "/provider/v1", promptRequestsSent: 0 };
		const startupTimer = setTimeout(() => fail(new Error("Capture startup deadline")), CASE_LIMITS.startupMs);
		try {
			job = createWindowsShellJob({ powerShell: win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"), script, config, cwd: join(root, "work"), env, onLoss: reason => fail(new Error(`Owned job lost: ${reason}`)) });
			await job.started;
			let peakJobRssBytes = 0, peakMonitorRssBytes = 0, samples = 0;
			interval = setInterval(() => {
				if (sampling || closed || fatal || !job) return;
				sampling = true;
				void job.sample().then(sample => {
					peakJobRssBytes = Math.max(peakJobRssBytes, sample.jobRssBytes); peakMonitorRssBytes = Math.max(peakMonitorRssBytes, sample.monitorRssBytes); samples++;
					evidence.memory = { peakJobRssBytes, peakMonitorRssBytes, samples, sampleResponseMs: 1000 };
					if (sample.jobRssBytes > CASE_LIMITS.jobRssBytes || sample.monitorRssBytes > CASE_LIMITS.monitorRssBytes) fail(new Error("Owned job RSS limit"));
				}).catch(error => { if (!closed && !fatal) fail(new Error(message(error))); }).finally(() => { sampling = false; });
			}, CASE_LIMITS.sampleMs);
			const capability = await ready.promise;
			evidence.capability = capability;
			assert.equal(capability.role, "capture"); assert.equal(capability.live, true); assert.equal(capability.restore, true);
		} finally { clearTimeout(startupTimer); }
		for (const test of constructWindowsCases(root, system32)) {
			const record: CaseRecord = { ...test, scope: "engine-level", failures: [], equality: [] }; evidence.cases.push(record);
			try {
				const reply = await request({ op: "capture", script: test.script, cwd: test.cwd, timeoutMs: CASE_LIMITS.captureMs, outputBytes: CASE_LIMITS.outputBytes }, CASE_LIMITS.captureMs + CASE_LIMITS.requestMs);
				await writeFile(join(args.output, `${test.id}.capture.json`), JSON.stringify(reply));
				assert(!reply.error, reply.error);
				const captured = reply.data as Capture;
				assert(captured && typeof captured.output === "string" && captured.trace && Array.isArray(captured.presentations), "Malformed capture result");
				record.result = captured.result; record.output = captured.output;
				record.outputTruncated = captured.outputTruncated ?? false;
				if (captured.outputTruncated) record.failures.push("Capture retained only a bounded output prefix.");
				record.failures.push(...(captured.failures ?? []));
				assert(Buffer.byteLength(captured.output) <= CASE_LIMITS.outputBytes, "Output byte limit");
				assert(byteLength(captured.trace) <= CASE_LIMITS.traceBytes, "Trace byte limit");
				assert.equal(captured.trace.script, test.script, "Original engine script changed");
				const result = captured.result as { exitCode?: unknown } | null;
				record.status = result?.exitCode;
				if (record.status !== test.status) record.failures.push(`Expected exitCode ${test.status}, received ${JSON.stringify(record.status)}`);
				for (const expected of test.expected) if (!captured.output.includes(expected)) record.failures.push(`Missing output: ${expected}`);
				assert.equal(captured.presentations.length, 6, "Expected six live Raw/Pseudo presentations");
				const restored = await request({ op: "restore", handle: "case", trace: captured.trace }); assert(!restored.error, restored.error);
				try {
					const expectedPoints = [0, Math.floor((captured.trace.history?.length ?? 0) / 2), captured.trace.history?.length ?? 0];
					assert.deepEqual(captured.presentations.map(point => [point.view, point.cursor]), ["raw", "pseudo"].flatMap(view => expectedPoints.map(cursor => [view, cursor])));
					for (const [index, point] of captured.presentations.entries()) {
						const equal = { view: point.view, cursor: point.cursor, equal: false, failure: "" };
						record.equality.push(equal);
						try {
							assert(byteLength(point.presentation) <= CASE_LIMITS.presentationBytes, "Live presentation byte limit");
							const presented = await request({ op: "present", handle: "case", options: { view: point.view, cursor: point.cursor } });
							await writeFile(join(args.output, `${test.id}.restored-${index}.json`), JSON.stringify(presented));
							assert(!presented.error, presented.error); assert(byteLength(presented.data) <= CASE_LIMITS.presentationBytes, "Restored presentation byte limit");
							assert.deepEqual(presented.data, point.presentation); equal.equal = true;
						} catch (error) { equal.failure = message(error); record.failures.push(`Checkpoint ${index}: ${message(error)}`); }
					}
				} finally { if (!fatal) { const released = await request({ op: "release", handle: "case" }); assert(!released.error, released.error); } }
			} catch (error) { record.failures.push(message(error)); }
			await save();
			if (fatal) break;
		}
		if (evidence.modelRequests.length) evidence.failures.push("The local fixture received model requests.");
		evidence.modelCallObservation = { localEndpointRequests: evidence.modelRequests.length, configIsolated: true, promptsSent: 0, limit: "Counts cover the configured local fixture endpoint; no global network counter is installed." };
	} catch (error) { evidence.failures.push(message(error)); }
	finally {
		closed = true;
		clearInterval(interval);
		for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Fixture closing")); } pending.clear();
		if (next) next.writeHead(410).end();
		const stoppedAt = performance.now();
		if (job) {
			try { await job.stop(); evidence.cleanup = { confirmed: true, elapsedMs: performance.now() - stoppedAt }; }
			catch (error) { evidence.cleanup = { confirmed: false, elapsedMs: performance.now() - stoppedAt }; evidence.failures.push(message(error)); }
		}
		server.closeAllConnections();
		const serverClosed = Promise.withResolvers<void>();
		server.close(() => serverClosed.resolve()); await serverClosed.promise;
		evidence.finishedAt = new Date().toISOString();
		evidence.passed = evidence.failures.length === 0 && evidence.cases.length === 16 && evidence.cases.every(record => record.failures.length === 0);
		await save();
		if (!evidence.passed) process.exitCode = 1;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	void runWindowsCases(parseCaseArgs(process.argv.slice(2))).catch(error => { console.error(message(error)); process.exitCode = 1; });
}
