import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, stat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { fixtureEnvironment, requireFixture } from "../live-preview-fixture/environment.mjs";
import { startFixture } from "../live-preview-fixture/server.mjs";
import { configureTour, padSession, prepareUpdateFixture, seedPendingUpdate, appendRecordedTools, validateRecordedTools } from "./tour-fixtures.mjs";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const defaultRelease = "0.7.14";

export function tourLayout(chats) {
  if (!chats.length) throw new Error("A release tour needs at least one chat.");
  return {
    tabs: chats.map(({ id, projectPath, sessionFile, title }) => ({ id: `tour-${id}`, projectPath, sessionFile, title })),
    activeTabId: `tour-${chats[0].id}`, activeProject: chats[0].projectPath,
    splitTabId: null, focusedSplit: "primary", sidebarOpen: true, unseenChats: {},
    docks: Object.fromEntries(chats.map(chat => [`tour-${chat.id}`, { open: true, pane: chat.pane ?? (chat.helper ? "tasks" : "files"), width: 540 }])),
  };
}

export function parseArguments(args) {
  const options = { release: defaultRelease, prepareOnly: false, resume: null, binary: process.env.OMP_FIXTURE_BINARY || "omp" };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--prepare-only") options.prepareOnly = true;
    else if (["--release", "--resume", "--omp"].includes(flag)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
      options[flag === "--release" ? "release" : flag === "--omp" ? "binary" : "resume"] = value;
    } else throw new Error(`Unknown option: ${flag}. Use --release <version>, --prepare-only, --resume <root> or --omp <executable>.`);
  }
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(options.release)) throw new Error("The tour release must be a version number.");
  if (options.prepareOnly && options.resume) throw new Error("--prepare-only creates a new tour; --resume opens a prepared tour.");
  return options;
}

export function tourEnvironment(root, binary) {
  const env = fixtureEnvironment(root);
  if (isAbsolute(binary ?? "")) env.PATH = [dirname(binary), env.PATH].filter(Boolean).join(delimiter);
  return env;
}

export async function readTourSession(file) {
  const entries = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  if (!entries.some(entry => entry.type === "session") || !entries.some(entry => entry.message?.role === "user") || !entries.some(entry => entry.message?.role === "assistant")) {
    throw new Error(`Incomplete omp tour session: ${file}`);
  }
  if (entries.some(entry => entry.message?.stopReason === "error" || entry.message?.isError)) throw new Error(`Failed omp turn in ${file}`);
  for (const entry of entries) {
    if (entry.message?.role !== "toolResult" || !entry.message.toolCallId?.startsWith("tour-recorded-")) continue;
    const callIndex = entries.findIndex(candidate => candidate.message?.role === "assistant" && candidate.message.content?.some(part => part.type === "toolCall" && part.id === entry.message.toolCallId && part.name === entry.message.toolName));
    if (callIndex < 0 || callIndex >= entries.indexOf(entry)) throw new Error(`Unpaired recorded tool result in ${file}`);
  }
  return entries;
}

export async function generateChat({ root, env, binary, chat, signal }) {
  const cwd = join(root, "chats", chat.folder ?? chat.id);
  await mkdir(cwd, { recursive: true });
  if (chat.sampleHtml) await writeFile(join(cwd, "sample.html"), '<!doctype html><html lang="en"><meta charset="utf-8"><title>Files viewer sample</title><link rel="stylesheet" href="style.css"><h1>Files viewer sample</h1><p>Local styles and the image should render with scripts disabled.</p><img src="image.svg" alt="Local fixture image"></html>\n');
  const child = spawn(binary, ["--mode", "rpc-ui", "--no-ui", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--no-pty", "--tools", "write,bash,ask,task,wait", "--model", chat.model ?? "fixture/preview", "--thinking", "off", "--auto-approve"], { cwd, env, signal, stdio: "pipe" });
  let stderr = "";
  let sequence = 0;
  let failure;
  const pending = new Map();
  const listeners = new Set();
  const tools = [];
  const questions = [];
  const exited = new Promise(resolveExit => child.once("exit", (code, exitSignal) => resolveExit({ code, signal: exitSignal })));
  const fail = error => {
    failure = error;
    for (const waiter of [...pending.values(), ...listeners]) waiter.reject(error);
    pending.clear(); listeners.clear();
  };
  child.on("error", fail);
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  child.once("exit", () => fail(new Error(`omp exited while preparing ${chat.id}. ${stderr}`)));
  const send = (type, fields = {}) => {
    if (failure) throw failure;
    const id = `tour-${++sequence}`;
    child.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
    return id;
  };
  const request = (type, fields) => new Promise((resolveRequest, reject) => {
    try { pending.set(send(type, fields), { resolve: resolveRequest, reject }); } catch (error) { reject(error); }
  });
  const event = type => new Promise((resolveEvent, reject) => {
    if (failure) { reject(failure); return; }
    listeners.add({ type, resolve: resolveEvent, reject });
  });
  const ready = event("ready");
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    try {
      const frame = JSON.parse(line);
      if (frame.type === "response" && pending.has(frame.id)) {
        const waiter = pending.get(frame.id); pending.delete(frame.id);
        if (frame.success) waiter.resolve(frame.data); else waiter.reject(new Error(frame.error));
      }
      if (frame.type === "tool_execution_start") tools.push(frame.toolName);
      if (frame.type === "tool_execution_end" && frame.isError) throw new Error(`${chat.id}: ${JSON.stringify(frame.result)}`);
      if (frame.type === "extension_ui_request" && frame.method === "select") {
        questions.push({ title: frame.title, options: frame.options });
        if (!chat.answer) throw new Error(`Unexpected tour question in ${chat.id}.`);
        child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: frame.id, value: chat.answer }) + "\n");
      }
      for (const waiter of listeners) if (waiter.type === frame.type) { listeners.delete(waiter); waiter.resolve(frame); }
    } catch (error) { fail(error); }
  });
  const timeout = setTimeout(() => { fail(new Error(`Timed out preparing ${chat.id}. ${stderr}`)); child.kill("SIGTERM"); }, chat.timeoutMs ?? 120_000);
  try {
    await ready;
    for (const message of chat.prompts) {
      const finished = event("agent_end");
      send("prompt", { message: message.replaceAll("{{projectPath}}", cwd) });
      await finished;
    }
    await request("set_session_name", { name: chat.title });
    const state = await request("get_state");
    const entries = await readTourSession(state.sessionFile);
    const projectPath = entries.find(entry => entry.type === "session")?.cwd;
    if (typeof projectPath !== "string" || !isAbsolute(projectPath)) throw new Error(`Missing project cwd in tour session: ${state.sessionFile}`);
    if (chat.model && !entries.some(entry => entry.message?.role === "assistant" && `${entry.message.provider}/${entry.message.model}` === chat.model)) throw new Error(`The ${chat.id} fixture did not use ${chat.model}.`);
    if (chat.expectedCacheRead && !entries.some(entry => entry.message?.usage?.cacheRead === chat.expectedCacheRead)) throw new Error(`The ${chat.id} fixture did not report the expected cache usage.`);
    if (chat.expectedReply && !entries.some(entry => entry.message?.role === "assistant" && entry.message.content?.some(part => part.type === "text" && part.text.includes(chat.expectedReply)))) throw new Error(`The ${chat.id} fixture did not confirm its expected reply.`);
    for (const file of chat.files ?? []) if (!(await stat(join(cwd, file))).size) throw new Error(`Missing tour output: ${file}`);
    if (chat.helper) await readTourSession(join(state.sessionFile.replace(/\.jsonl$/, ""), "TourHelper.jsonl"));
    if (chat.answer && !questions.length) throw new Error(`The ${chat.id} fixture did not open its question.`);
    if (chat.helper && !tools.includes("task")) throw new Error("The helper fixture did not call task.");
    return { ...chat, projectPath, sessionFile: state.sessionFile, tools, questions };
  } finally {
    clearTimeout(timeout);
    // Stop the generator before the app can claim the same omp session lease.
    child.stdin.end();
    if (child.exitCode === null && !child.signalCode) {
      const kill = setTimeout(() => child.kill("SIGTERM"), 2000);
      await exited;
      clearTimeout(kill);
    }
    lines.close();
  }
}

export async function prepareTour({ root, binary, manifest, signal }) {
  const env = tourEnvironment(root, binary);
  const version = execFileSync(binary, ["--version"], { env, encoding: "utf8" }).trim();
  const config = execFileSync(binary, ["config", "path"], { cwd: join(root, "work"), env, encoding: "utf8" }).trim();
  if (await realpath(config) !== await realpath(env.PI_CODING_AGENT_DIR)) throw new Error("omp did not select the scratch agent directory.");
  await configureTour(env, manifest);
  const fixtureBase = manifest.updateFixture ? JSON.parse(await readFile(join(root, "fixture.json"), "utf8")).baseUrl : undefined;
  const updateFeed = manifest.updateFixture ? await prepareUpdateFixture(root, version, manifest.updateFixture === true ? {} : manifest.updateFixture, fixtureBase) : undefined;
  const chats = [];
  for (const chat of manifest.chats) {
    const generated = await generateChat({ root, env, binary, chat, signal });
    await appendRecordedTools(generated.sessionFile, await readTourSession(generated.sessionFile), chat.recordedTools);
    validateRecordedTools(await readTourSession(generated.sessionFile), chat.recordedTools);
    await padSession(root, generated.sessionFile, await readTourSession(generated.sessionFile), chat.padBytes);
    if (chat.recordedTools) generated.tools.push(...chat.recordedTools.map(tool => tool.name));
    chats.push(generated);
    console.log(`Prepared ${chat.title}`);
  }
  const seed = join(root, "tour-layout.json");
  await writeFile(seed, JSON.stringify(tourLayout(chats), null, 2) + "\n");
  await writeFile(join(env.VOMP_DEV_PROFILE, "preferences.json"), JSON.stringify({ setupCompleted: true, tourCompleted: true, newUserApproval: "done", livePreview: true, livePreviewOpenOutputs: true, sendCrashReports: false, ...manifest.preferences, ...(isAbsolute(binary) ? { ompPath: binary } : {}) }, null, 2) + "\n");
  const summary = { release: manifest.version, ompVersion: version, root, seed, binary, updateFeed, pendingUpdate: manifest.updateFixture?.pendingUpdate, chats: chats.map(({ id, title, projectPath, sessionFile, files, tools, questions, recordedTools }) => ({ id, title, projectPath, sessionFile, files, tools, questions, recordedTools })) };
  await writeFile(join(root, "tour.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = options.resume ? resolve(options.resume) : await realpath(await mkdtemp(join(tmpdir(), `vomp-tour-${options.release}-`)));
  const abort = new AbortController();
  let dev;
  const interrupt = () => { abort.abort(); dev?.kill("SIGTERM"); };
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, interrupt);
  let fixture;
  try {
    let summary;
    if (options.resume) {
      await requireFixture(root);
      summary = JSON.parse(await readFile(join(root, "tour.json"), "utf8"));
      if (summary.root !== root || summary.seed !== join(root, "tour-layout.json")) throw new Error("The prepared tour marker does not match its root.");
      if (summary.updateFeed) {
        const path = relative(root, await realpath(summary.updateFeed));
        if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error("The update feed is outside its scratch root.");
      }
      for (const chat of summary.chats) {
        const path = relative(root, await realpath(chat.sessionFile));
        if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error("A tour session is outside its scratch root.");
        validateRecordedTools(await readTourSession(chat.sessionFile), chat.recordedTools);
      }
      const marker = JSON.parse(await readFile(join(root, "fixture.json"), "utf8"));
      fixture = await startFixture({ root, port: Number(new URL(marker.baseUrl).port), initializeProfile: false });
    } else {
      const { default: manifest } = await import(new URL(`./tours/${options.release}.mjs`, import.meta.url));
      fixture = await startFixture({ root, port: 0 });
      summary = await prepareTour({ root, binary: options.binary, manifest, signal: abort.signal });
    }
    console.log(`Tour root: ${root}\nLayout seed: ${summary.seed}\nLocal provider: ${fixture.baseUrl}`);
    if (options.prepareOnly) {
      console.log(`Prepared without Electron. Open later with: npm run tour -- --resume ${JSON.stringify(root)}`);
      return;
    }
    const env = { ...tourEnvironment(root, summary.binary), VOMP_TOUR_CHATS: summary.seed, ...(summary.updateFeed ? { VOMP_UPDATE_FEED: summary.updateFeed } : {}) };
    // The app consumes this record on launch to show its successful-update notice, so each launch writes it again.
    if (summary.pendingUpdate) await seedPendingUpdate(env.VOMP_DEV_PROFILE, summary.pendingUpdate);
    const npmCli = process.env.npm_execpath;
    dev = spawn(npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm", npmCli ? [npmCli, "run", "dev"] : ["run", "dev"], { cwd: checkout, env, stdio: "inherit", shell: !npmCli && process.platform === "win32" });
    console.log("The local provider stays available until the development build exits. Quit the development app when finished.");
    const code = await new Promise((resolveExit, reject) => { dev.once("error", reject); dev.once("exit", (code, signal) => resolveExit(code ?? (signal ? 1 : 0))); });
    process.exitCode = code;
  } finally {
    await fixture?.close();
    for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
