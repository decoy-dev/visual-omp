import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixture, sequenceCommand, videoCommand } from "./server.mjs";

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function callsFor(prompt, messages = [{ role: "user", content: prompt }]) {
  const root = await mkdtemp(join(tmpdir(), "vomp-video-fixture-")); roots.push(root);
  const server = await startFixture({ root, port: 0, durationMs: 0 });
  try {
    const response = await fetch(`${server.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages }) });
    assert.equal(response.status, 200);
    const calls = new Map();
    for (const line of (await response.text()).split("\n")) {
      if (!line.startsWith("data: {") || line === "data: [DONE]") continue;
      for (const call of JSON.parse(line.slice(6)).choices[0].delta.tool_calls ?? []) {
        const prior = calls.get(call.index) ?? { name: "", arguments: "" };
        if (call.function.name) prior.name = call.function.name;
        prior.arguments += call.function.arguments ?? "";
        calls.set(call.index, prior);
      }
    }
    return [...calls.values()].map(call => ({ name: call.name, args: JSON.parse(call.arguments) }));
  } finally { await server.close(); }
}

test("video uses a real paced ffmpeg render with an explicit 180-frame total", async () => {
  const calls = await callsFor("fixture video");
  assert.equal(calls.length, 1); assert.equal(calls[0].name, "bash");
  assert.equal(calls[0].args.command, videoCommand());
  assert.match(calls[0].args.command, /-re .*testsrc=duration=6:size=320x240:rate=30/);
  assert.match(calls[0].args.command, /-frames:v 180 .*libx264 .*yuv420p .*progress pipe:1 out\.mp4$/);
  assert.match(calls[0].args.command, /-g 30 -bf 0 -movflags frag_keyframe\+empty_moov\+default_base_moof -flush_packets 1/);
});

test("regular MP4 remains a separate incomplete-file case", async () => {
  const [call] = await callsFor("fixture regular-video");
  assert.equal(call.args.command, videoCommand(false, true));
  assert.doesNotMatch(call.args.command, /movflags/);
  assert.match(call.args.command, /regular\.mp4$/);
});

test("sequence declares one numbered output and writes three differently named images", async () => {
  const [call] = await callsFor("fixture sequence");
  assert.equal(call.args.command, sequenceCommand());
  assert.match(call.args.command, /photo\{i\}\.png/);
  assert.match(call.args.command, /frames\/frame%04d\.png$/);
});

test("progress replays versioned captured logs through recognized command names", async () => {
  const calls = await callsFor("fixture progress");
  assert.equal(calls.length, 2);
  assert.match(calls[0].args.command, /remotion\(\).*python3 -c/s);
  assert.match(calls[0].args.command, /On version: 4\.0\.391/);
  assert.match(calls[0].args.command, /\nremotion render index\.jsx Sample progress\.mp4$/);
  assert.match(calls[1].args.command, /Manim Community v0\.19\.0/);
  assert.match(calls[1].args.command, /\nmanim render -ql scene\.py Sample$/);
});

test("ProRes scenario produces a MOV without changing the video scenario", async () => {
  const [call] = await callsFor("fixture prores");
  assert.equal(call.args.command, videoCommand(true));
  assert.match(call.args.command, /prores_ks.*unsupported\.mov$/);
});

test("colors includes a hex-option ask question", async () => {
  const [call] = await callsFor("fixture colors");
  assert.equal(call.name, "ask");
  assert.deepEqual(call.args.questions[0].options.map(option => option.label), ["#2B72E5", "#197f8680"]);
  assert.match(call.args.questions[0].question, /#2B72E5/);
});

test("helper requests one fixture-backed helper with a deterministic reply", async () => {
  const [call] = await callsFor("fixture helper");
  assert.equal(call.name, "task");
  assert.equal(call.args.tasks.length, 1);
  assert.equal(call.args.tasks[0].model, undefined);
  assert.match(call.args.tasks[0].task, /fixture helper-reply/);
});

test("complete Office variants keep a valid package for tour startup", async () => {
  const [call] = await callsFor("fixture docx complete");
  assert.match(call.args.command, /if False else package\(3\)/);
  assert.match(call.args.command, /complete save/);
  const [normal] = await callsFor("fixture docx");
  assert.match(normal.args.command, /if True else package\(3\)/);
  assert.match(normal.args.command, /truncated save/);
});

test("replaying HTML uses the latest turn when deciding whether to write the page", async () => {
  const calls = await callsFor("", [
    { role: "user", content: "fixture html" },
    { role: "assistant", tool_calls: [{ function: { name: "write", arguments: JSON.stringify({ path: "page.html" }) } }] },
    { role: "tool", content: "Saved" },
    { role: "user", content: "fixture html" },
    { role: "assistant", tool_calls: [{ function: { name: "write", arguments: JSON.stringify({ path: "style.css" }) } }] },
    { role: "tool", content: "Saved" },
  ]);
  assert.deepEqual(calls.map(call => call.args.path), ["page.html"]);
});

test("resuming the fixture retains configuration edited during the tour", async () => {
  const root = await mkdtemp(join(tmpdir(), "vomp-resume-fixture-")); roots.push(root);
  const first = await startFixture({ root, port: 0 });
  const port = Number(new URL(first.baseUrl).port);
  await first.close();
  const file = join(root, "home", ".omp", "agent", "config.yml");
  await writeFile(file, "retained scratch configuration");
  const resumed = await startFixture({ root, port, initializeProfile: false });
  try {
    assert.equal(await readFile(file, "utf8"), "retained scratch configuration");
    assert.equal(resumed.baseUrl, first.baseUrl);
  } finally { await resumed.close(); }
});

test("process fixture starts a ready supervised process and keeps the session open for its exit", async () => {
  const [start] = await callsFor("fixture process");
  assert.equal(start.name, "bash");
  assert.equal(start.args.name, "tour-process");
  assert.deepEqual(start.args.ready, { log: "tour process ready" });
  assert.match(start.args.command, /raise SystemExit\(1\)/);
  const [record] = await callsFor("", [
    { role: "user", content: "fixture process" },
    { role: "assistant", tool_calls: [{ function: { name: "bash", arguments: JSON.stringify(start.args) } }] },
    { role: "tool", content: "Process ready" },
  ]);
  assert.match(record.args.command, /time\.sleep\(2\)/);
  const done = await callsFor("", [
    { role: "user", content: "fixture process" },
    { role: "assistant", tool_calls: [{ function: { name: "bash", arguments: "{}" } }, { function: { name: "bash", arguments: "{}" } }] },
    { role: "tool", content: "Completed" },
  ]);
  assert.deepEqual(done, []);
});
