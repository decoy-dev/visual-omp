import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn, type IPty } from "node-pty";
import type { TspEvent, TspNode } from "../../../shared/tsp";
import { openOverlay, screenSurface, walkNodes } from "../../../shared/tsp/view-state";
import { TSP_ACTIONS, TSP_ROLES } from "../../../shared/tsp/roles";
import { TspSession } from "./session";
import { TspStream } from "./stream";
import { encodeTspJson } from "./encode";
import { sanitizeFixtureBytes } from "./sanitize-fixture";

// Bundle beside node_modules with Bun (target node, node-pty external), then run with Node.
// No inherited configuration or provider credentials. Model turns use the isolated scripted provider.
const bin = process.env.OMP_BIN;
if (!bin) throw new Error("Set OMP_BIN to the omp 18.15.0 executable.");
if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Fixture recording is supported only on macOS and Linux.");
const versionRoot = await mkdtemp(join(tmpdir(), "vomp-tsp-version-"));
let version: string;
try {
  version = execFileSync(bin, ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH!, HOME: versionRoot, USERPROFILE: versionRoot, XDG_CONFIG_HOME: versionRoot, XDG_CACHE_HOME: versionRoot, PI_CODING_AGENT_DIR: versionRoot, PI_CONFIG_DIR: versionRoot, TMPDIR: versionRoot } }).trim();
} finally {
  await rm(versionRoot, { recursive: true, force: true });
}
if (version !== "omp/18.15.0") throw new Error(`Expected omp/18.15.0; received ${version}.`);
const destination = resolve(process.env.VOMP_TSP_FIXTURE_DIR ?? "src/main/omp/tsp/fixtures/18.15.0");
const extension = resolve("src/main/omp/tsp/fixtures/extension/vomp-fixture.mjs");
await mkdir(destination, { recursive: true });
const config = "startup:\n  setupWizard: false\n  checkUpdate: false\n  changelogMode: hidden\n  quiet: true\nmarketplace:\n  autoUpdate: off\nworktree:\n  onStart: off\n  onExit: keep\ntui:\n  autoGraph: never\nautocomplete:\n  enabled: false\nrecap:\n  enabled: false\ncomposer:\n  predictions: false\n";
type ScriptedReply = { text?: string; tool?: { name: string; arguments: object }; delayMs?: number; gate?: string; error?: string };
type Scenario = { name: string; command: string | null; hook?: "select" | "input" | "editor" | "confirm" | "rows"; end?: "open" | "submit" | "cancel"; script?: ScriptedReply[] };

/** Shared recorder mechanism from Phase 3; optional models allow session-switch compaction probes. */
async function scriptedProvider(script: ScriptedReply[], agent: string, models?: object[]) {
  const requests: object[] = [];
  const gates = new Map<string, PromiseWithResolvers<void>>();
  const released = new Set<string>();
  const release = (name: string) => { released.add(name); gates.get(name)?.resolve(); };
  const server = createServer(async (request, response) => {
    try {
      if (request.url !== "/v1/chat/completions" || request.method !== "POST") { response.writeHead(404).end(); return; }
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
      const index = requests.length;
      requests.push(body);
      const reply = script[index];
      if (!reply) { response.writeHead(500).end(`No scripted response for request ${index + 1}`); return; }
      if (reply.gate && !released.has(reply.gate)) {
        const gate = gates.get(reply.gate) ?? Promise.withResolvers<void>();
        gates.set(reply.gate, gate);
        await gate.promise;
      }
      if (reply.delayMs) await sleep(reply.delayMs);
      if (reply.error) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: reply.error, type: "invalid_request_error", code: "invalid_request_error" } }));
        return;
      }
      const delta = reply.tool
        ? { role: "assistant", tool_calls: [{ index: 0, id: `fixture-tool-${index}`, type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.arguments) } }] }
        : { role: "assistant", content: reply.text ?? "Fixture response." };
      const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: `fixture-${index}`, object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(chunk(delta, null) + chunk({}, reply.tool ? "tool_calls" : "stop") + "data: [DONE]\n\n");
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback provider port");
  await writeFile(join(agent, "models.yml"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-fixture-only", api: "openai-completions",
    models: models ?? [{ id: "fixture-model", name: "Local scripted fixture", reasoning: true, input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
  } } }));
  return { requests, release, stop: () => { for (const gate of gates.values()) gate.resolve(); server.closeAllConnections(); server.close(); } };
}
const scenarios: Scenario[] = [
  ...[
    ["hotkeys", "/hotkeys"], ["jobs", "/jobs"], ["usage", "/usage"], ["session", "/session"],
    ["changelog", "/changelog"], ["tools", "/tools"], ["model-picker", "/model"],
    ["btw-history", "/btw"],
    ["settings-screen", "/settings"], ["exit", null], ["exit-with-overlay", "/hotkeys"],
    ["startup-no-model", null], ["startup-missing-resume", null], ["notice-error", "Fixture prompt without a configured model"],
    ["extensions", "/extensions"],
    ["import-claude", null],
    ["restart", "/restart"], ["new", "/new"], ["resume", "/resume"],
    ["sibling-continuation", "/rename Fixture sibling continuation"],
  ].map(([name, command]) => ({ name: name!, command: command ?? null })),
  ...(["select", "input", "editor", "confirm", "rows"] as const).flatMap(hook =>
    (["open", "submit", "cancel"] as const).map(end => ({
      name: `${hook === "rows" ? "extension-rows" : `hook-${hook}`}${end === "submit" ? "" : `-${end}`}`,
      command: `/vomp-fixture-${hook}`, hook, end,
    }))),
  { name: "tree-open", command: "/tree", end: "open" },
  { name: "tree-confirm", command: "/tree", end: "submit" },
  { name: "hook-collab-aware", command: "/vomp-fixture-select", hook: "select", end: "open" },
  { name: "handshake-timeout", command: null, end: "open" },
  { name: "model-switch", command: null },
  { name: "thinking-cycle", command: null },
  { name: "switch-typed", command: "/switch fixture/fixture-small" },
  { name: "model-switch-compact", command: null, script: Array.from({ length: 16 }, () => ({ text: "## Summary\nThe fixture conversation contains repeated context paragraphs. Preserve the numbered fixture segments and continue the local model-switch test.", delayMs: 1000 })) },
  { name: "model-switch-compact-error", command: null, script: Array.from({ length: 16 }, () => ({ error: "Fixture compaction request failed", delayMs: 1000 })) },
];
for (const scenario of scenarios) {
  const { name, hook, end } = scenario;
  let command = scenario.command;
  if (process.argv.length > 2 && !process.argv.slice(2).includes(name)) continue;
  // Fixed POSIX root keeps recorded paths within the sanitizer's documented policy.
  const root = await mkdtemp(join("/tmp", "vomp-tsp-record-"));
  const home = join(root, "home"); const agent = join(root, "agent");
  await Promise.all([mkdir(home), mkdir(agent)]);
  const compactSwitch = name.startsWith("model-switch-compact");
  await writeFile(join(agent, "config.yml"), config + (compactSwitch ? "compaction:\n  asyncEnabled: false\n  keepRecentTokens: 4096\n" : ""));
  const modelControls = ["model-switch", "thinking-cycle", "switch-typed"].includes(name) || compactSwitch;
  const controlModels = ["large", "small"].map(size => ({ id: `fixture-${size}`, name: `Fixture ${size}`, reasoning: true,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: size === "large" ? 128000 : 32000, maxTokens: 4096 }));
  const provider = scenario.script ? await scriptedProvider(scenario.script, agent, controlModels) : undefined;
  if (modelControls && !provider) {
    await writeFile(join(agent, "models.yml"), JSON.stringify({ providers: { fixture: {
      baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-local-only", api: "openai-completions", models: controlModels,
    } } }));
  }
  const journal = join(root, "journal.jsonl");
  const missingResume = name === "startup-missing-resume";
  // A pre-TUI failure never creates a TSP journal.
  if (missingResume) await writeFile(journal, "");
  const env = { PATH: process.env.PATH!, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), TMPDIR: root, PI_CODING_AGENT_DIR: agent, PI_CONFIG_DIR: agent, TERM_PROGRAM: "tern", TERM: "xterm-256color", COLORTERM: "truecolor", OMP_SKIP_SETUP: "1", PI_TUI_TSP_RECORD: journal };
  const raw: Buffer[] = []; const events: object[] = []; const messages: object[] = [];
  let child: IPty;
  let owner: IPty | undefined;
  let ownerExit: Promise<void> | undefined;
  let exited = false;
  let exitCode: number | undefined;
  let classicFallback = false;
  const output = new TspStream({ onData: () => {}, onMessage: message => events.push({ verb: message.verb, body: JSON.parse(message.body), afterMessage: messages.length }) });
  const write = (data: string) => { if (name === "handshake-timeout") return; output.push(Buffer.from(data)); child.write(data); };
  const keys = (data: string) => { events.push({ keys: data, afterMessage: messages.length }); child.write(data); };
  // A transport probe deliberately sends the observed hook wire events directly.
  // Production input authority belongs to SessionHost, rather than this isolated recorder.
  const send = (event: TspEvent) => write(encodeTspJson("e", event));
  const session = new TspSession({ cols: 110, dark: false, reduceMotion: true, write, onError: error => { throw error; } });
  const stream = new TspStream({ onMessage: message => { messages.push({ verb: message.verb, body: JSON.parse(message.body) }); session.receive(message); }, onData: data => {
    if (data.toString().includes("No default model selected")) classicFallback = true;
    if (data.includes(Buffer.from("\x1b[c"))) session.terminalReply("\x1b[?62;22c");
    if (data.includes(Buffer.from("\x1b[6n"))) session.terminalReply("\x1b[1;1R");
  } });
  const args = ["--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--session-dir", join(root, "sessions")];
  if (modelControls) args.push("--model", "fixture/fixture-large", "--thinking", "off");
  if (compactSwitch) {
    const timestamp = "2026-11-02T00:00:00.000Z";
    const seed: object[] = [{ type: "session", version: 3, id: "6aaca402-6694-4a08-8f2b-87be2501ed59", timestamp, cwd: root, title: "Fixture model compaction", titleSource: "manual" }];
    let parentId: string | null = null;
    for (let turn = 0; turn < 8; turn++) {
      const userId = `u${turn}`; const assistantId = `a${turn}`;
      seed.push({ type: "message", id: userId, parentId, timestamp, message: { role: "user", content: `Fixture context segment ${turn}. ` + "Keep this numbered context paragraph available for the switch compaction fixture. ".repeat(500), timestamp: 1793577600000 } });
      seed.push({ type: "message", id: assistantId, parentId: userId, timestamp, message: { role: "assistant", content: [{ type: "text", text: `Fixture answer ${turn}.` }], api: "openai-completions", provider: "fixture", model: "fixture-large", usage: { input: 40000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 40100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1793577600000 } });
      parentId = assistantId;
    }
    const sessionFile = join(root, "compact-session.jsonl");
    await writeFile(sessionFile, seed.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    args.push("--session", sessionFile);
  }
  if (hook || name === "extensions") args.push("-e", extension);
  if (missingResume) args.push("--resume", join(root, "missing-session.jsonl"));
  if (name === "tree-open" || name === "tree-confirm" || name === "resume" || name === "sibling-continuation") {
    await mkdir(join(root, "sessions"), { recursive: true });
    const sessionFile = name === "resume" ? join(root, "sessions", "2026-11-02T00-00-00-000Z_c040d770-0bd0-4f54-aefe-f075e648b440.jsonl") : join(root, "tree-session.jsonl");
    const seed = await readFile(resolve("src/main/omp/tsp/fixtures/extension/tree-session.jsonl"), "utf8");
    await writeFile(sessionFile, seed.replaceAll("/tmp/vomp-fixture", root));
    if (name === "resume") command = "/resume c040d770";
    else args.push("--session", sessionFile);
  }
  if (name === "import-claude") {
    const source = join(home, ".claude", "projects", "-tmp-vomp-fixture");
    await mkdir(source, { recursive: true });
    const sessionId = "11111111-2222-4333-8444-555555555555";
    const timestamp = "2026-10-01T00:00:00.000Z";
    const entries = [
      { type: "user", uuid: "fixture-user", parentUuid: null, sessionId, cwd: root, timestamp, message: { role: "user", content: "Fixture imported prompt" } },
      { type: "assistant", uuid: "fixture-assistant", parentUuid: "fixture-user", sessionId, cwd: root, timestamp, message: { id: "fixture-message", type: "message", role: "assistant", model: "fixture", content: [{ type: "text", text: "Fixture imported answer." }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
    await writeFile(join(source, `${sessionId}.jsonl`), entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    args.push("--from-claude");
  }
  child = spawn(bin, args, { name: "xterm-256color", cols: 110, rows: 32, cwd: root, env, encoding: null });
  child.onData(data => { const bytes = typeof data === "string" ? Buffer.from(data) : data; raw.push(bytes); stream.push(bytes); });
  child.onExit(event => { exited = true; exitCode = event.exitCode; });
  const until = async (predicate: () => boolean | Promise<boolean>, label: string) => { const deadline = Date.now() + 15000; while (!await predicate()) { if (exited || Date.now() > deadline) throw new Error(`${name}: ${label}`); await sleep(30); } };
  const find = (predicate: (node: TspNode) => boolean) => {
    for (const surface of session.snapshot().surfaces) {
      if (surface.closed) continue;
      for (const node of walkNodes(surface.document)) if (predicate(node)) return { surface, node };
    }
    return undefined;
  };
  const role = hook === "input" ? TSP_ROLES.hookInput : hook === "editor" ? TSP_ROLES.hookEditor : TSP_ROLES.hookSelect;
  const dialog = () => find(node => node.p?.role === role
    || (node.k === "picker" && node.p?.title === (hook === "confirm" ? "Confirm the fixture" : "Choose a fixture option")));
  const action = (act: string) => {
    const target = dialog();
    if (target?.node.k === "picker") {
      // The picker advertises close; selector cancellation also accepts cancel.
      send({ ev: "action", sf: target.surface.open.id, id: target.node.id, act: act === "cancel" ? "close" : act });
    } else {
      const button = target && [...walkNodes(target.node)].find(node => node.p?.actions?.click === act);
      if (!target || !button) throw new Error(`${name}: missing ${act} button`);
      send({ ev: "action", sf: target.surface.open.id, id: button.id, act });
    }
  };
  const edit = async (text: string) => {
    const target = dialog();
    const field = target && [...walkNodes(target.node)].find(node => node.k === "input" || node.k === "editor");
    if (!target || !field) throw new Error(`${name}: missing editable field`);
    const len = typeof field.p?.text === "string" ? field.p.text.length : 0;
    send({ ev: "edit", sf: target.surface.open.id, id: field.id, from: 0, to: len, text, cursor: text.length, len });
    await until(() => !!find(node => (node.k === "input" || node.k === "editor") && node.id === field.id && node.p?.text === text), "edit was not reflected");
  };
  try {
    if (name === "import-claude") {
      await until(() => !!find(node => node.k === "picker" && node.p?.title === "Import Claude Session"), "startup import picker did not open");
      const target = find(node => node.k === "picker" && node.p?.title === "Import Claude Session")!;
      if (target.node.k !== "picker" || !target.node.p?.items?.length) throw new Error("Missing imported fixture session");
      const item = target.node.p.items[0]!.id;
      send({ ev: "select", sf: target.surface.open.id, id: target.node.id, item });
      send({ ev: "activate", sf: target.surface.open.id, id: target.node.id, item });
    }
    if (missingResume) {
      await until(() => exited, "missing resume did not exit");
      if (exitCode !== 1 || messages.length !== 0) throw new Error(`${name}: expected a pre-TUI failure with exit code 1`);
    } else if (name === "handshake-timeout") {
      await until(() => classicFallback && messages.some(message => "verb" in message && message.verb === "x") && session.snapshot().surfaces.length === 0, "unconfirmed semantic screen did not fall back to classic rows");
    } else await until(() => session.availability().available, "composer did not become ready");
    if (name === "model-switch" || compactSwitch) {
      const target = find(node => node.p?.role === TSP_ROLES.composerModel)!;
      send({ ev: "action", sf: target.surface.open.id, id: target.node.id, act: TSP_ACTIONS.model });
      await until(() => !!find(node => node.k === "picker" && !!node.p?.items?.some(item => item.id === "fixture/fixture-small")), "session model picker did not open");
      const picker = find(node => node.k === "picker" && !!node.p?.items?.some(item => item.id === "fixture/fixture-small"))!;
      send({ ev: "activate", sf: picker.surface.open.id, id: picker.node.id, item: "fixture/fixture-small" });
      if (compactSwitch) {
        await until(() => provider!.requests.length > 0 || !!find(node => node.p?.role === TSP_ROLES.compaction), "model switch compaction did not start");
        await until(() => provider!.requests.length > 0, "compaction provider request missing");
        if (name.endsWith("-error")) await until(() => !!find(node => node.p?.role === TSP_ROLES.noticeError), "compaction error missing");
        else await until(() => !!find(node => node.k === "toast" && node.p?.text?.includes("Session-only model: fixture/fixture-small") === true), "compacted model switch did not complete");
      }
      await until(() => session.availability().available && !find(node => node.id === picker.node.id), "model switch did not restore composer");
    }
    if (name === "thinking-cycle") {
      const level = () => {
        const target = find(node => node.k === "effort")?.node;
        return target?.k === "effort" ? target : undefined;
      };
      const start = level();
      if (!start || start.k !== "effort") throw new Error("Missing thinking effort");
      const initial = start.p?.level;
      for (let step = 0; step < 10; step++) {
        const before = level();
        const target = find(node => node.p?.actions?.click === TSP_ACTIONS.thinkingCycle)!;
        send({ ev: "action", sf: target.surface.open.id, id: target.node.id, act: TSP_ACTIONS.thinkingCycle });
        await until(() => level()?.p?.level !== before?.p?.level, "thinking effort did not change");
        if (level()?.p?.level === initial) break;
        if (step === 9) throw new Error("Thinking cycle did not wrap");
      }
    }
    if (name === "sibling-continuation") {
      const ownerSession = new TspSession({ cols: 110, dark: false, reduceMotion: true, write: data => owner!.write(data) });
      const ownerStream = new TspStream({ onMessage: message => ownerSession.receive(message), onData: data => {
        if (data.includes(Buffer.from("\x1b[c"))) ownerSession.terminalReply("\x1b[?62;22c");
        if (data.includes(Buffer.from("\x1b[6n"))) ownerSession.terminalReply("\x1b[1;1R");
      } });
      owner = spawn(bin, args, { name: "xterm-256color", cols: 110, rows: 32, cwd: root, env: { ...env, PI_TUI_TSP_RECORD: join(root, "owner-journal.jsonl") }, encoding: null });
      owner.onData(data => ownerStream.push(typeof data === "string" ? Buffer.from(data) : data));
      const stopped = Promise.withResolvers<void>();
      ownerExit = stopped.promise;
      owner.onExit(() => stopped.resolve());
      await until(() => ownerSession.availability().available, "competing owner did not start");
      await ownerSession.submit("/rename Fixture owner claim");
      await until(async () => (await readFile(join(root, "tree-session.jsonl"), "utf8")).includes("Fixture owner claim"), "competing owner did not persist its title");
    }
    if (command) {
      const before = messages.length;
      await session.submit(command);
      await until(() => messages.length > before, `${command} did not produce a semantic response`);
      if (hook === "rows") {
        await until(() => !!find(node => node.k === "rows" && JSON.stringify(node.p).includes("Fixture custom rows")), "custom rows did not open");
      } else if (hook) {
        await until(() => !!dialog(), "hook dialog did not open");
        // ui.input's second argument is a placeholder. Seed a visible default via
        // the same recorded edit path; never mislabel the placeholder as a value.
        if (hook === "input") await edit("Fixture default value");
      } else {
        await sleep(650);
        if (name === "restart") await until(() => session.snapshot().epoch >= 2 && session.availability().available, "restart did not negotiate a replacement screen");
        if (name === "new" || name === "resume") await until(() => session.availability().available, "session transition did not restore composer");
        if (name === "tree-open" || name === "tree-confirm") await until(() => !!find(node => node.k === "tree" || (node.k === "picker" && node.p?.layout === "tree")), "tree did not open");
      }
      if (end !== "open" && hook) {
        if (hook === "rows") keys(end === "cancel" ? "\x1b" : "\r");
        else if (end === "cancel") action("cancel");
        else if (hook === "select" || hook === "confirm") {
          const target = dialog()!;
          const list = [...walkNodes(target.node)].find(node => node.k === "list" || node.k === "picker");
          const index = hook === "confirm" ? 0 : 1;
          const item = list?.k === "picker" ? list.p?.items?.[index] : list?.c?.filter(node => node.k === "item")[index];
          if (!list || !item) throw new Error(`${name}: missing choice`);
          send({ ev: "activate", sf: target.surface.open.id, id: list.id, item: item.id });
        } else {
          await edit(hook === "input" ? "Recorded fixture answer" : "Updated fixture line\nSecond edited line\nThird edited line");
          action("submit");
        }
        await until(() => !!find(node => node.k === "toast" && JSON.stringify(node.p).includes(`Fixture ${hook} answer:`)), "answer notice did not appear");
        await until(() => session.availability().available, "hook did not restore composer");
      } else if (name === "tree-confirm") {
        const target = find(node => node.k === "picker" && node.p?.layout === "tree");
        if (!target || target.node.k !== "picker" || !target.node.p?.selected) throw new Error("Missing selected tree entry");
        send({ ev: "activate", sf: target.surface.open.id, id: target.node.id, item: target.node.p.selected });
        await until(() => session.availability().available, "tree confirmation did not restore composer");
      } else if (name === "extensions") {
        const target = find(node => node.k === "picker");
        if (!target || target.node.k !== "picker" || !target.node.p?.items?.length) throw new Error("Missing extension picker");
        send({ ev: "select", sf: target.surface.open.id, id: target.node.id, item: target.node.p.items[0]!.id });
        await sleep(100);
        send({ ev: "action", sf: target.surface.open.id, id: target.node.id, act: "close" });
        await until(() => session.availability().available, "extension close did not restore composer");
      } else if (end !== "open" && (openOverlay(session.snapshot().surfaces) || screenSurface(session.snapshot().surfaces))) {
        keys("\x1b");
        await until(() => session.availability().available, "Escape did not restore composer");
      }
    }
    if (end === "open") {
      await session.drain();
      await sleep(100);
      child.kill();
      await until(() => exited, "open capture did not stop");
    } else if (!missingResume) {
      await session.submit("/exit");
      await until(() => exited, "exit did not finish");
    }
    stream.end(); await session.drain();
    const safeRaw = sanitizeFixtureBytes(Buffer.concat(raw));
    const safeMessages: object[] = [];
    const safeStream = new TspStream({ onData: () => {}, onMessage: message => safeMessages.push({ verb: message.verb, body: JSON.parse(message.body) }) });
    safeStream.push(safeRaw); safeStream.end();
    await Promise.all([
      writeFile(join(destination, `${name}.raw.bin`), safeRaw),
      writeFile(join(destination, `${name}.integrity.json`), JSON.stringify({ bytes: safeRaw.length, carriageReturns: safeRaw.filter(byte => byte === 13).length, sha256: createHash("sha256").update(safeRaw).digest("hex") }) + "\n"),
      writeFile(join(destination, `${name}.events.jsonl`), sanitizeFixtureBytes(Buffer.from(events.map(event => JSON.stringify(event)).join("\n") + "\n"))),
      writeFile(join(destination, `${name}.messages.jsonl`), safeMessages.map(message => JSON.stringify(message)).join("\n") + "\n"),
      readFile(journal).then(bytes => writeFile(join(destination, `${name}.jsonl`), sanitizeFixtureBytes(bytes))),
    ]);
    if (provider) await writeFile(join(destination, `${name}.provider.json`), sanitizeFixtureBytes(Buffer.from(JSON.stringify(provider.requests, null, 2) + "\n")));
    console.log(`Recorded ${name}: ${Buffer.concat(raw).length} bytes, ${events.length} emitted events.`);
  } finally {
    if (!exited) child.kill();
    provider?.stop();
    if (owner) { owner.kill(); await ownerExit; }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
