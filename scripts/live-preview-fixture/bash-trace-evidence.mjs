import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node-pty";
import { z } from "zod";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bashRenderer } from "../../src/renderer/src/tool-render/tools/bash";
import { LoopbackRelay } from "../../src/main/omp/relay";
import { TspSession } from "../../src/main/omp/tsp/session";
import { TspStream } from "../../src/main/omp/tsp/stream";
import { GuestClient } from "../../src/renderer/src/collab/lib/client";
import { isRecord, resultTextOf } from "../../src/renderer/src/tool-render/util";
import { fixtureEnvironment } from "./environment.mjs";
import { startFixture } from "./server.mjs";
const bin = process.env.OMP_BIN;
if (!bin)
  throw new Error("Set OMP_BIN to the installed omp executable.");
const destination = resolve(process.env.OMP_TRACE_EVIDENCE ?? "/tmp/omp-18.17.0-bash-trace");
await mkdir(destination, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "vomp-bash-trace-"));
const provider = await startFixture({ root, port: 0, durationMs: 0 });
const env = { ...fixtureEnvironment(root), TERM_PROGRAM: "tern" };
const relay = new LoopbackRelay;
let child;
let guest;
let exited = false;
const failures = [];
const samples = new Map;
const bytes = (value) => Buffer.byteLength(JSON.stringify(value) ?? "");
const ResultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()),
  details: z.record(z.string(), z.unknown()).optional()
}).loose();
const EntrySchema = z.object({ type: z.literal("message"), message: ResultSchema.extend({ role: z.literal("toolResult"), toolCallId: z.string() }) }).loose();
const metrics = (value) => {
  const message = ResultSchema.parse(value);
  const output = resultTextOf(message);
  const trace = message.details?.trace;
  return {
    bytes: bytes(message),
    textBytes: Buffer.byteLength(output),
    traceBytes: bytes(trace),
    traceRecords: isRecord(trace) && Array.isArray(trace.history) ? trace.history.length : null,
    collabElided: /chars elided for collab session/.test(output),
    collabOmitted: /collab-entry-too-large|omitted for collab session/.test(JSON.stringify(message)),
    textHead: output.slice(0, 160),
    textTail: output.slice(-240)
  };
};
const until = async (predicate, label, timeout = 180000) => {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (exited || Date.now() > deadline)
      throw new Error(label);
    await sleep(40);
  }
};
try {
  await relay.start();
  const configFile = join(env.PI_CODING_AGENT_DIR, "config.yml");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  config.collab = { autoStart: "control", relayUrl: relay.url, displayName: "Bash trace evidence" };
  config.update = { auto: false };
  config.display = { shellVisualization: process.env.OMP_TRACE_VISUALIZATION !== "0" };
  await writeFile(configFile, JSON.stringify(config));
  const version = execFileSync(bin, ["--version"], { cwd: root, env, encoding: "utf8", timeout: 15000 }).trim();
  if (version !== "omp/18.17.0")
    throw new Error(`Expected omp/18.17.0, received ${version}`);
  const session = new TspSession({ cols: 110, dark: false, reduceMotion: true, write: (data) => child.write(data), onError: (error) => failures.push(String(error)) });
  const stream = new TspStream({ onMessage: (message) => session.receive(message), onData: (data) => {
    if (data.includes(Buffer.from("\x1B[c")))
      session.terminalReply("\x1B[?62;22c");
    if (data.includes(Buffer.from("\x1B[6n")))
      session.terminalReply("\x1B[1;1R");
  } });
  child = spawn(bin, ["--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--session-dir", join(root, "sessions"), "--model", "fixture/preview", "--thinking", "off"], { name: "xterm-256color", cols: 110, rows: 32, cwd: join(root, "work"), env, encoding: null });
  child.onData((data) => stream.push(typeof data === "string" ? Buffer.from(data) : data));
  child.onExit(() => {
    exited = true;
  });
  await until(() => session.availability().available, "TSP editor did not become ready");
  let hosts = [];
  await until(() => {
    hosts = JSON.parse(execFileSync(bin, ["collab", "list", "--json"], { cwd: root, env, encoding: "utf8", timeout: 1e4 })).hosts;
    return hosts.length > 0;
  }, "Isolated collab host did not register");
  const link = JSON.parse(execFileSync(bin, ["collab", "link", hosts[0].instanceId, "--json"], { cwd: root, env, encoding: "utf8", timeout: 1e4 })).url;
  guest = new GuestClient(link, "visual-omp trace evidence");
  guest.subscribe(() => {
    const snapshot = guest.getSnapshot();
    for (const [id, tool] of snapshot.activeTools) {
      const message = tool.partialResult;
      if (!message)
        continue;
      const next = metrics(message);
      const prior = samples.get(id);
      if (!prior || next.bytes > prior.bytes || next.collabElided || next.collabOmitted)
        samples.set(id, next);
    }
  });
  guest.connect();
  await until(() => guest.getSnapshot().phase === "live", "Real renderer collab client did not connect");
  await session.submit("fixture bash-trace");
  await until(() => guest.getSnapshot().entries.some((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some((part) => part.type === "text" && part.text.includes("fixture tool result was received"))) && !guest.getSnapshot().working, "Trace fixture did not finish");
  await session.submit("/exit");
  await until(() => exited, "omp did not exit");
  const entries = guest.getSnapshot().entries;
  const files = (await readdir(join(root, "sessions"))).filter((file) => file.endsWith(".jsonl"));
  const saved = [];
  for (const file of files)
    saved.push(...(await readFile(join(root, "sessions", file), "utf8")).split(`
`).filter(Boolean).map((line) => JSON.parse(line)));
  const results = await Promise.all(saved.flatMap((value) => {
    const parsed = EntrySchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  }).map(async (entry) => {
    const replicated = entries.find((item) => item.type === "message" && item.message.role === "toolResult" && item.message.toolCallId === entry.message.toolCallId);
    const markup = replicated?.type === "message" ? renderToStaticMarkup(createElement(bashRenderer.Body, { name: "bash", args: { command: "fixture bash-trace" }, result: replicated.message, running: false })) : "";
    await writeFile(join(destination, `${entry.message.toolCallId}.card.html`), markup);
    return {
      toolCallId: entry.message.toolCallId,
      saved: metrics(entry.message),
      collab: replicated && replicated.type === "message" ? metrics(replicated.message) : null,
      sameContent: replicated?.type === "message" && JSON.stringify(replicated.message.content) === JSON.stringify(entry.message.content),
      savedTraceKeys: isRecord(entry.message.details?.trace) ? Object.keys(entry.message.details.trace) : [],
      card: { containsElisionMarker: markup.includes("chars elided for collab session"), containsArtifactReference: markup.includes("artifact://"), bytes: Buffer.byteLength(markup) }
    };
  }));
  const artifacts = [];
  await mkdir(join(destination, "artifacts"), { recursive: true });
  for (const file of (await readdir(join(root, "sessions"), { recursive: true })).filter((file) => file.endsWith(".bash.log"))) {
    const source = join(root, "sessions", file);
    const target = join(destination, "artifacts", file.split("/").at(-1));
    await copyFile(source, target);
    artifacts.push({ path: target, bytes: (await stat(source)).size });
  }
  const evidence = {
    version,
    visualization: config.display.shellVisualization,
    root,
    files,
    results,
    activeSamples: Object.fromEntries(samples),
    failures,
    collabOmittedEntries: entries.filter((entry) => JSON.stringify(entry).includes("collab-entry-too-large")),
    notices: guest.getSnapshot().notices,
    artifacts
  };
  await Promise.all([
    writeFile(join(destination, "evidence.json"), JSON.stringify(evidence, null, 2)),
    writeFile(join(destination, "saved.json"), JSON.stringify(saved)),
    writeFile(join(destination, "collab.json"), JSON.stringify(entries))
  ]);
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  guest?.close();
  if (child && !exited)
    child.kill();
  relay.stop();
  await provider.close();
  await rm(root, { recursive: true, force: true });
}
