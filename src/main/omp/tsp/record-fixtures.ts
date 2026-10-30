import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn, type IPty } from "node-pty";
import { TspSession } from "./session";
import { TspStream } from "./stream";
import { openOverlay, screenSurface } from "../../../shared/tsp/view-state";
import { sanitizeFixtureBytes } from "./sanitize-fixture";

// Bundle to /tmp with Bun (target node, node-pty external), then run with Node and OMP_BIN.
// No inherited configuration, provider credentials, extensions or model turns.
const bin = process.env.OMP_BIN;
if (!bin) throw new Error("Set OMP_BIN to the omp 18.14.0 executable.");
const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
if (version !== "omp/18.14.0") throw new Error(`Expected omp/18.14.0; received ${version}.`);
const destination = resolve("src/main/omp/tsp/fixtures/18.14.0");
await mkdir(destination, { recursive: true });
const config = "startup:\n  setupWizard: false\n  checkUpdate: false\n  changelogMode: hidden\n  quiet: true\nmarketplace:\n  autoUpdate: off\nworktree:\n  onStart: off\n  onExit: keep\ntui:\n  autoGraph: never\nautocomplete:\n  enabled: false\nrecap:\n  enabled: false\ncomposer:\n  predictions: false\n";
const scenarios = [
  ["hotkeys", "/hotkeys"], ["jobs", "/jobs"], ["usage", "/usage"], ["session", "/session"],
  ["changelog", "/changelog"], ["tools", "/tools"], ["model-picker", "/model"],
  ["settings-screen", "/settings"], ["exit", null], ["exit-with-overlay", "/hotkeys"],
] as const;
for (const [name, command] of scenarios) {
  if (process.argv.length > 2 && !process.argv.slice(2).includes(name)) continue;
  const root = await mkdtemp("/tmp/vomp-tsp-record-");
  const home = join(root, "home"); const agent = join(root, "agent");
  await Promise.all([mkdir(home), mkdir(agent)]);
  await writeFile(join(agent, "config.yml"), config);
  const journal = join(root, "journal.jsonl");
  const env = { PATH: process.env.PATH!, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), TMPDIR: root, PI_CODING_AGENT_DIR: agent, PI_CONFIG_DIR: agent, TERM_PROGRAM: "tern", TERM: "xterm-256color", COLORTERM: "truecolor", OMP_SKIP_SETUP: "1", PI_TUI_TSP_RECORD: journal };
  const raw: Buffer[] = []; const events: object[] = []; const messages: object[] = [];
  let child: IPty;
  let exited = false;
  const output = new TspStream({ onData: () => {}, onMessage: message => events.push({ verb: message.verb, body: JSON.parse(message.body) }) });
  const session = new TspSession({ cols: 110, dark: false, reduceMotion: true, write: data => { output.push(Buffer.from(data)); child.write(data); }, onError: error => { throw error; } });
  const stream = new TspStream({ onMessage: message => { messages.push({ verb: message.verb, body: JSON.parse(message.body) }); session.receive(message); }, onData: data => {
    if (data.includes(Buffer.from("\x1b[c"))) session.terminalReply("\x1b[?62;22c");
    if (data.includes(Buffer.from("\x1b[6n"))) session.terminalReply("\x1b[1;1R");
  } });
  child = spawn(bin, ["--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--session-dir", join(root, "sessions")], { name: "xterm-256color", cols: 110, rows: 32, cwd: root, env, encoding: null });
  child.onData(data => { const bytes = typeof data === "string" ? Buffer.from(data) : data; raw.push(bytes); stream.push(bytes); });
  child.onExit(() => { exited = true; });
  const until = async (predicate: () => boolean, label: string) => { const end = Date.now() + 15000; while (!predicate()) { if (exited || Date.now() > end) throw new Error(`${name}: ${label}`); await sleep(30); } };
  try {
    await until(() => session.availability().available, "composer did not become ready");
    if (command) {
      const before = messages.length;
      await session.submit(command);
      await until(() => messages.length > before, `${command} did not produce a semantic response`);
      await sleep(650);
      if (openOverlay(session.snapshot().surfaces) || screenSurface(session.snapshot().surfaces)) {
        events.push({ keys: "\u001b" }); child.write("\x1b");
        await until(() => session.availability().available, "Escape did not restore composer");
      }
    }
    await session.submit("/exit");
    await until(() => exited, "exit did not finish");
    stream.end(); await session.drain();
    const safeRaw = sanitizeFixtureBytes(Buffer.concat(raw));
    const safeMessages: object[] = [];
    const safeStream = new TspStream({ onData: () => {}, onMessage: message => safeMessages.push({ verb: message.verb, body: JSON.parse(message.body) }) });
    safeStream.push(safeRaw); safeStream.end();
    await Promise.all([
      writeFile(join(destination, `${name}.raw.bin`), safeRaw),
      writeFile(join(destination, `${name}.events.jsonl`), sanitizeFixtureBytes(Buffer.from(events.map(event => JSON.stringify(event)).join("\n") + "\n"))),
      writeFile(join(destination, `${name}.messages.jsonl`), safeMessages.map(message => JSON.stringify(message)).join("\n") + "\n"),
      readFile(journal).then(bytes => writeFile(join(destination, `${name}.jsonl`), sanitizeFixtureBytes(bytes))),
    ]);
    console.log(`Recorded ${name}: ${Buffer.concat(raw).length} bytes, ${events.length} emitted events.`);
  } finally { if (!exited) child.kill(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}
