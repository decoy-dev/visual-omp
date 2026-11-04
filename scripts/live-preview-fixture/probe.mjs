import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { gzipSync } from "node:zlib";
import { fixtureEnvironment } from "./environment.mjs";
import { startFixture } from "./server.mjs";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const output = outputIndex >= 0 ? resolve(args[outputIndex + 1]) : await mkdtemp(join(tmpdir(), "vomp-preview-evidence-"));
const root = await mkdtemp(join(tmpdir(), "vomp-preview-probe-"));
await mkdir(output, { recursive: true });
const requests = [];
const fixture = await startFixture({ root, port: 0, onRequest: request => requests.push(request) });
const env = fixtureEnvironment(root);
const binary = process.env.OMP_FIXTURE_BINARY || "omp";
const version = execFileSync(binary, ["--version"], { env, encoding: "utf8" }).trim();
const configPath = execFileSync(binary, ["config", "path"], { cwd: join(root, "work"), env, encoding: "utf8" }).trim();

async function exists(path) { try { await stat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
async function scenario(name, prompt, action) {
  const cwd = join(root, name);
  await mkdir(cwd);
  const child = spawn(binary, ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--no-pty", "--tools", "write,bash,generate_image", "--model", "fixture/preview", "--thinking", "off", "--auto-approve"], { cwd, env, stdio: "pipe" });
  const frames = [];
  const input = [];
  let stderr = "";
  let failure;
  let sequence = 0;
  let actionSent = false;
  let fileAbsentAtAction;
  let noToolStartedAtAction;
  const pending = new Map();
  const started = Date.now();
  const send = (type, fields = {}) => {
    const command = { id: `probe-${++sequence}`, type, ...fields };
    input.push({ elapsedMs: Date.now() - started, command });
    child.stdin.write(JSON.stringify(command) + "\n");
    return command.id;
  };
  const request = (type, fields) => new Promise((resolve, reject) => {
    const id = send(type, fields);
    pending.set(id, { resolve, reject });
  });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.on("error", error => { failure = error; });
  child.stderr.on("data", data => { stderr += String(data); });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    let event;
    try { event = JSON.parse(line); } catch { failure = new Error(`Non-JSON RPC output: ${line}`); return; }
    frames.push({ elapsedMs: Date.now() - started, event });
    if (event.type === "response" && pending.has(event.id)) {
      const waiting = pending.get(event.id);
      pending.delete(event.id);
      if (event.success) waiting.resolve(event.data); else waiting.reject(new Error(event.error));
    }
    const partial = event.type === "message_update" ? event.message : null;
    const call = partial?.content?.find(part => part.type === "toolCall");
    if (action && !actionSent && call && JSON.stringify(call.arguments).length > 900) {
      actionSent = true;
      fileAbsentAtAction = !existsSync(join(cwd, "poster.svg"));
      noToolStartedAtAction = !frames.some(frame => frame.event.type === "tool_execution_start");
      send(action, action === "steer" ? { message: "Use a blue square instead. Do not write the poster." } : {});
    }
  });
  const until = async (predicate, label) => {
    const deadline = Date.now() + 65000;
    while (!predicate()) {
      if (failure) throw failure;
      if (child.exitCode !== null) throw new Error(`omp exited before ${label}: ${stderr}`);
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}. Last events: ${frames.slice(-4).map(frame => frame.event.type).join(", ")}. ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  let result;
  try {
    await until(() => frames.some(frame => frame.event.type === "ready"), "ready");
    const initialState = await request("get_state");
    send("prompt", { message: prompt });
    await until(() => frames.some(frame => frame.event.type === "agent_end"), "agent_end");
    const messages = await request("get_messages");
    const state = await request("get_state");
    const sessionText = await readFile(state.sessionFile, "utf8");
    const sessionEntries = sessionText.trim().split("\n").map(line => JSON.parse(line));
    const eventRuns = [];
    for (const { event } of frames) {
      const key = event.type === "message_update" ? `${event.type}:${event.assistantMessageEvent?.type ?? "unknown"}` : event.type;
      if (eventRuns.at(-1)?.type === key) eventRuns.at(-1).count++;
      else eventRuns.push({ type: key, count: 1 });
    }
    result = {
      name, prompt, action: action ?? null, cwd, actionSent, fileAbsentAtAction, noToolStartedAtAction,
      interruptMode: initialState.interruptMode,
      eventRuns, inputs: input,
      messages,
      assistantEnds: frames.filter(frame => frame.event.type === "message_end" && frame.event.message?.role === "assistant").map(frame => ({ stopReason: frame.event.message.stopReason, errorMessage: frame.event.message.errorMessage, content: frame.event.message.content.map(part => part.type === "toolCall" ? { type: part.type, name: part.name, id: part.id, argumentBytes: JSON.stringify(part.arguments).length } : part) })),
      toolResults: frames.filter(frame => frame.event.type === "tool_execution_end").map(frame => frame.event),
      sessionEntries: sessionEntries.map(entry => ({ type: entry.type, role: entry.message?.role, stopReason: entry.message?.stopReason, toolName: entry.message?.toolName, content: entry.message?.role === "toolResult" ? entry.message.content : undefined, details: entry.message?.details })),
      files: await readdir(cwd),
      posterExists: await exists(join(cwd, "poster.svg")),
      generateImageRegistered: initialState.dumpTools?.some(tool => tool.name === "generate_image") ?? false,
      generateImageSchema: initialState.dumpTools?.find(tool => tool.name === "generate_image")?.parameters,
      requests: requests.splice(0),
      stderr,
    };
    // Full arguments and repeated partial messages remain available in the compressed evidence.
    delete result.messages;
    await writeFile(join(output, `${name}.events.jsonl.gz`), gzipSync(frames.map(frame => JSON.stringify(frame)).join("\n") + "\n"));
    await writeFile(join(output, `${name}.session.jsonl.gz`), gzipSync(sessionText));
    await writeFile(join(output, `${name}.inputs.json`), JSON.stringify(input, null, 2) + "\n");
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), 3000);
    await exited;
    clearTimeout(timer);
  }
  console.log(`${name}: ${result.assistantEnds.map(message => message.stopReason).join(", ")}; files: ${result.files.join(", ") || "none"}`);
  return result;
}

try {
  const scenarios = [];
  for (const [name, prompt, action] of [
    ["svg-saved", "fixture svg"],
    ["svg-aborted", "fixture svg", "abort"],
    ["svg-steered", "fixture svg", "steer"],
    ["image-aborted", "fixture image", "abort"],
    ["png-saved", "fixture png"],
    ["html-saved", "fixture html"],
  ]) scenarios.push(await scenario(name, prompt, action));
  await writeFile(join(output, "results.json"), JSON.stringify({ version, root, configPath, expectedConfigPath: env.PI_CODING_AGENT_DIR, environment: env, scenarios }, null, 2) + "\n");
  console.log(`Evidence: ${output}`);
} finally {
  await fixture.close();
}
