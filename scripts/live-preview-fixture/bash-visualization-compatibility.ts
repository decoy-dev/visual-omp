import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseCfgLeaf } from "../../src/main/services/omp-config";
import { ShellVisualizationService } from "../../src/main/omp/shell-visualization";
import { createInstalledShellWorker, SHELL_WORKER_LIMITS, ShellWorkerFailure, shellWorkerEnvironment, type ShellPresentationWorker } from "../../src/main/omp/shell-visualization-worker";
import { shellProps, type ShellVizPreferences } from "../../src/shared/tsp/shell";
import type { ShellFailureReason, ShellResult } from "../../src/shared/shell-visualization";

// Run from the checkout with bun --tsconfig-override=tsconfig.node.json scripts/live-preview-fixture/bash-visualization-compatibility.ts.
// The binary overrides must be absolute paths. All omp invocations receive fresh fixture roots and an explicit environment.
const execute = promisify(execFile);
const destination = resolve(process.env.OMP_SHELL_COMPAT_EVIDENCE ?? "/tmp/vomp-bash-visualization-compatibility");
const tracePath = resolve(process.env.OMP_SHELL_TRACE ?? "/tmp/vomp-bash-visualization-slice1/trace.json");
const binaries = [
  { version: "18.15", binary: process.env.OMP_BIN_18_15 ?? "/tmp/omp-bin-18.15/omp-darwin-arm64" },
  { version: "18.16", binary: process.env.OMP_BIN_18_16 ?? "/tmp/omp-bin-18.16/omp-darwin-arm64" },
];
const preferences: ShellVizPreferences = { view: "pseudo", layers: { color: true, inline: true, idioms: true, effects: true, unwrap: true }, split: false, playing: false, speed: 1, expandedNodes: [] };
const traceJson = await readFile(tracePath, "utf8");
const trace = JSON.parse(traceJson);
assert.equal(trace.v, 1);
const results: Record<string, unknown>[] = [];
let modelRequests = 0;
let ambientLoads = 0;
const provider = createServer((request, response) => {
  if (request.url === "/ambient") ambientLoads++; else modelRequests++;
  response.writeHead(503).end("Fixture accepts no model turns");
});
const listening = Promise.withResolvers<void>();
provider.once("error", listening.reject);
provider.listen(0, "127.0.0.1", listening.resolve);
await listening.promise;
const address = provider.address();
assert.ok(address && typeof address !== "string");
const providerUrl = `http://127.0.0.1:${address.port}`;
await mkdir(destination, { recursive: true });

async function sha256(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function fingerprint(file: string) {
  const info = await stat(file);
  return { sha256: await sha256(file), bytes: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino, mode: info.mode };
}
async function files(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await files(root, name)); else result.push(name);
  }
  return result.sort();
}
async function processes(env: NodeJS.ProcessEnv) {
  const { stdout } = await execute("/bin/ps", ["-axo", "pid=,ppid=,pgid=,state=,command="], { env, timeout: 2000, maxBuffer: 4 * 1024 ** 2 });
  return [...stdout.matchAll(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/gm)].map(row => ({ pid: Number(row[1]), parent: Number(row[2]), group: Number(row[3]), state: row[4]!, command: row[5]! }));
}
function unavailable(error: unknown) {
  assert.ok(error instanceof ShellWorkerFailure, String(error));
  assert.equal(error.reason, "unavailable", `Unexpected failure: ${error.reason}`);
  return { status: "unavailable", reason: error.reason };
}

try {
  assert.equal(process.platform, "darwin", "The supplied binaries require macOS");
  assert.equal(process.arch, "arm64", "The supplied binaries require arm64");
  for (const target of binaries) {
    assert.ok(isAbsolute(target.binary), "Binary paths must be absolute");
    const root = await mkdtemp(join(destination, `${target.version}-`));
    const env = shellWorkerEnvironment({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" }, root);
    await Promise.all(["home", "agent", "work", "tmp"].map(name => mkdir(join(root, name), { recursive: true })));
    await mkdir(join(root, "agent", "extensions"));
    await writeFile(join(root, "agent", "extensions", "ambient.mjs"), `export default async function () { await fetch(${JSON.stringify(providerUrl + "/ambient")}); }`);
    await writeFile(join(root, "agent", "config.yml"), JSON.stringify({ startup: { setupWizard: false, checkUpdate: false }, modelRoles: { default: "fixture/preview" }, mcp: { enableProjectConfig: false }, disabledProviders: ["ollama", "llama.cpp", "lm-studio"] }));
    await writeFile(join(root, "agent", "models.yml"), JSON.stringify({ providers: { fixture: { baseUrl: providerUrl + "/v1", apiKey: "local-fixture-only", api: "openai-completions", models: [{ id: "preview", name: "Local fixture", contextWindow: 128000, maxTokens: 1024 }] } } }));
    const sourcePath = join(root, "external-session.jsonl");
    const leasePath = join(root, "external-session.lease");
    const ordinary = Object.freeze({ command: trace.script, content: Object.freeze([Object.freeze({ type: "text", text: "Caller-owned complete ordinary output.\n" }), Object.freeze({ type: "image", data: "fixture-image", mimeType: "image/png" })]), exitCode: 0, artifact: "artifact://fixture-output" });
    const ordinaryBefore = JSON.stringify(ordinary);
    await writeFile(sourcePath, JSON.stringify({ type: "session", id: `compat-${target.version}`, cwd: join(root, "work") }) + "\n" + JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "exact-compat-call", toolName: "bash", content: ordinary.content, details: { trace } } }) + "\n", { mode: 0o400 });
    await writeFile(leasePath, JSON.stringify({ pid: process.pid, sessionId: `compat-${target.version}`, fixture: true }), { mode: 0o400 });
    const before = { source: await fingerprint(sourcePath), lease: await fingerprint(leasePath) };
    const beforeFiles = await files(root);
    const requestBaseline = modelRequests;
    const ambientBaseline = ambientLoads;
    const evidence: Record<string, unknown> = { requestedVersion: target.version, binary: target.binary, root, sourcePath, leasePath, before, cases: [], productionFactory: "createInstalledShellWorker", workerLimits: SHELL_WORKER_LIMITS };
    results.push(evidence);
    let worker: ShellPresentationWorker | undefined;
    let service: ShellVisualizationService | undefined;
    let workerGroup: number | undefined;
    let nativeAvailable = false;
    const losses: ShellFailureReason[] = [];
    const cases = evidence.cases as Record<string, unknown>[];
    try {
      const manifestPath = join(dirname(target.binary), "SHA256SUMS.txt");
      const manifest = await readFile(manifestPath, "utf8");
      const expectedHash = manifest.split("\n").map(line => line.trim().split(/\s+/)).find(fields => fields[1] === basename(target.binary))?.[0];
      assert.ok(expectedHash, "Binary checksum is absent from its manifest");
      const actualHash = await sha256(target.binary);
      assert.equal(actualHash, expectedHash);
      evidence.checksum = { manifestPath, expected: expectedHash, actual: actualHash, matched: true };
      evidence.version = (await execute(target.binary, ["--version"], { cwd: join(root, "work"), env, timeout: 5000 })).stdout.trim();
      assert.match(String(evidence.version), new RegExp(`\\b${target.version.replace(".", "\\.")}\\.`));
      let effectiveSetting: { key: string; type: string; value: unknown } = { key: "display.shellVisualization", type: "unknown", value: undefined };
      try {
        const result = await execute(target.binary, ["read", "cfg://display.shellVisualization"], { cwd: join(root, "work"), env, timeout: 5000, maxBuffer: 64 * 1024 });
        evidence.settingQuery = { command: [target.binary, "read", "cfg://display.shellVisualization"], code: 0, stdout: result.stdout, stderr: result.stderr };
        const leaf = parseCfgLeaf(result.stdout);
        effectiveSetting = { key: leaf.key, type: leaf.type, value: leaf.value };
        evidence.effectiveSetting = leaf;
      } catch (error) {
        const failure = error as Error & { code?: unknown; stdout?: string; stderr?: string };
        evidence.settingQuery = { command: [target.binary, "read", "cfg://display.shellVisualization"], code: failure.code ?? null, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", error: String(error) };
        evidence.effectiveSetting = { key: "display.shellVisualization", known: false };
      }
      const startupAt = performance.now();
      try {
        worker = await createInstalledShellWorker({ executable: target.binary, env: { ...env, OPENAI_API_KEY: "local-fixture-only", OPENAI_BASE_URL: providerUrl + "/v1", NODE_OPTIONS: "--require /fixture-must-not-load", BUN_OPTIONS: "--preload /fixture-must-not-load" }, signal: new AbortController().signal, onLoss: reason => losses.push(reason) });
        nativeAvailable = true;
        const startupMs = performance.now() - startupAt;
        assert.ok(startupMs <= SHELL_WORKER_LIMITS.startupMs + 1000);
        evidence.nativeCapability = { available: true, constructor: "ShellVisualization", method: "present", startupMs };
        const children = (await processes(env)).filter(child => child.parent === process.pid && child.command.includes("vomp-shell-presentation-") && child.command.includes("presentation.mjs"));
        assert.equal(children.length, 1);
        const child = children[0]!;
        workerGroup = child.group;
        const extension = /(?:-e|--extension)\s+(\S+\/presentation\.mjs)/.exec(child.command)?.[1];
        assert.ok(extension, child.command);
        const workerRoot = dirname(extension);
        assert.notEqual(workerRoot, root);
        assert.ok(child.command.includes("--no-session"));
        const initialWorkerFiles = await files(workerRoot);
        assert.ok(!initialWorkerFiles.some(file => /(?:session|lease|auth|credential|models\.yml|ambient)/i.test(file)), initialWorkerFiles.join(", "));
        evidence.worker = { pid: child.pid, group: child.group, root: workerRoot, command: child.command, initialFiles: initialWorkerFiles };
        await worker.request({ op: "restore", handle: "canonical", json: traceJson });
        const presentations: Record<string, unknown>[] = [];
        for (const view of ["pseudo", "raw"] as const) {
          const at = performance.now();
          const presentation = await worker.request({ op: "present", handle: "canonical", options: { ...preferences, view } });
          const props = shellProps({ presentation });
          assert.ok(props, "Production presentation guard rejected the older native response");
          assert.equal(props.presentation.preferences.view, view);
          assert.ok(props.presentation.rows.length > 0);
          presentations.push({ view, elapsedMs: performance.now() - at, presentation });
        }
        await writeFile(join(root, "presentations.json"), JSON.stringify(presentations, null, 2));
        cases.push({ name: "canonical-native-restore", status: "ready", views: presentations.map(item => item.view), presentationsPath: join(root, "presentations.json") });
        const unsupportedAt = performance.now();
        let unsupported: unknown;
        try { await worker.request({ op: "restore", handle: "unsupported", json: JSON.stringify({ ...trace, v: 999 }) }); }
        catch (error) { unsupported = unavailable(error); }
        assert.ok(unsupported, "Unsupported trace was accepted");
        const elapsedMs = performance.now() - unsupportedAt;
        assert.ok(elapsedMs <= SHELL_WORKER_LIMITS.requestMs + 250);
        cases.push({ name: "unsupported-trace-version", result: unsupported, elapsedMs, bounded: true, mechanism: "Production extension envelope guard" });
        const finalWorkerFiles = await files(workerRoot);
        assert.deepEqual(finalWorkerFiles, initialWorkerFiles);
        Object.assign(evidence.worker as object, { finalFiles: finalWorkerFiles, noSessionOrLeaseFiles: true });
      } catch (error) {
        if (worker) throw error;
        const elapsedMs = performance.now() - startupAt;
        const result = unavailable(error);
        assert.ok(elapsedMs <= SHELL_WORKER_LIMITS.startupMs + 1000);
        evidence.nativeCapability = { available: false, result, elapsedMs, bounded: true, detail: "Production capability handshake refused native import/constructor/present support; the factory does not expose a narrower reason." };
        cases.push({ name: "native-capability-unavailable", result, elapsedMs, bounded: true });
      } finally {
        await worker?.close();
        worker = undefined;
      }
      if (workerGroup !== undefined) assert.ok(!(await processes(env)).some(child => child.group === workerGroup && !child.state.startsWith("Z")), "Private worker survived close");
      const serviceCases = [
        { name: "actual-effective-setting", setting: effectiveSetting },
        { name: "missing-setting-policy", setting: { key: "display.shellVisualization", type: "boolean", value: undefined } },
        { name: "disabled-setting-policy", setting: { key: "display.shellVisualization", type: "boolean", value: false } },
      ];
      for (const entry of serviceCases) {
        let factoryCalls = 0;
        service = new ShellVisualizationService({
          async loadTrace(file, call) {
            assert.equal(file, sourcePath); assert.equal(call, "exact-compat-call");
            return { status: "ready", json: traceJson, cwd: join(root, "work"), sessionId: `compat-${target.version}`, identity: before.source.sha256 };
          },
          async getSetting() { return entry.setting; },
          async createWorker(onLoss, signal) { factoryCalls++; return createInstalledShellWorker({ executable: target.binary, env, onLoss, signal }); },
        });
        const at = performance.now();
        const result: ShellResult = await service.open({ requestId: entry.name, file: sourcePath, toolCallId: "exact-compat-call" });
        const elapsedMs = performance.now() - at;
        if (entry.setting.value !== true || entry.setting.type !== "boolean") {
          assert.deepEqual(result, { status: "unavailable", reason: entry.setting.value === false ? "disabled" : "unavailable" });
          assert.equal(factoryCalls, 0);
        } else if (nativeAvailable) assert.equal(result.status, "ready", JSON.stringify(result));
        else assert.deepEqual(result, { status: "unavailable", reason: "unavailable" });
        assert.ok(elapsedMs <= SHELL_WORKER_LIMITS.startupMs + 2 * SHELL_WORKER_LIMITS.requestMs + 1000);
        cases.push({ name: entry.name, input: { ...entry.setting, value: entry.setting.value ?? null }, actualEngineSetting: entry.name === "actual-effective-setting", result: result.status === "ready" ? { status: "ready", view: result.props.presentation.preferences.view } : result, factoryCalls, elapsedMs, ordinaryContentUnchanged: JSON.stringify(ordinary) === ordinaryBefore });
        await service.close();
        service = undefined;
      }
      assert.equal(JSON.stringify(ordinary), ordinaryBefore);
      const persisted = JSON.parse((await readFile(sourcePath, "utf8")).trim().split("\n").at(-1)!);
      assert.deepEqual(persisted.message.content, ordinary.content);
      const after = { source: await fingerprint(sourcePath), lease: await fingerprint(leasePath) };
      assert.deepEqual(after, before);
      const afterFiles = (await files(root)).filter(file => file !== "presentations.json");
      const sessionOrLease = /(?:session|lease)|\.jsonl$/i;
      assert.deepEqual(afterFiles.filter(file => sessionOrLease.test(file)), beforeFiles.filter(file => sessionOrLease.test(file)));
      evidence.privateBootstrapWrites = afterFiles.filter(file => !beforeFiles.includes(file));
      assert.equal(modelRequests - requestBaseline, 0);
      assert.equal(ambientLoads - ambientBaseline, 0);
      Object.assign(evidence, { passed: true, after, sourceAndLeaseUnchanged: true, callerOrdinaryContent: ordinary, ordinaryContentUnchanged: true, noAdditionalSessionOrLeaseFiles: true, fixtureFiles: afterFiles, modelRequests: modelRequests - requestBaseline, ambientLoads: ambientLoads - ambientBaseline, losses,
        fallbackPolicy: "Missing, unknown or failed settings keep ordinary content and do not start a worker, even when the independent native capability probe succeeds. Explicit false is disabled. A known enabled setting permits canonical restoration only when native capability succeeds.",
        evidenceBoundary: "The source and lease are caller-owned synthetic files. Service loadTrace supplies this exact fixture trace at its injected reader seam. No renderer or production saved-file loader is exercised. The caller's ordinary result is never passed to the presentation API. No missing export is simulated." });
    } catch (error) { Object.assign(evidence, { passed: false, error: String(error), modelRequests: modelRequests - requestBaseline, ambientLoads: ambientLoads - ambientBaseline, losses }); throw error; }
    finally {
      await service?.close();
      await worker?.close();
      await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
    }
  }
} finally {
  provider.closeAllConnections();
  const closed = Promise.withResolvers<void>();
  provider.close(() => closed.resolve());
  await closed.promise;
  await writeFile(join(destination, "evidence.json"), JSON.stringify({ passed: results.length === binaries.length && results.every(result => result.passed === true), tracePath, results, modelRequests, ambientLoads, platform: process.platform, arch: process.arch, packageInstalls: 0, ownerProfileAccess: "No owner profile paths are passed to omp; every child invocation uses fixture HOME, PI_CODING_AGENT_DIR, neutral cwd and an explicit OS-path environment.", minimumVersionChanged: false }, null, 2));
}
console.log(JSON.stringify({ passed: true, evidence: join(destination, "evidence.json"), versions: results.map(result => ({ version: result.version, nativeCapability: result.nativeCapability, effectiveSetting: result.effectiveSetting })) }));
