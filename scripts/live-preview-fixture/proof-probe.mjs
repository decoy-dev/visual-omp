import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parse } from "@babel/parser";
import { fixtureEnvironment } from "./environment.mjs";
import { startFixture } from "./server.mjs";

// Extract the shipped skill verbatim, without importing Electron's main-process dependencies.
const source = await readFile(new URL("../../src/main/services/visual-proofs.ts", import.meta.url), "utf8");
const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
const declaration = ast.program.body.flatMap(node => (node.declaration ?? node).declarations ?? []).find(node => node.id.name === "VISUAL_PROOFS_SKILL");
assert.equal(declaration?.init.type, "TemplateLiteral");
assert.equal(declaration.init.expressions.length, 0);
const skill = declaration.init.quasis[0].value.cooked;
const root = await mkdtemp(join(tmpdir(), "vomp-proof-probe-"));
const fixture = await startFixture({ root, port: 0, durationMs: 0 });
const env = fixtureEnvironment(root);
const binary = process.env.OMP_FIXTURE_BINARY || "omp";
const exists = file => stat(file).then(info => info.size > 0).catch(error => { if (error.code === "ENOENT") return false; throw error; });

async function scenario(answer) {
  const cwd = join(root, answer.toLowerCase());
  await mkdir(cwd);
  const child = spawn(binary, ["--mode", "rpc-ui", "--no-ui", "--no-extensions", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--no-pty", "--tools", "bash,ask", "--model", "fixture/preview", "--thinking", "off", "--auto-approve"], { cwd, env, stdio: "pipe" });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  const lines = createInterface({ input: child.stdout });
  const tools = [];
  const eventTypes = [];
  let stderr = "";
  let question = null;
  let proofAtQuestion = false;
  let noRenderAtQuestion = false;
  let timer;
  let answerTimer;
  child.stderr.on("data", data => { stderr += String(data); });
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${eventTypes.slice(-10).join(", ")}. ${stderr}`)), 45000);
      child.once("error", reject);
      child.once("exit", (code, signal) => reject(new Error(`omp exited before agent_end (${code}, ${signal}): ${stderr}`)));
      lines.on("line", line => {
        void (async () => {
          const event = JSON.parse(line);
          eventTypes.push(event.type);
          if (event.type === "ready") child.stdin.write(JSON.stringify({ id: "prompt", type: "prompt", message: "fixture proof" }) + "\n");
          if (event.type === "tool_execution_start") tools.push(event.toolName);
          if (event.type === "tool_execution_end" && event.isError) throw new Error(JSON.stringify(event.result));
          if (event.type === "extension_ui_request" && event.method === "select") {
            question = { title: event.title, options: event.options };
            proofAtQuestion = await exists(join(cwd, "proofs", "frame-1.png"));
            noRenderAtQuestion = !await exists(join(cwd, "out.mp4"));
            // Keep the question open long enough to check that the render remains absent.
            answerTimer = setTimeout(() => {
              void exists(join(cwd, "out.mp4")).then(rendered => {
                assert.equal(rendered, false);
                child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: event.id, value: answer }) + "\n");
              }).catch(reject);
            }, 1000);
          }
          if (event.type === "agent_end") resolve();
        })().catch(reject);
      });
    });
    const rendered = await exists(join(cwd, "out.mp4"));
    assert.ok(question?.title.includes("The proof is ready. Continue with the full render?"));
    assert.equal(proofAtQuestion, true);
    assert.equal(noRenderAtQuestion, true);
    assert.equal(rendered, answer === "Yes");
    assert.deepEqual(tools, answer === "Yes" ? ["bash", "ask", "bash"] : ["bash", "ask"]);
    return { answer, question, proofAtQuestion, noRenderAtQuestion, rendered, tools };
  } finally {
    clearTimeout(timer);
    clearTimeout(answerTimer);
    child.stdin.end();
    const kill = setTimeout(() => child.kill("SIGTERM"), 2000);
    await exited;
    clearTimeout(kill);
    lines.close();
  }
}

try {
  const skillPath = join(env.PI_CODING_AGENT_DIR, "skills", "visual-proofs", "SKILL.md");
  await mkdir(join(env.PI_CODING_AGENT_DIR, "skills", "visual-proofs"), { recursive: true });
  await readFile(skillPath).then(() => { throw new Error("Scratch skill unexpectedly exists"); }, error => { if (error.code !== "ENOENT") throw error; });
  await writeFile(skillPath, skill);
  const run = args => execFileSync(binary, args, { cwd: join(root, "work"), env, encoding: "utf8" });
  const version = run(["--version"]).trim();
  assert.equal(run(["config", "path"]).trim(), env.PI_CODING_AGENT_DIR);
  const listing = JSON.parse(run(["skill", "list", join(root, "work"), "--json"]));
  assert.ok(listing.skills.some(entry => entry.name === "visual-proofs" && entry.filePath === skillPath && entry.source === "native:user"));
  assert.deepEqual(listing.warnings, []);
  const scenarios = [await scenario("No"), await scenario("Yes")];
  console.log(JSON.stringify({ version, agentDirectoryHonored: true, nativeSkillListed: true, warnings: listing.warnings, scenarios }, null, 2));
} finally {
  await fixture.close();
  await rm(root, { recursive: true, force: true });
}
