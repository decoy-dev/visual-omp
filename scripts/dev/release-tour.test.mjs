import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArguments, readTourSession, tourLayout } from "./release-tour.mjs";
import manifest from "./tours/0.7.8.mjs";

test("tour flags reject unknown options and traversal releases", () => {
  assert.equal(parseArguments([]).release, "0.7.8");
  assert.equal(parseArguments(["--prepare-only"]).prepareOnly, true);
  assert.equal(parseArguments(["--release", "0.7.9", "--omp", "/bin/omp"]).binary, "/bin/omp");
  assert.throws(() => parseArguments(["--release", "../server"]));
  assert.throws(() => parseArguments(["--release"]));
  assert.throws(() => parseArguments(["--unknown"]));
  assert.throws(() => parseArguments(["--prepare-only", "--resume", "/tmp/example"]));
});

test("layout opens every chat with its own side panel and focuses the first", () => {
  const chats = manifest.chats.map(chat => ({ ...chat, projectPath: `/scratch/${chat.id}`, sessionFile: `/scratch/${chat.id}.jsonl` }));
  const layout = tourLayout(chats);
  assert.equal(layout.tabs.length, manifest.chats.length);
  assert.equal(layout.activeTabId, layout.tabs[0].id);
  assert.equal(layout.activeProject, chats[0].projectPath);
  assert.equal(new Set(layout.tabs.map(tab => tab.id)).size, chats.length);
  assert.equal(layout.docks["tour-video"].pane, "outputs");
  assert.equal(layout.docks["tour-helper"].pane, "tasks");
  assert.ok(Object.values(layout.docks).every(dock => dock.open));
  assert.throws(() => tourLayout([]));
});

test("the release manifest covers replayable outputs, questions and manual checks", () => {
  for (const id of ["video", "docx", "xlsx", "html", "colors", "helper", "sequence", "process", "commands"]) assert.ok(manifest.chats.some(chat => chat.id === id));
  for (const kind of ["docx", "xlsx"]) {
    const chat = manifest.chats.find(chat => chat.id === kind);
    assert.match(chat.prompts[0], new RegExp(`fixture ${kind}\\n`));
    assert.match(chat.prompts[1], new RegExp(`fixture ${kind} complete`));
  }
  assert.ok(manifest.chats.find(chat => chat.id === "html").sampleHtml);
  assert.match(manifest.chats.find(chat => chat.id === "commands").folder, / /);
  assert.match(manifest.chats.find(chat => chat.id === "commands").prompts[0], /PPTX previews require LibreOffice/);
  assert.match(manifest.chats.find(chat => chat.id === "process").prompts[0], /Restart omp.*Supervised process failed/);
  assert.match(manifest.chats.find(chat => chat.id === "video").prompts[0], /first-use transcript loading/);
  assert.match(manifest.chats.find(chat => chat.id === "helper").prompts[0], /first helper open/);
  assert.ok(manifest.chats.every(chat => chat.prompts[0].includes("fixture ")));
});

test("generated session validation parses JSONL and rejects failed turns", async t => {
  const root = await mkdtemp(join(tmpdir(), "vomp-tour-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "session.jsonl");
  const entries = [{ type: "session", id: "example" }, { type: "message", message: { role: "user", content: "fixture notes" } }, { type: "message", message: { role: "assistant", content: [], stopReason: "stop" } }];
  await writeFile(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  assert.equal((await readTourSession(file)).length, 3);
  entries[2].message.stopReason = "error";
  await writeFile(file, entries.map(entry => JSON.stringify(entry)).join("\n"));
  await assert.rejects(readTourSession(file), /Failed omp turn/);
  await writeFile(file, '{"type":"session"}\n');
  await assert.rejects(readTourSession(file), /Incomplete omp tour/);
  await writeFile(file, "broken");
  await assert.rejects(readTourSession(file), SyntaxError);
});
