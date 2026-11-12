import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { SHELL_SERVICE_LIMITS, ShellVisualizationService } from "../../src/main/omp/shell-visualization";
import { createInstalledShellWorker, SHELL_WORKER_LIMITS, shellWorkerEnvironment, type ShellWorkerRequest } from "../../src/main/omp/shell-visualization-worker";
import type { ShellFrame, ShellInvalidation, ShellResult } from "../../src/shared/shell-visualization";

// Run with bun --tsconfig-override=tsconfig.node.json scripts/live-preview-fixture/bash-visualization-service-evidence.ts.
// Requires an absolute OMP_BIN and an isolated trace captured by the existing Slice 1 probe.
// Fault injection stops/kills only the private production presentation process group.
const execute = promisify(execFile);
const binary = process.env.OMP_BIN;
assert.ok(binary && isAbsolute(binary), "OMP_BIN must name the installed executable by absolute path");
const tracePath = resolve(process.env.OMP_SHELL_TRACE ?? "/tmp/vomp-bash-visualization-slice1/trace.json");
const referencesPath = resolve(process.env.OMP_SHELL_REFERENCES ?? join(tracePath, "..", "live-presentations.json"));
const destination = resolve(process.env.OMP_SHELL_SERVICE_EVIDENCE ?? "/tmp/vomp-bash-visualization-service");
const root = await mkdtemp(join(tmpdir(), "vomp-shell-service-evidence-"));
const sourcePath = join(root, "external-session.jsonl");
const leasePath = join(root, "external-session.lease");
const ordinaryOutput = "Original output remains owned by the tool result.\n";
const json = await readFile(tracePath, "utf8");
const references = JSON.parse(await readFile(referencesPath, "utf8")) as { view: string; cursor: number; presentation: unknown }[];
const frames: ShellFrame[] = [];
const invalidations: ShellInvalidation[] = [];
const cases: Record<string, unknown>[] = [];
const workers: { pid: number; group: number; root: string; requests: number; requestOps: { op: ShellWorkerRequest["op"]; handle: string; nativeCompleted: boolean }[]; files: string[] }[] = [];
const services = new Set<ShellVisualizationService>();
let modelRequests = 0;
let ambientLoads = 0;
let fault: "cancel" | "timeout" | "crash" | undefined;
let faultStarted: PromiseWithResolvers<void> | undefined;
let presentationDelayMs = 0;
let heartbeatAt = performance.now();
let heartbeatDelayMs = 0;
const heartbeat = setInterval(() => { const now = performance.now(); heartbeatDelayMs = Math.max(heartbeatDelayMs, now - heartbeatAt - 20); heartbeatAt = now; }, 20);
const provider = createServer((request, response) => { if (request.url === "/ambient") ambientLoads++; else modelRequests++; response.writeHead(503).end(); });
const listening = Promise.withResolvers<void>();
provider.listen(0, "127.0.0.1", listening.resolve);
await listening.promise;
const address = provider.address();
assert.ok(address && typeof address !== "string");
const providerUrl = `http://127.0.0.1:${address.port}`;
const safeEnv = shellWorkerEnvironment({ PATH: process.env.PATH, LANG: "en_US.UTF-8", SystemRoot: process.env.SystemRoot }, root);
await Promise.all(["home", "agent", "work", "tmp"].map(name => mkdir(join(root, name), { recursive: true })));
// Deliberate ambient extension and provider traps. Production must replace these roots and discard hooks/keys.
await mkdir(join(safeEnv.PI_CODING_AGENT_DIR!, "extensions"), { recursive: true });
await writeFile(join(safeEnv.PI_CODING_AGENT_DIR!, "extensions", "ambient.mjs"), `export default async function () { await fetch(${JSON.stringify(providerUrl + "/ambient")}); }`);
await writeFile(join(safeEnv.PI_CODING_AGENT_DIR!, "models.yml"), JSON.stringify({ providers: { fixture: { baseUrl: providerUrl + "/v1", apiKey: "local-fixture-only", api: "openai-completions", models: [{ id: "preview", name: "Local fixture", contextWindow: 128000, maxTokens: 1024 }] } } }));
await writeFile(sourcePath, JSON.stringify({ type: "session", id: "externally-owned-fixture", cwd: join(root, "work") }) + "\n" + JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "external-call", content: [{ type: "text", text: ordinaryOutput }], details: { trace: JSON.parse(json) } } }) + "\n", { mode: 0o400 });
await writeFile(leasePath, JSON.stringify({ pid: process.pid, sessionId: "externally-owned-fixture", fixture: true }), { mode: 0o400 });
async function fingerprint(path: string) { const info = await stat(path); return { sha256: createHash("sha256").update(await readFile(path)).digest("hex"), size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, mode: info.mode }; }
const before = { source: await fingerprint(sourcePath), lease: await fingerprint(leasePath) };
async function processes() {
  const { stdout } = await execute("/bin/ps", ["-axo", "pid=,ppid=,pgid=,state=,command="], { env: safeEnv, maxBuffer: 4 * 1024 ** 2 });
  return [...stdout.matchAll(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/gm)].map(row => ({ pid: Number(row[1]), parent: Number(row[2]), group: Number(row[3]), state: row[4]!, command: row[5]! }));
}
async function stopped(worker: typeof workers[number]) {
  const at = performance.now();
  while ((await processes()).some(row => row.group === worker.group && !row.state.startsWith("Z"))) { assert.ok(performance.now() - at < 3000, "Private worker failed to terminate"); await sleep(5); }
  return performance.now() - at;
}
function ready(result: ShellResult) { assert.equal(result.status, "ready", JSON.stringify(result)); if (result.status !== "ready") throw new Error("Presentation unavailable"); return result; }
function service(clock?: () => number) {
  const result = new ShellVisualizationService({
    now: clock,
    async loadTrace(file, toolCallId) {
      assert.equal(file, sourcePath); assert.equal(toolCallId, "external-call");
      // The exact source reader is injected at this no-host seam. It supplies data, never authority to the owner.
      const entry = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line)).at(-1);
      return { status: "ready", json: JSON.stringify(entry.message.details.trace), cwd: join(root, "work"), sessionId: "externally-owned-fixture", identity: before.source.sha256 };
    },
    async getSetting() { return { key: "display.shellVisualization", type: "boolean", value: true }; },
    async createWorker(onLoss, signal) {
      const worker = await createInstalledShellWorker({ executable: binary!, env: { ...safeEnv, OPENAI_API_KEY: "local-fixture-only", OPENAI_BASE_URL: providerUrl + "/v1", NODE_OPTIONS: "--require /ambient-owner-hook", BUN_OPTIONS: "--preload /ambient-owner-hook" }, onLoss, signal });
      try {
      const candidates = (await processes()).filter(row => row.parent === process.pid && row.command.includes("vomp-shell-presentation-") && row.command.includes("presentation.mjs"));
      assert.equal(candidates.length, 1, "Expected one direct private omp launcher");
      const child = candidates[0]!;
      const extension = /(?:-e|--extension)\s+(\S+\/presentation\.mjs)/.exec(child.command)?.[1];
      assert.ok(extension, child.command);
      const workerRoot = resolve(extension, "..");
      const files = await readdir(join(workerRoot, "agent"));
      assert.ok(files.every(file => /^(?:config\.yml|(?:agent|models)\.db(?:-(?:wal|shm))?)$/.test(file)), `Unexpected private agent files: ${files.join(", ")}`);
      const info: typeof workers[number] = { pid: child.pid, group: child.group, root: workerRoot, requests: 0, requestOps: [], files };
      workers.push(info);
      return { close: () => worker.close(), async request(request: ShellWorkerRequest) {
        info.requests++;
        const operation = { op: request.op, handle: request.handle, nativeCompleted: false };
        info.requestOps.push(operation);
        if (fault && request.op === "present") {
          const mode = fault; fault = undefined;
          process.kill(-info.group, mode === "crash" ? "SIGKILL" : "SIGSTOP");
          faultStarted?.resolve();
        }
        const result = await worker.request(request);
        operation.nativeCompleted = true;
        // Parent-injected response delay begins only after the real native presentation has completed.
        if (request.op === "present" && presentationDelayMs) await sleep(presentationDelayMs);
        return result;
      } };
      } catch (error) {
        cases.push({ name: "bootstrap-observation-failed", error: String(error) });
        await worker.close();
        throw error;
      }
    },
    onFrame: frame => frames.push(frame), onInvalidated: event => invalidations.push(event),
  });
  services.add(result);
  return result;
}
let sentinel: ChildProcess | undefined;
let sentinelExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
let sentinelOutput = "";
let sentinelEnded = false;
const evidence: Record<string, unknown> = { platform: process.platform, binary, tracePath, referencesPath, thresholds: { ...SHELL_WORKER_LIMITS, terminationMs: 250, heartbeatDelayMs: 100 }, cases, workers };
try {
  assert.ok(process.platform === "darwin" || process.platform === "linux", "Signal fault-injection evidence requires POSIX; Windows behavior requires a native Windows run");
  evidence.version = (await execute(binary!, ["--version"], { env: safeEnv, cwd: join(root, "work") })).stdout.trim();
  const local = service();
  const initial = ready(await local.open({ requestId: "external", file: sourcePath, toolCallId: "external-call" }));
  const presentations: unknown[] = [];
  for (const point of references) {
    ready(await local.action(initial.handle, `view:${point.view}`));
    const current = ready(await local.action(initial.handle, `seek:${point.cursor}`));
    assert.deepEqual(current.props.presentation, point.presentation);
    presentations.push({ view: point.view, cursor: point.cursor, presentation: current.props.presentation });
  }
  const latest = ready(await local.action(initial.handle, "live"));
  assert.equal(latest.props.presentation.preferences.cursor, undefined);
  assert.equal(latest.props.liveOrigin, false);
  cases.push({ name: "production-service-canonical-restore", exactReferencePresentations: references.length, rawPseudoReplay: true, owningHostInterface: false, producerFiltering: "unavailable" });
  const byteTrace = await readFile(join(tracePath, "..", "byte-trace.json"), "utf8");
  const byteReferences = JSON.parse(await readFile(join(tracePath, "..", "byte-live-presentations.json"), "utf8")) as { view: string; cursor: number; presentation: unknown }[];
  const byteFrame = ready(await local.openSnapshot({ requestId: "bytes", sourceId: "fixture:bytes", toolCallId: "byte-call", cwd: join(root, "work"), sourceRevision: 1, json: byteTrace }));
  for (const point of byteReferences) {
    ready(await local.action(byteFrame.handle, `view:${point.view}`));
    const current = ready(await local.action(byteFrame.handle, `seek:${point.cursor}`));
    assert.deepEqual(current.props.presentation, point.presentation);
    presentations.push({ case: "non-utf8", view: point.view, cursor: point.cursor, presentation: current.props.presentation });
  }
  cases.push({ name: "production-service-byte-array-restore", exactReferencePresentations: byteReferences.length, rawBytesPreserved: true, nativeDecodedDisplay: true });
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "presentations.json"), JSON.stringify(presentations, null, 2));
  await local.close();
  await stopped(workers.at(-1)!);
  let clockOffset = 0;
  const continuity = service(() => performance.now() + clockOffset);
  const snapshotSource = { sourceId: "fixture:observed-call", toolCallId: "observed-call", cwd: join(root, "work"), json };
  const observed = ready(await continuity.openSnapshot({ ...snapshotSource, requestId: "observed", sourceRevision: 1 }));
  const peer = ready(await continuity.open({ requestId: "peer", file: sourcePath, toolCallId: "external-call" }));
  const sourceTrace = JSON.parse(json);
  const cursor = Math.min(2, sourceTrace.history.length);
  ready(await continuity.action(observed.handle, `seek:${cursor}`));
  const heldSeq = sourceTrace.history[cursor - 1]?.seq;
  const replacement = JSON.stringify({ ...sourceTrace, history: sourceTrace.history.slice(1), historyTruncated: true });
  const updated = ready(await continuity.updateSnapshot({ handle: observed.handle, sourceId: snapshotSource.sourceId, sourceRevision: 2, json: replacement }));
  const expectedCursor = sourceTrace.history.slice(1).filter((event: { seq: number }) => event.seq <= heldSeq).length;
  assert.equal(updated.props.presentation.timeline.cursor, expectedCursor);
  assert.equal(updated.sourceRevision, 2);
  const superseded = continuity.updateSnapshot({ handle: observed.handle, sourceId: snapshotSource.sourceId, sourceRevision: 3, json });
  const newest = continuity.updateSnapshot({ handle: observed.handle, sourceId: snapshotSource.sourceId, sourceRevision: 4, json: replacement });
  const supersededOutcome = await superseded;
  assert.deepEqual(supersededOutcome, { status: "unavailable", reason: "cancelled" });
  const applied = ready(await newest);
  assert.equal(applied.sourceRevision, 4);
  const beforeLowerRevision = { requests: workers.at(-1)!.requests, frames: frames.length };
  const lowerRevisionOutcome = await continuity.updateSnapshot({ handle: observed.handle, sourceId: snapshotSource.sourceId, sourceRevision: 2, json });
  assert.deepEqual(lowerRevisionOutcome, { status: "unavailable", reason: "cancelled" });
  assert.equal(workers.at(-1)!.requests, beforeLowerRevision.requests, "An already-applied lower revision dispatched native work");
  assert.equal(frames.length, beforeLowerRevision.frames, "An already-applied lower revision emitted a frame");
  const retained = ready(await continuity.action(observed.handle, `seek:${expectedCursor}`));
  assert.equal(retained.sourceRevision, 4);
  assert.equal(retained.revision, applied.revision + 1, "Rejected lower revision advanced the presentation revision");
  assert.deepEqual(retained.props.presentation, applied.props.presentation);
  const beforeRefusal = workers.at(-1)!.pid;
  const refused = await continuity.openSnapshot({ ...snapshotSource, requestId: "oversized-row", sourceId: "fixture:huge-row", sourceRevision: 1,
    json: JSON.stringify({ v: 1, seq: 0, t_ns: 0, script: "literal".repeat(12000), units: [] }) });
  assert.equal(refused.status, "unavailable");
  ready(await continuity.action(peer.handle, "view:raw"));
  assert.equal(workers.at(-1)!.pid, beforeRefusal, "One refused presentation restarted healthy siblings");
  fault = "cancel"; faultStarted = Promise.withResolvers<void>();
  const interrupted = continuity.action(observed.handle, "seek:0");
  await faultStarted.promise;
  const cancelledWorker = workers.at(-1)!;
  const cancellationAt = performance.now();
  continuity.release(observed.handle);
  assert.deepEqual(await interrupted, { status: "unavailable", reason: "cancelled" });
  const cancellationMs = performance.now() - cancellationAt + await stopped(cancelledWorker);
  assert.ok(cancellationMs <= 250, `Sibling-preserving cancellation exceeded 250ms: ${cancellationMs}`);
  ready(await continuity.action(peer.handle, "view:pseudo"));
  assert.notEqual(workers.at(-1)!.pid, cancelledWorker.pid);
  assert.equal(invalidations.some(event => event.handles.includes(peer.handle)), false);
  const idle = ready(await continuity.openSnapshot({ ...snapshotSource, sourceId: "fixture:idle", requestId: "idle", sourceRevision: 1 }));
  const idleWorker = workers.at(-1)!;
  // Stagger idle ages so admission expires one native handle without stopping the peer's worker.
  clockOffset += SHELL_SERVICE_LIMITS.idleMs / 2;
  ready(await continuity.action(peer.handle, "view:raw"));
  const idleOpsStart = idleWorker.requestOps.length;
  clockOffset += SHELL_SERVICE_LIMITS.idleMs / 2 + 1;
  const wake = ready(await continuity.openSnapshot({ ...snapshotSource, sourceId: "fixture:wake", requestId: "wake", sourceRevision: 1 }));
  const usablePeer = ready(await continuity.action(peer.handle, "view:raw"));
  assert.equal(usablePeer.handle, peer.handle);
  const restoredIdle = ready(await continuity.action(idle.handle, "view:raw"));
  assert.equal(restoredIdle.handle, idle.handle);
  assert.equal(restoredIdle.props.presentation.preferences.view, "raw");
  assert.equal(workers.at(-1)!.pid, idleWorker.pid, "Idle expiry restarted the visible peer's worker");
  const idleRequestOps = idleWorker.requestOps.slice(idleOpsStart);
  assert.deepEqual(idleRequestOps, [
    { op: "release", handle: idle.handle, nativeCompleted: true },
    { op: "restore", handle: wake.handle, nativeCompleted: true },
    { op: "present", handle: wake.handle, nativeCompleted: true },
    { op: "present", handle: peer.handle, nativeCompleted: true },
    { op: "restore", handle: idle.handle, nativeCompleted: true },
    { op: "present", handle: idle.handle, nativeCompleted: true },
  ]);
  assert.equal(invalidations.some(event => event.handles.includes(peer.handle) || event.handles.includes(idle.handle)), false, "Idle expiry invalidated a retained handle");
  presentationDelayMs = 150;
  ready(await continuity.action(peer.handle, "play"));
  await sleep(320);
  presentationDelayMs = 0;
  ready(await continuity.action(peer.handle, "pause"));
  assert.equal(invalidations.some(event => event.handles.includes(peer.handle)), false);
  ready(await continuity.action(wake.handle, "view:raw"));
  cases.push({ name: "production-service-snapshot-and-sibling-continuity", cursorRemappedBySequence: true,
    queuedSourceSupersession: { supersededRevision: 3, appliedRevision: applied.sourceRevision, outcome: supersededOutcome },
    appliedLowerSourceRevisionRejection: { rejectedRevision: 2, appliedRevision: applied.sourceRevision, retainedRevision: retained.sourceRevision, outcome: lowerRevisionOutcome, nativeRequests: 0, emittedFrames: 0 },
    refusalPreservesWorkerAndPeers: true, cancellationPreservesPeers: true, cancellationMs,
    admissionTriggeredIdleReleaseAndRestore: { workerPid: idleWorker.pid, idleHandle: idle.handle, visiblePeerHandle: peer.handle, visiblePeerUsableWithoutRestore: true, requestOps: idleRequestOps },
    parentInjectedResponseDelayAfterNativePresentationMs: 150, playbackWaiterSurvivedTicks: true });
  await continuity.close();
  // A separate real bash process remains alive through all production-worker faults.
  sentinel = spawn("/bin/bash", ["--noprofile", "--norc", "-c", 'printf "independent-bash-started\\n"; while [ ! -e "$1" ]; do sleep 0.05; done; printf "independent-bash-finished\\n"', "fixture", join(root, "finish")], { cwd: join(root, "work"), env: safeEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
  sentinel.stdout!.on("data", data => { sentinelOutput += String(data); });
  const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  sentinel.once("exit", (code, signal) => { sentinelEnded = true; exited.resolve({ code, signal }); });
  sentinelExit = exited.promise;
  while (!sentinelOutput.includes("independent-bash-started")) { assert.equal(sentinelEnded, false); await sleep(5); }
  for (const mode of ["cancel", "timeout", "crash"] as const) {
    const current = service();
    const open = ready(await current.open({ requestId: mode, file: sourcePath, toolCallId: "external-call" }));
    const target = workers.at(-1)!;
    assert.notEqual(target.pid, sentinel.pid);
    fault = mode; faultStarted = Promise.withResolvers<void>();
    const at = performance.now();
    const pending = current.action(open.handle, "seek:1");
    await faultStarted.promise;
    if (mode === "cancel") current.cancel(mode);
    const outcome = await pending;
    const outcomeMs = performance.now() - at;
    assert.deepEqual(outcome, { status: "unavailable", reason: mode === "cancel" ? "cancelled" : mode });
    const terminationMs = await stopped(target);
    const afterDeadlineMs = mode === "timeout" ? outcomeMs - SHELL_WORKER_LIMITS.requestMs + terminationMs : outcomeMs + terminationMs;
    assert.ok(afterDeadlineMs <= 250, `Termination exceeded 250 ms: ${afterDeadlineMs}`);
    process.kill(sentinel.pid!, 0); assert.equal(sentinelEnded, false);
    const frameCount = frames.length;
    await sleep(30);
    assert.equal(frames.length, frameCount, "A stale response updated the viewer after invalidation");
    const retry = ready(await current.open({ requestId: mode + "-retry", file: sourcePath, toolCallId: "external-call" }));
    assert.notEqual(workers.at(-1)!.pid, target.pid);
    ready(await current.action(retry.handle, "view:raw"));
    cases.push({ name: "production-service-" + mode, outcome, outcomeMs, terminationAfterDeadlineMs: afterDeadlineMs, freshRetry: true, independentBashAlive: true, ordinaryOutput });
    await current.close();
  }
  await writeFile(join(root, "finish"), "finish");
  assert.deepEqual(await sentinelExit, { code: 0, signal: null });
  assert.equal(sentinelOutput, "independent-bash-started\nindependent-bash-finished\n");
  assert.deepEqual({ source: await fingerprint(sourcePath), lease: await fingerprint(leasePath) }, before);
  assert.equal(modelRequests, 0); assert.equal(ambientLoads, 0);
  assert.ok(heartbeatDelayMs <= 100, `Parent heartbeat exceeded 100 ms: ${heartbeatDelayMs}`);
  Object.assign(evidence, { passed: true, modelRequests, ambientLoads, sourceAndLeaseUnchanged: true, sourceFingerprint: before, independentBash: { pid: sentinel.pid, output: sentinelOutput, exit: await sentinelExit }, heartbeatDelayMs,
    platformGaps: ["Windows .exe launch, taskkill termination and PowerShell/CIM process-tree RSS require native Windows evidence.", "Linux process-group behavior requires a native Linux evidence run.", "Fault injection suspends the private process before presentation dispatch; it does not assert a particular native instruction was executing.", "The loopback trap observes no model requests; production bootstrap has no model configuration or credentials and never starts the session."] });
} catch (error) { Object.assign(evidence, { passed: false, error: String(error), modelRequests, ambientLoads, heartbeatDelayMs }); throw error; }
finally {
  for (const current of services) await current.close();
  if (sentinel?.pid && !sentinelEnded) { try { process.kill(-sentinel.pid, "SIGKILL"); } catch {} await sentinelExit; }
  clearInterval(heartbeat);
  provider.closeAllConnections();
  const providerClosed = Promise.withResolvers<void>();
  provider.close(() => providerClosed.resolve());
  await providerClosed.promise;
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "evidence.json"), JSON.stringify(evidence, null, 2));
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ evidence: join(destination, "evidence.json"), cases: cases.length, passed: true }));
