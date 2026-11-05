import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proofCalls, proofCommand, proofQuestion } from "./proof.mjs";
import { startFixture, videoCommand } from "./server.mjs";

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const prompt = { role: "user", content: "fixture proof" };
const proofCall = { id: "proof-write", function: { name: "bash", arguments: JSON.stringify({ command: proofCommand }) } };
const proof = [{ role: "assistant", tool_calls: [proofCall] }, { role: "tool", tool_call_id: proofCall.id, content: "/scratch/proofs/frame-1.png" }];
const askCall = { id: "proof-ask", function: { name: "ask", arguments: JSON.stringify({ questions: [{ id: "proof", question: proofQuestion, options: [{ label: "Yes" }, { label: "No" }] }] }) } };
const ask = { role: "assistant", tool_calls: [askCall] };

async function requestCalls(server, messages) {
  const response = await fetch(`${server.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages }) });
  assert.equal(response.status, 200);
  const calls = new Map();
  let finish;
  for (const line of (await response.text()).split("\n")) {
    if (!line.startsWith("data: {")) continue;
    const choice = JSON.parse(line.slice(6)).choices[0];
    finish = choice.finish_reason ?? finish;
    for (const call of choice.delta.tool_calls ?? []) {
      const prior = calls.get(call.index) ?? { name: "", arguments: "" };
      prior.name = call.function.name || prior.name;
      prior.arguments += call.function.arguments ?? "";
      calls.set(call.index, prior);
    }
  }
  return { calls: [...calls.values()].map(call => ({ name: call.name, args: JSON.parse(call.arguments) })), finish };
}

test("fixture proof saves a single frame before asking, waits, then renders only on Yes", async () => {
  const root = await mkdtemp(join(tmpdir(), "vomp-proof-fixture-")); roots.push(root);
  const server = await startFixture({ root, port: 0, durationMs: 0 });
  try {
    const first = await requestCalls(server, [prompt]);
    assert.deepEqual(first.calls, [{ name: "bash", args: { command: proofCommand, timeout: 30 } }]);
    assert.match(proofCommand, /-frames:v 1 proofs\/frame-1\.png/);
    assert.doesNotMatch(proofCommand, /out\.mp4/);
    const second = await requestCalls(server, [prompt, ...proof]);
    assert.deepEqual(second.calls, [{ name: "ask", args: JSON.parse(askCall.function.arguments) }]);
    assert.deepEqual(proofCalls([prompt, ...proof, ask], videoCommand()), []);
    const yes = { role: "tool", tool_call_id: askCall.id, content: "User selected: Yes" };
    assert.deepEqual((await requestCalls(server, [prompt, ...proof, ask, yes])).calls, [{ name: "bash", args: { command: videoCommand(), timeout: 30 } }]);
  } finally { await server.close(); }
});

test("No ends the turn without a render and timeout or interruption never approves", async () => {
  const root = await mkdtemp(join(tmpdir(), "vomp-proof-fixture-")); roots.push(root);
  const server = await startFixture({ root, port: 0, durationMs: 0 });
  try {
    for (const content of ["User selected: No", "User selected: Yes (auto-selected after timeout)", "Ask interrupted by message", "User cancelled the selection", "", "User selected: Yes\nNote: change the proof first"]) {
      const result = await requestCalls(server, [prompt, ...proof, ask, { role: "tool", tool_call_id: askCall.id, content }]);
      assert.deepEqual(result.calls, [], content);
      assert.equal(result.finish, "stop", content);
    }
  } finally { await server.close(); }
});

test("a failed proof does not ask for approval or run a render", () => {
  assert.deepEqual(proofCalls([prompt, proof[0], { ...proof[1], content: "Error: ffmpeg failed" }], videoCommand()), []);
});

test("a completed render does not repeat", () => {
  const render = { role: "assistant", tool_calls: [{ id: "render", function: { name: "bash", arguments: JSON.stringify({ command: videoCommand() }) } }] };
  assert.deepEqual(proofCalls([prompt, ...proof, ask, { role: "tool", tool_call_id: askCall.id, content: "User selected: Yes" }, render, { role: "tool", tool_call_id: "render", content: "Done" }], videoCommand()), []);
});
