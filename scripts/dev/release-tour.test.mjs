import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArguments, readTourSession, tourLayout } from "./release-tour.mjs";
import manifest from "./tours/0.7.9.mjs";
import previous from "./tours/0.7.8.mjs";
import { configureTour, prepareUpdateFixture, appendRecordedTools, validateRecordedTools } from "./tour-fixtures.mjs";
import { initializeFixture } from "../live-preview-fixture/environment.mjs";

test("tour flags reject unknown options and traversal releases", () => {
  assert.equal(parseArguments([]).release, "0.7.9");
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

test("0.7.9 covers each new area and keeps the previous useful chats", () => {
  assert.equal(manifest.version, "0.7.9");
  for (const chat of previous.chats) assert.ok(manifest.chats.some(item => item.id === chat.id));
  for (const id of ["composer", "cache", "tool-cards", "bash-trace", "settings", "office-quit", "timestamps", "helpers-load"]) assert.ok(manifest.chats.some(chat => chat.id === id));
  const prompt = id => manifest.chats.find(chat => chat.id === id).prompts[0];
  const video = manifest.chats.find(chat => chat.id === "video");
  assert.equal(video.prompts.filter(prompt => prompt.startsWith("fixture video\n")).length, 2);
  assert.ok(video.files.includes("poster.svg"));
  assert.ok(video.files.includes("frames.png") && video.files.includes("sample.pdf"));
  assert.match(video.prompts[0], /stage height.*tall poster.*frame sequence.*Word.*short and tall/s);
  assert.match(video.prompts[0], /Compact previews.*saved outputs follow.*viewer should replace the live stage.*Back.*sample.pdf.*Escape/s);
  assert.match(prompt("html"), /Fit width, 100% and Phone.*Pause following.*Show latest/s);
  assert.match(prompt("html"), /Open page.html from Files, select Preview/);
  assert.doesNotMatch(prompt("html"), /Repeat in Files using Watch/);
  assert.match(prompt("helper"), /card shrinks.*scroll up/s);
  assert.match(prompt("helper"), /one conversation button.*independent Stop button.*No conversation yet. You can still send a message.*composer must remain usable/s);
  assert.match(prompt("composer"), /\/unpin.*\^fixture\/reasoner:.*ultrathink.*chillax.*turn it off/s);
  assert.match(prompt("composer"), /Settings > Advanced, search for Ultrathink Keyword/);
  assert.match(prompt("cache"), /send fixture cache twice.*expired miss.*resend size/s);
  assert.match(prompt("settings"), /tour-catalog-\*.*remove.*automatic updates.*What's new in omp/s);
  assert.match(prompt("office-quit"), /Cancel.*confirm Quit.*Windows/s);
  assert.match(prompt("settings"), /VOMP_UPDATE_FEED.*Update omp.*Try again.*second simulated attempt succeeds/s);
  assert.ok(manifest.updateFixture);
  assert.match(prompt("timestamps"), /^fixture timestamps\n.*45 seconds.*first-to-latest range.*keyboard-focus.*Expand/s);
  assert.ok(manifest.chats.find(chat => chat.id === "timestamps").timeoutMs > 135_000);
  assert.equal(new Set(manifest.chats.map(chat => chat.id)).size, manifest.chats.length);
  assert.ok(manifest.chats.every(chat => !/[\u2013\u2014]/.test(chat.prompts.join(""))));
});

test("release configuration adds reasoning, cache metadata and two isolated skills", async t => {
  const root = await mkdtemp(join(tmpdir(), "vomp-tour-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = await initializeFixture(root, "http://127.0.0.1:12345/v1");
  await configureTour(env, manifest);
  const config = JSON.parse(await readFile(join(env.PI_CODING_AGENT_DIR, "config.yml"), "utf8"));
  const models = JSON.parse(await readFile(join(env.PI_CODING_AGENT_DIR, "models.yml"), "utf8")).providers.fixture.models;
  assert.equal(config.providers.cacheWarming, "off");
  assert.deepEqual(config.skills.manualSkills, ["tour-manual-*"]);
  assert.deepEqual(models.find(model => model.id === "reasoner").thinking.efforts, ["low", "medium", "high", "max"]);
  assert.equal(models.find(model => model.id === "cache").promptCache.short, 12);
  for (const skill of manifest.skills) assert.match(await readFile(join(env.PI_CODING_AGENT_DIR, "skills", skill.name, "SKILL.md"), "utf8"), new RegExp(`name: ${skill.name}`));
  assert.equal(config.startup.checkUpdate, false);
});

test("the scratch update command refuses once, succeeds on retry and never changes the installed version", async t => {
  const root = await mkdtemp(join(tmpdir(), "vomp tour's update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const feedPath = await prepareUpdateFixture(root, "omp/18.17.0");
  const feed = JSON.parse(await readFile(feedPath, "utf8"));
  assert.deepEqual(feed.releases, []);
  assert.match(feed.ompCheck.stdout, /New version available: 18.17.1/);
  assert.equal(feed.ompVersionAfter, "18.17.0");
  const run = () => process.platform === "win32"
    ? spawnSync(process.execPath, [join(root, "simulate-omp-update.mjs")], { encoding: "utf8" })
    : spawnSync("/bin/sh", ["-c", feed.ompUpdateCommand], { encoding: "utf8" });
  const refused = run();
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /Another omp update is already running; try again once it finishes\./);
  const retried = run();
  assert.equal(retried.status, 0, retried.stderr);
  assert.match(retried.stdout, /Simulated omp update completed. No installation was changed./);
  const updated = JSON.parse(await readFile(feedPath, "utf8"));
  assert.match(updated.ompCheck.stdout, /Already up to date/);
  assert.doesNotMatch(updated.ompCheck.stdout, /New version available/);
  assert.equal(updated.ompVersionAfter, feed.ompVersionAfter);
  assert.equal(updated.ompUpdateCommand, feed.ompUpdateCommand);
});

test("recorded tools preserve omp result shapes and form paired saved messages", async t => {
  const root = await mkdtemp(join(tmpdir(), "vomp-tour-recorded-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "chat.jsonl");
  const entries = [{ type: "session", id: "session" }, { type: "message", id: "user", message: { role: "user", content: [{ type: "text", text: "fixture notes" }] } }, { type: "message", id: "last", message: { role: "assistant", content: [], api: "openai-completions", provider: "fixture", model: "preview", usage: {}, stopReason: "stop" } }];
  await writeFile(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const recordings = manifest.chats.find(chat => chat.id === "tool-cards").recordedTools;
  await appendRecordedTools(file, entries, recordings);
  const saved = await readTourSession(file);
  validateRecordedTools(saved, recordings);
  assert.equal(saved.filter(entry => entry.message?.role === "toolResult").length, 5);
  assert.equal(saved[3].parentId, "last");
  for (let index = 4; index < saved.length; index++) assert.equal(saved[index].parentId, saved[index - 1].id);
  assert.equal(saved.find(entry => entry.message?.toolName === "web_search").message.details.failures[0].status, 429);
  assert.match(saved.find(entry => entry.message?.toolName === "lsp").message.content[0].text, /12: const total/);
  saved.find(entry => entry.message?.toolName === "lsp").message.details = {};
  assert.throws(() => validateRecordedTools(saved, recordings), /Incomplete recorded/);
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
