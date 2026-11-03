import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn, type IPty } from "node-pty";
import { parse } from "yaml";
import type { TspEvent, TspNode } from "../../../shared/tsp";
import { openOverlay, screenSurface, walkNodes } from "../../../shared/tsp/view-state";
import { TSP_ACTIONS, TSP_ROLES } from "../../../shared/tsp/roles";
import { TspSession } from "./session";
import { TspStream } from "./stream";
import { encodeTspJson } from "./encode";
import type { TspSurfaceSnapshot } from "../../../shared/tsp-host";
import { sanitizeFixtureBytes } from "./sanitize-fixture";
import { parseOmpDialog, type OmpDialog } from "../../../renderer/src/features/session-tools/ompDialog";
import { planReview, planChoice } from "../../../shared/tsp/plan-review";
import { composerFacts as readComposerFacts } from "./composer";
import { LoopbackRelay } from "../relay";
import { GuestClient } from "../../../renderer/src/collab/lib/client";
import { recordingDestination } from "./recording-destination";

// Bundle beside node_modules for Node, with node-pty external and the app's wire aliases.
// No inherited configuration or provider credentials. Model turns use the isolated scripted provider.
const bin = process.env.OMP_BIN;
if (!bin) throw new Error("Set OMP_BIN to the omp executable.");
if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Fixture recording is supported only on macOS and Linux.");
const versionRoot = await mkdtemp(join(tmpdir(), "vomp-tsp-version-"));
let version: string;
try {
  version = execFileSync(bin, ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH!, HOME: versionRoot, USERPROFILE: versionRoot, XDG_CONFIG_HOME: versionRoot, XDG_CACHE_HOME: versionRoot, PI_CODING_AGENT_DIR: versionRoot, PI_CONFIG_DIR: versionRoot, TMPDIR: versionRoot } }).trim();
} finally {
  await rm(versionRoot, { recursive: true, force: true });
}
const expectedVersion = process.env.VOMP_TSP_FIXTURE_VERSION ?? "18.15.0";
if (version !== `omp/${expectedVersion}`) throw new Error(`Expected omp/${expectedVersion}; received ${version}.`);
const destination = await recordingDestination(expectedVersion, process.env.VOMP_TSP_FIXTURE_DIR);
const extension = resolve("src/main/omp/tsp/fixtures/extension/vomp-fixture.mjs");
await mkdir(destination, { recursive: true });
const config = "startup:\n  setupWizard: false\n  checkUpdate: false\n  changelogMode: hidden\n  quiet: true\nmarketplace:\n  autoUpdate: off\nworktree:\n  onStart: off\n  onExit: keep\ntui:\n  autoGraph: never\nautocomplete:\n  enabled: false\nrecap:\n  enabled: false\ncomposer:\n  predictions: false\n";
type ScriptedReply = { text?: string; tool?: { name: string; arguments: object }; delayMs?: number; gate?: string; error?: string };
type RecordingContext = {
  session: TspSession;
  send: (event: TspEvent) => void;
  keys: (data: string) => void;
  until: (predicate: () => boolean | Promise<boolean>, label: string) => Promise<void>;
  find: (predicate: (node: TspNode) => boolean) => { surface: TspSurfaceSnapshot; node: TspNode } | undefined;
  release: (gate: string) => void;
  requests: object[];
  root: string;
};
type Scenario = {
  name: string; command: string | null; hook?: "select" | "input" | "editor" | "confirm" | "rows";
  end?: "open" | "submit" | "cancel";
  script?: ScriptedReply[];
  parity?: OmpDialog;
  config?: Record<string, unknown>;
  tools?: string[];
  collab?: boolean;
  run?: (context: RecordingContext) => Promise<void>;
};

/** Shared loopback provider; optional models support session-switch compaction probes. */
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

const worktreeQuestion = (session: TspSession, title: string) => {
  for (const surface of session.snapshot().surfaces) {
    if (surface.closed) continue;
    for (const node of walkNodes(surface.document)) {
      if (node.k === "picker" && node.p?.title === title) return { surface, node };
    }
  }
  return undefined;
};

const scratchGit = (root: string, args: string[]) => execFileSync("git", args, {
  cwd: root, encoding: "utf8",
  env: { PATH: process.env.PATH!, HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "home", ".config"), GIT_CONFIG_NOSYSTEM: "1" },
});
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
  { name: "worktree-start-ask", command: null, end: "open", config: { worktree: { onStart: "ask", onExit: "keep" } } },
  ...(["keep", "remove"] as const).map(choice => ({
    name: choice === "keep" ? "worktree-exit-ask" : "worktree-exit-ask-remove", command: null,
    config: { worktree: { onStart: "off", onExit: "ask" } },
    run: async ({ session, send, until, root }: RecordingContext) => {
      await session.submit("/wt fixture");
      await until(() => session.availability().available && scratchGit(root, ["worktree", "list", "--porcelain"]).includes("wt/fixture"), "worktree was not created");
      const worktrees = scratchGit(root, ["worktree", "list", "--porcelain"]);
      const folder = worktrees.split("\n").find(line => line.startsWith("worktree ") && line.slice(9) !== root)?.slice(9);
      if (!folder) throw new Error("Missing owned fixture worktree");
      await writeFile(join(folder, "fixture.txt"), "Uncommitted fixture changes.\n");
      await session.submit("/exit");
      await until(() => !!worktreeQuestion(session, "Remove worktree?"), "exit question did not open");
      const question = worktreeQuestion(session, "Remove worktree?")!;
      const item = question.node.p?.items?.find(item => item.label === (choice === "remove" ? "Yes" : "No"));
      if (!item) throw new Error("Missing worktree choice");
      send({ ev: "activate", sf: question.surface.open.id, id: question.node.id, item: item.id });
    },
  })),
  { name: "model-switch", command: null },
  { name: "thinking-cycle", command: null },
  { name: "switch-typed", command: "/switch fixture/fixture-small" },
  { name: "model-switch-compact", command: null, script: Array.from({ length: 16 }, () => ({ text: "## Summary\nThe fixture conversation contains repeated context paragraphs. Preserve the numbered fixture segments and continue the local model-switch test.", delayMs: 1000 })) },
  { name: "model-switch-compact-error", command: null, script: Array.from({ length: 16 }, () => ({ error: "Fixture compaction request failed", delayMs: 1000 })) },
  ...[
    ["rename", "/rename Fixture command feedback"],
    ["export", "/export"],
    ["cleanse", "/cleanse"],
    ["jobs-kill", "/jobs kill fixture-missing-job"],
  ].map(([name, command]) => ({
    name: name!, command: command!, end: "open" as const,
    ...(name === "cleanse" ? { run: async ({ keys, until, session }: RecordingContext) => {
      keys("\x1b");
      await until(() => session.availability().available, "cleanse cancellation did not restore the composer");
    } } : {}),
  })),
  { name: "jobs-kill-running", command: "Start a local fixture background job.", end: "open", tools: ["bash"],
    config: { async: { enabled: true } },
    script: [
      { tool: { name: "bash", arguments: { command: "sleep 30", async: true, timeout: 60 } } },
      { text: "Fixture background job started." },
    ],
    run: async ({ session, until, find }: RecordingContext) => {
      await until(() => !!find(node => node.k === "md" && node.p?.text === "Fixture background job started.") && session.availability().available, "background job did not start");
      await session.submit("/jobs kill all");
      await until(() => !!find(node => node.k === "toast" && /Cancelled 1 background job/.test(node.p?.text ?? "")), "running job cancellation feedback missing");
    },
  },
  { name: "handoff", command: "/handoff Preserve the fixture context", end: "open",
    script: Array.from({ length: 16 }, () => ({ text: "## Handoff\nPreserve the numbered fixture context segments.", delayMs: 100 })),
    run: async ({ until, find }: RecordingContext) => {
      await until(() => !!find(node => node.p?.role === TSP_ROLES.compaction || node.p?.role === TSP_ROLES.noticeError || node.k === "toast" && /handoff/i.test(node.p?.text ?? "")), "handoff outcome missing");
    },
  },
  ...(["compact-ok", "compact-error"] as const).map(name => ({
    name, command: "/compact soft", end: "open" as const,
    script: Array.from({ length: 16 }, () => name === "compact-error"
      ? { error: "Fixture compaction request failed", delayMs: 100 }
      : { text: "## Summary\nPreserve the numbered fixture context segments.", delayMs: 100 }),
    run: async ({ until, find }: RecordingContext) => {
      await until(() => !!find(node => node.p?.role === (name === "compact-error" ? TSP_ROLES.noticeError : TSP_ROLES.compaction)), "command compaction outcome missing");
    },
  })),
  ...(["execute", "compact", "keep", "refine", "discard", "save"] as const).map(choice => ({
    name: `plan-review-${choice}`, command: "/plan Draft a fixture plan", end: "open" as const, tools: ["write", "read"],
    script: [
      { tool: { name: "write", arguments: { path: "local://fixture-plan.md", content: "# Fixture plan\n\n## Implementation\n\n- [ ] Add the requested behavior.\n- [ ] Cover the consumer-visible result.\n\n## Validation\n\nRun the focused checks.\n" } } },
      { tool: { name: "write", arguments: { path: "xd://propose", content: "fixture" } } },
      ...Array.from({ length: 8 }, () => ({ text: "Fixture work completed." })),
    ],
    run: async ({ session, send, until, find }: RecordingContext) => {
      await until(() => !!planReview(session.snapshot().surfaces), "plan review did not open");
      const review = planReview(session.snapshot().surfaces)!;
      if (choice === "discard") {
        if (!review.cancelId) throw new Error("Plan review did not expose Cancel");
        send({ ev: "action", sf: review.sf, id: review.cancelId, act: "cancel" });
      } else send(planChoice(review, choice));
      await until(() => !planReview(session.snapshot().surfaces), "plan choice did not dismiss review");
      if (choice === "refine") {
        await until(() => session.availability().available, "refinement editor did not return");
        await session.submit("Refine the plan: include the empty state.");
        await until(() => !!find(node => node.k === "md" && node.p?.text?.includes("Fixture work completed.") === true), "refinement response did not arrive");
      }
      if (choice === "save") {
        await until(() => !!find(node => node.p?.role === TSP_ROLES.planSave), "save path dialog did not open");
        const save = find(node => node.p?.actions?.click === "save")!;
        send({ ev: "action", sf: save.surface.open.id, id: save.node.id, act: "save" });
        await until(() => !find(node => node.p?.role === TSP_ROLES.planSave) && session.availability().available, "plan save did not finish");
      }
    },
  })),
  { name: "shell-bang", command: "!printf fixture-shell", script: [], run: async ({ find, until, session }) => {
    await until(() => !!find(node => node.p?.role === "omp.bash"), "shell result missing");
    await session.submit("!!printf fixture-shell-excluded");
    await until(() => !!find(node => node.k === "tool" && node.p?.role === "omp.bash" && node.p.command === "printf fixture-shell-excluded" && node.p.status === "done"), "excluded shell result missing");
  } },
  { name: "python-dollar", command: "$ 1+1", script: [], run: async ({ find, until }) => {
    await until(() => !!find(node => node.p?.role === "omp.eval"), "Python result missing");
  } },
  { name: "paste-large", command: null, script: [{ text: "Fixture large paste received." }], run: async ({ session, until, requests }) => {
    await session.submit("Fixture large paste line.\n".repeat(5000));
    await until(() => requests.length === 1, "large paste missing from provider");
  } },
  ...(["send-busy-steer", "follow-up-queue", "queue-escape-restore"] as const).map(name => ({
    name, command: "Fixture initial prompt",
    script: [{ text: "Fixture first response.", gate: "first" }, { text: "Fixture queued response." }],
    run: async ({ session, until, find, release, requests, keys }: RecordingContext) => {
      await until(() => requests.length === 1, "initial request missing");
      if (name === "send-busy-steer") await session.submit("Fixture busy steer");
      else {
        await session.followUp("Fixture follow-up text", () => {});
        await until(() => !!find(node => node.p?.role === TSP_ROLES.queueItem), "follow-up queue missing");
      }
      if (name === "queue-escape-restore") {
        keys("\x1b");
        await until(() => !!find(node => node.k === "editor" && node.p?.text?.includes("Fixture follow-up text") === true), "Escape did not restore queued text");
        const facts = readComposerFacts(session.snapshot().surfaces);
        await session.editAndKeys(0, facts.text.length, "", 0, "", () => {});
        await until(() => readComposerFacts(session.snapshot().surfaces).text === "", "restored editor did not clear");
      }
      release("first");
      if (name !== "queue-escape-restore") await until(() => requests.length >= 2, "queued message was not delivered");
      await until(() => !find(node => node.p?.role === "omp.working"), "turn did not finish");
    },
  })),
  { name: "image-attach", command: null, collab: true, script: [{ text: "Fixture image received." }], run: async ({ session, root, requests, until }) => {
    const path = join(root, "fixture.png");
    await writeFile(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=", "base64"));
    await session.submitImages("Fixture image prompt", path, () => {});
    await until(() => requests.length === 1, "image prompt missing from provider");
  } },
  { name: "approval-send-denies", command: "Fixture approval prompt", script: [
    { tool: { name: "bash", arguments: { command: "printf fixture-approval", i: "Printing fixture output" } } },
    { text: "Fixture approval denied and message received." },
  ], config: { tools: { approvalMode: "always-ask" } }, tools: ["bash"], run: async ({ session, find, until, requests }) => {
    await until(() => !!find(node => node.p?.role === TSP_ROLES.approvalChoices), "approval missing");
    await session.submit("Fixture deny and steer");
    await until(() => requests.length >= 2 && !find(node => node.p?.role === TSP_ROLES.approvalChoices), "approval was not denied");
  } },
  { name: "ask-replaces-editor", command: "Fixture ask prompt", end: "open", tools: ["ask"], script: [{
    tool: { name: "ask", arguments: { i: "Choosing fixture storage", questions: [{ id: "fixture-ask", question: "Fixture storage?", options: [{ label: "SQLite" }, { label: "Postgres" }] }] } },
  }], run: async ({ find, until }) => {
    await until(() => !!find(node => node.p?.role === TSP_ROLES.editorAsk || node.p?.role === TSP_ROLES.editorAskHidden), "ask did not replace the editor");
  } },
  { name: "paste-follow-up", command: "Fixture initial prompt", script: [
    { text: "Fixture first response.", gate: "first" }, { text: "Fixture pasted follow-up received." },
  ], run: async ({ session, root, requests, until, release, find }) => {
    await until(() => requests.length === 1, "initial request missing");
    const path = join(root, "fixture.png");
    await writeFile(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=", "base64"));
    await session.paste(path, () => {}, () => true);
    await session.followUp("Fixture follow-up text", () => {});
    await until(() => !!find(node => node.p?.role === TSP_ROLES.queueItem), "pasted follow-up queue missing");
    release("first");
    await until(() => requests.length >= 2, "pasted follow-up was not delivered");
    if (!JSON.stringify(requests[1]).includes('"image_url"')) throw new Error("Pasted image missing from the follow-up provider request");
    await until(() => !find(node => node.p?.role === TSP_ROLES.working), "pasted follow-up did not finish");
  } },
  { name: "prediction-ghost", command: "Fixture prediction prompt", script: [
    { text: "Fixture prediction answer." }, { text: "Run the fixture tests" },
  ], config: { composer: { predictions: true } }, run: async ({ session, until, keys }) => {
    await until(() => readComposerFacts(session.snapshot().surfaces).ghost === "Run the fixture tests", "prediction ghost missing");
    keys("\t");
    await until(() => readComposerFacts(session.snapshot().surfaces).text === "Run the fixture tests", "Tab did not accept prediction");
    const facts = readComposerFacts(session.snapshot().surfaces);
    await session.editAndKeys(0, facts.text.length, "", 0, "", () => {});
    await until(() => readComposerFacts(session.snapshot().surfaces).text === "", "accepted prediction did not clear");
  } },
];
// Each positive classic capture has an independently recorded native counterpart.
for (const name of ["selector-descriptions", "selector-descriptions-moved", "selector-windowed", "selector-search", "selector-outline", "confirm", "confirm-detail", "confirm-detail-no", "input-below-panel", "input-empty", "editor-prompt", "editor-hook", "editor-hook-empty"]) {
  const text = await readFile(resolve(`src/renderer/src/features/session-tools/fixtures/omp-dialogs/${name}.txt`), "utf8");
  const parity = parseOmpDialog(text.split("\n"));
  if (!parity) throw new Error(`Unrecognized classic parity capture: ${name}`);
  if (parity.kind === "select" && parity.hidden) {
    // The classic capture documents all 20 regions; only its painted window/filter is incomplete.
    parity.options = Array.from({ length: 20 }, (_, i) => ({ label: `Region ${i + 1}`, description: null }));
    parity.selected = 0;
  }
  scenarios.push({ name: `hook-parity-${name}`, command: `/vomp-fixture-parity ${JSON.stringify({ ...parity, outline: name === "selector-outline" })}`, hook: parity.kind === "select" ? parity.confirm ? "confirm" : "select" : parity.kind, end: "submit", parity });
}
for (const scenario of scenarios) {
  const { name, hook, end } = scenario;
  let command = scenario.command;
  if (process.argv.length > 2 && !process.argv.slice(2).includes(name)) continue;
  // Fixed POSIX root keeps recorded paths within the sanitizer's documented policy.
  const root = await mkdtemp(join("/tmp", "vomp-tsp-record-"));
  const home = join(root, "home"); const agent = join(root, "agent");
  await Promise.all([mkdir(home), mkdir(agent)]);
  const compactSwitch = name.startsWith("model-switch-compact");
  const compactCommand = name === "compact-ok" || name === "compact-error";
  const modelControls = ["model-switch", "thinking-cycle", "switch-typed"].includes(name) || compactSwitch;
  const controlModels = ["large", "small"].map(size => ({ id: `fixture-${size}`, name: `Fixture ${size}`, reasoning: true,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: size === "large" ? 128000 : 32000, maxTokens: 4096 }));
  const provider = scenario.script ? await scriptedProvider(scenario.script, agent, modelControls ? controlModels : undefined) : undefined;
  const relay = scenario.collab ? new LoopbackRelay() : undefined;
  if (relay) await relay.start();
  let guest: GuestClient | undefined;
  await writeFile(join(agent, "config.yml"), provider ? JSON.stringify({
    setupVersion: 999, startup: { setupWizard: false, checkUpdate: false, changelogMode: "hidden", quiet: true },
    marketplace: { autoUpdate: "off" }, worktree: { onStart: "off", onExit: "keep" },
    tui: { autoGraph: "never" }, autocomplete: { enabled: false }, recap: { enabled: false },
    composer: { predictions: false }, modelRoles: { default: modelControls ? "fixture/fixture-large" : "fixture/fixture-model", smol: modelControls ? "fixture/fixture-small" : "fixture/fixture-model" },
    tools: { approvalMode: "yolo" }, memory: { enabled: false }, idle: { enabled: false }, ...scenario.config,
    ...(compactSwitch || compactCommand ? { compaction: { asyncEnabled: false, keepRecentTokens: 4096 } } : {}),
    ...(relay ? { collab: { autoStart: "control", relayUrl: relay.url, displayName: "Fixture recorder" } } : {}),
  }) : JSON.stringify({ ...parse(config), ...scenario.config }));
  if (modelControls && !provider) {
    await writeFile(join(agent, "models.yml"), JSON.stringify({ providers: { fixture: {
      baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-local-only", api: "openai-completions", models: controlModels,
    } } }));
  }
  if (name.startsWith("worktree-")) {
    scratchGit(root, ["init", "--initial-branch=main", root]);
    await writeFile(join(root, "fixture.txt"), "Committed fixture content.\n");
    scratchGit(root, ["add", "fixture.txt"]);
    scratchGit(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Fixture root"]);
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
  const output = new TspStream({ onData: data => events.push({ keys: data.toString("utf8"), afterMessage: messages.length }), onMessage: message => events.push({ verb: message.verb, body: JSON.parse(message.body), afterMessage: messages.length }) });
  const write = (data: string) => { if (name === "handshake-timeout") return; output.push(Buffer.from(data)); child.write(data); };
  const keys = (data: string) => { events.push({ keys: data, afterMessage: messages.length }); child.write(data); };
  // A transport probe deliberately sends the observed hook wire events directly.
  // Production input authority belongs to SessionHost, rather than this isolated recorder.
  const send = (event: TspEvent) => write(encodeTspJson("e", event));
  const session = new TspSession({ cols: 110, dark: false, reduceMotion: true, write, onError: error => { throw error; } });
  const stream = new TspStream({ onMessage: message => { messages.push({ verb: message.verb, body: message.verb === "b" ? message.body : JSON.parse(message.body) }); session.receive(message); }, onData: data => {
    if (data.toString().includes("No default model selected")) classicFallback = true;
    if (data.includes(Buffer.from("\x1b[c"))) session.terminalReply("\x1b[?62;22c");
    if (data.includes(Buffer.from("\x1b[6n"))) session.terminalReply("\x1b[1;1R");
  } });
  const args = ["--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--session-dir", join(root, "sessions")];
  if (modelControls) args.push("--model", "fixture/fixture-large", "--thinking", "off");
  else if (provider) args.push("--model", "fixture/fixture-model", "--thinking", "off");
  if (scenario.tools) args.push("--tools", scenario.tools.join(","));
  if (compactSwitch || compactCommand || name === "handoff") {
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
  if (provider && !modelControls) args.push("--model", "fixture/fixture-model", "--thinking", "off");
  if (scenario.tools) args.push("--tools", scenario.tools.join(","));
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
    || (node.k === "picker" && node.p?.noun === "options" && node.p.layout === "rows"));
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
    } else if (name === "worktree-start-ask") {
      await until(() => !!worktreeQuestion(session, "Create a worktree for this session?"), "startup worktree question did not open");
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
    if (relay) {
      let hosts: { instanceId: string }[] = [];
      await until(() => {
        hosts = JSON.parse(execFileSync(bin, ["collab", "list", "--json"], { env, encoding: "utf8" })).hosts;
        return hosts.length > 0;
      }, "isolated collab host missing");
      const link = JSON.parse(execFileSync(bin, ["collab", "link", hosts[0]!.instanceId, "--json"], { env, encoding: "utf8" })).url;
      guest = new GuestClient(link, "Fixture recorder");
      guest.connect();
      await until(() => guest!.getSnapshot().phase === "live", "collab replica did not connect");
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
        if (hook === "input") await edit(scenario.parity?.kind === "input" ? scenario.parity.value : "Fixture default value");
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
    if (scenario.run) await scenario.run({ session, send, keys, until, find, root, requests: provider?.requests ?? [], release: provider?.release ?? (() => {}) });
    if (guest) {
      await until(() => guest!.getSnapshot().entries.some(entry => entry.type === "message" && entry.message.role === "user" && Array.isArray(entry.message.content) && entry.message.content.some(part => part.type === "image")), "image missing from collab transcript");
      await writeFile(join(destination, `${name}.collab.json`), sanitizeFixtureBytes(Buffer.from(JSON.stringify(guest.getSnapshot().entries, null, 2) + "\n")));
    }
    if (end === "open") {
      await session.drain();
      await sleep(100);
      child.kill();
      await until(() => exited, "open capture did not stop");
    } else if (!missingResume && !name.startsWith("worktree-exit-ask")) {
      await session.submit("/exit");
      await until(() => exited, "exit did not finish");
    }
    if (name.startsWith("worktree-exit-ask")) await until(() => exited, "worktree exit did not finish");
    stream.end(); await session.drain();
    const safeRaw = sanitizeFixtureBytes(Buffer.concat(raw));
    const safeMessages: object[] = [];
    const safeStream = new TspStream({ onData: () => {}, onMessage: message => safeMessages.push({ verb: message.verb, body: message.verb === "b" ? message.body : JSON.parse(message.body) }) });
    safeStream.push(safeRaw); safeStream.end();
    await Promise.all([
      writeFile(join(destination, `${name}.raw.bin`), safeRaw),
      writeFile(join(destination, `${name}.integrity.json`), JSON.stringify({ bytes: safeRaw.length, carriageReturns: safeRaw.filter(byte => byte === 13).length, sha256: createHash("sha256").update(safeRaw).digest("hex") }) + "\n"),
      writeFile(join(destination, `${name}.events.jsonl`), sanitizeFixtureBytes(Buffer.from(events.map(event => JSON.stringify(event)).join("\n") + "\n"))),
      writeFile(join(destination, `${name}.messages.jsonl`), safeMessages.map(message => JSON.stringify(message)).join("\n") + "\n"),
      readFile(journal).then(bytes => writeFile(join(destination, `${name}.jsonl`), sanitizeFixtureBytes(bytes))),
      ...(provider ? [writeFile(join(destination, `${name}.provider.json`), sanitizeFixtureBytes(Buffer.from(JSON.stringify(provider.requests, null, 2) + "\n")))] : []),
    ]);
    console.log(`Recorded ${name}: ${Buffer.concat(raw).length} bytes, ${events.length} emitted events.`);
  } finally {
    if (!exited) child.kill();
    if (owner) { owner.kill(); await ownerExit; }
    guest?.close();
    relay?.stop();
    provider?.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
