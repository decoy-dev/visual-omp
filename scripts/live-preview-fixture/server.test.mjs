import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixture, sequenceCommand, videoCommand } from "./server.mjs";

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function callsFor(prompt) {
  const root = await mkdtemp(join(tmpdir(), "vomp-video-fixture-")); roots.push(root);
  const server = await startFixture({ root, port: 0, durationMs: 0 });
  try {
    const response = await fetch(`${server.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }) });
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
