import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectIsolationEvidence, InspectorConnection, isolationVerdict } from "./isolation-evidence.mjs";
import { isolationHtml } from "./isolation-page.mjs";
import { startFixture } from "./server.mjs";
import { initializeFixture } from "./environment.mjs";

function passing() {
  return { environment: { packaged: true }, frame: { osProcessId: 22 }, appFrame: { osProcessId: 11 },
    document: { origin: "null", sandbox: "allow-scripts", networkOff: true }, busyStarted: true,
    echo: { durationMs: 10000, samples: Array.from({ length: 50 }, () => ({ ok: true, insertTextToValueMs: 10 })) },
    stageClose: { passed: true }, idle: { passed: true } };
}
test("requires the complete packaged isolation and responsiveness evidence", () => {
  assert.equal(isolationVerdict(passing()), true);
  const fail = mutate => { const report = passing(); mutate(report); assert.equal(isolationVerdict(report), false); };
  fail(report => { report.environment.packaged = false; });
  fail(report => { report.frame.osProcessId = 11; });
  fail(report => { report.frame.osProcessId = 0; });
  fail(report => { report.document.origin = "vomp-preview://fixture"; });
  fail(report => { report.document.sandbox = "allow-scripts allow-same-origin"; });
  fail(report => { report.document.networkOff = false; });
  fail(report => { report.busyStarted = false; });
  fail(report => { report.echo.durationMs = 9999; });
  fail(report => { report.echo.samples.length = 39; });
  fail(report => { report.echo.samples[0].insertTextToValueMs = 101; });
  fail(report => { report.echo.samples[0].ok = false; });
  fail(report => { report.stageClose.passed = false; });
  fail(report => { report.idle.passed = false; });
  fail(report => { report.error = "partial run"; });
});

class FakeSocket extends EventTarget {
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  reply(value) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
  close() { this.dispatchEvent(new Event("close")); }
}
test("routes flattened CDP sessions and preserves protocol errors", async () => {
  const socket = new FakeSocket();
  const connection = new InspectorConnection(socket);
  const events = [];
  connection.listeners.add(event => events.push(event));
  const command = connection.call("Input.insertText", { text: "a" }, "app");
  assert.deepEqual(socket.sent[0], { id: 1, method: "Input.insertText", params: { text: "a" }, sessionId: "app" });
  socket.reply({ method: "Runtime.consoleAPICalled", params: {}, sessionId: "preview" });
  socket.reply({ id: 1, result: {} });
  assert.deepEqual(await command, {});
  assert.equal(events[0].sessionId, "preview");
  const failure = connection.call("Runtime.evaluate");
  socket.reply({ id: 2, error: { message: "renderer stopped" } });
  await assert.rejects(failure, /renderer stopped/);
  connection.close();
});
test("bounds unresponsive commands and ignores their late replies", async () => {
  const socket = new FakeSocket();
  const connection = new InspectorConnection(socket);
  await assert.rejects(connection.call("Runtime.evaluate", {}, undefined, 5), /timed out/);
  socket.reply({ id: 1, result: { result: { value: "late" } } });
  const command = connection.call("Page.getFrameTree");
  socket.close();
  await assert.rejects(command, /disconnected/);
  assert.equal(connection.pending.size, 0);
});
test("reports fixture script readiness and busy start without network inputs", () => {
  const html = isolationHtml();
  assert.match(html, /self\.origin/);
  assert.match(html, /VOMP_ISOLATION_BUSY_STARTED/);
  assert.match(html, /while \(true\) \{\}/);
  assert.match(html, /setTimeout/);
  assert.doesNotMatch(html, /https?:|fetch\(|WebSocket|postMessage/);
});
test("serves fixture isolation as one saved HTML write followed by a completed turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "vomp-isolation-provider-"));
  const server = await startFixture({ root, port: 0 });
  try {
    const request = async messages => {
      const response = await fetch(`${server.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages }) });
      assert.equal(response.status, 200);
      return (await response.text()).split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    };
    const user = { role: "user", content: "fixture isolation" };
    const chunks = await request([user]);
    const calls = chunks.flatMap(chunk => chunk.choices[0].delta.tool_calls ?? []);
    assert.equal(calls[0].function.name, "write");
    const args = JSON.parse(calls.map(call => call.function.arguments).join(""));
    assert.equal(args.path, "isolation.html");
    assert.equal(args.content, isolationHtml());
    const done = await request([user, { role: "tool", content: "Saved isolation.html" }]);
    assert.equal(done.some(chunk => chunk.choices[0].delta.tool_calls), false);
    assert.equal(done.at(-1).choices[0].finish_reason, "stop");
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("rejects unowned inspectors before input, stage close or termination", async t => {
  for (const mismatch of ["missing root", "marker", "profile", "agentDir", "fixtureFile", "userData", "renderer"]) {
    await t.test(mismatch, async t => {
      const root = await mkdtemp(join(tmpdir(), "vomp-isolation-ownership-"));
      const env = await initializeFixture(root, "http://127.0.0.1:47831/v1");
      const calls = [];
      const launch = { pid: 123, profile: env.VOMP_DEV_PROFILE, agentDir: env.PI_CODING_AGENT_DIR, fixtureFile: join(root, "work", "isolation.html") };
      if (["profile", "agentDir", "fixtureFile"].includes(mismatch)) launch[mismatch] = join(root, "wrong");
      if (mismatch === "marker") await writeFile(join(root, "fixture.json"), JSON.stringify({ root: join(root, "wrong") }));
      const main = {
        async evaluate(expression) {
          calls.push(["main", expression]);
          if (expression.startsWith("({ pid:")) return launch;
          if (expression.includes("BrowserWindow.getAllWindows")) return { packaged: true, platform: process.platform, switchEnabled: true, url: "file:///fixture/index.html", userData: mismatch === "userData" ? env.HOME : env.VOMP_DEV_PROFILE };
          return true;
        },
        close() { calls.push(["disconnect-main"]); },
      };
      const renderer = {
        async call(method) {
          calls.push(["cdp", method]);
          if (method === "Target.getTargets") return { targetInfos: [{ type: "page", url: "file:///fixture/index.html", targetId: "app" }] };
          if (method === "Target.attachToTarget") return { sessionId: "app" };
          if (method === "Runtime.enable") return {};
          throw new Error(`Unexpected renderer command: ${method}`);
        },
        async evaluate(expression) { calls.push(["renderer", expression]); return "wrong-challenge"; },
        close() { calls.push(["disconnect-renderer"]); },
      };
      t.mock.method(InspectorConnection, "connect", async url => { calls.push(["connect", url]); return url === "ws://main" ? main : renderer; });
      t.mock.method(globalThis, "fetch", async url => new Response(JSON.stringify(String(url).includes("9229")
        ? [{ webSocketDebuggerUrl: "ws://main" }] : { webSocketDebuggerUrl: "ws://renderer" }), { status: 200 }));
      try {
        const report = await collectIsolationEvidence(join(root, "result.json"), mismatch === "missing root" ? undefined : root);
        assert.equal(report.platformPassed, false);
        assert.ok(report.error);
        assert.deepEqual(report.recovery, []);
        assert.equal(calls.some(([, value]) => /Input\.|terminateExecution|\.click\(|querySelector|\.focus\(/.test(value ?? "")), false);
        if (mismatch === "renderer") {
          assert.ok(calls.some(([kind, value]) => kind === "main" && value.includes("executeJavaScript")));
          assert.deepEqual(calls.filter(([kind]) => kind === "renderer"), [["renderer", "window.__vompIsolationChallenge"]]);
        } else assert.equal(calls.some(([kind, value]) => kind === "connect" && value === "ws://renderer"), false);
      } finally { t.mock.restoreAll(); await rm(root, { recursive: true, force: true }); }
    });
  }
});
