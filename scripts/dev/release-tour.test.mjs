import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { generateChat, parseArguments, readTourSession, tourLayout } from "./release-tour.mjs";
import manifest from "./tours/0.7.9.mjs";
import patch from "./tours/0.7.10.mjs";
import current from "./tours/0.7.11.mjs";
import next from "./tours/0.7.12.mjs";
import latest from "./tours/0.7.13.mjs";
import previous from "./tours/0.7.8.mjs";
import { configureTour, padSession, prepareUpdateFixture, seedPendingUpdate, appendRecordedTools, validateRecordedTools } from "./tour-fixtures.mjs";
import { initializeFixture } from "../live-preview-fixture/environment.mjs";
import { startFixture } from "../live-preview-fixture/server.mjs";

test("tour flags reject unknown options and traversal releases", () => {
  assert.equal(parseArguments([]).release, "0.7.13");
  assert.equal(parseArguments(["--prepare-only"]).prepareOnly, true);
  assert.equal(parseArguments(["--release", "0.7.9", "--omp", "/bin/omp"]).binary, "/bin/omp");
  assert.throws(() => parseArguments(["--release", "../server"]));
  assert.throws(() => parseArguments(["--release"]));
  assert.throws(() => parseArguments(["--unknown"]));
  assert.throws(() => parseArguments(["--prepare-only", "--resume", "/tmp/example"]));
});

test("the small 0.7.10 tour covers XDG discovery and states the room-replacement evidence limit", () => {
  assert.equal(patch.version, "0.7.10");
  assert.deepEqual(patch.chats.map(chat => chat.id), ["xdg-data", "room-recovery"]);
  const [data, recovery] = patch.chats;
  assert.deepEqual(data.files, ["frames.png"]);
  assert.equal(data.model, "fixture/xdg");
  assert.deepEqual(patch.models[0].input, ["text", "image"]);
  assert.match(data.prompts[0], /^fixture png\n.*Home.*Recent chats.*Projects.*Attach files.*XDG prompt history marker.*press Up.*attached image.*Usage & limits/s);
  assert.match(data.prompts[1], /^fixture cache\n.*12,000 input tokens.*32 output tokens/s);
  assert.match(recovery.prompts[0], /^fixture helpers\n.*relay drop or collab room replacement.*Waiting for omp to open its semantic screen.*same process, session and epoch cannot be forced.*collector/s);
  assert.match(recovery.prompts[0], /no supported dev or fixture control.*blocks \/collab stop.*Do not kill omp/s);
  assert.match(recovery.prompts[0], /queue exactly: Keep this helper message until reconnect.*five seconds.*Restart omp.*ordinary reconnect.*ended connection.*selectable text.*Try sending again/s);
  assert.match(recovery.prompts[0], /helper Stop request.*lost-connection error.*select and copy.*Restart omp from the chat menu.*relaunch.*must not be sent automatically.*src\/main\/omp\/tsp\/semantic-report\.live\.test\.ts/s);
  assert.equal(recovery.pane, "tasks");
  assert.ok(patch.chats.every(chat => !/[\u2013\u2014]/.test(chat.prompts.join(""))));
  const layout = tourLayout(patch.chats.map(chat => ({ ...chat, projectPath: `/scratch/${chat.id}`, sessionFile: `/scratch/${chat.id}.jsonl` })));
  assert.equal(layout.tabs.length, 2);
  assert.equal(layout.docks["tour-room-recovery"].pane, "tasks");
});

test("0.7.11 opens one chat per change with explicit owner checks and fixture limits", () => {
  assert.equal(current.version, "0.7.11");
  assert.deepEqual(current.chats.map(chat => chat.id), ["release-notes", "file-mentions", "missing-result"]);
  const [notes, mentions, missing] = current.chats;
  assert.match(notes.prompts[0], /Settings > About > Read release notes.*Past versions.*v0.7.11.*Release notes are easier to scan.*File mentions support spaced paths/s);
  assert.match(notes.prompts[0], /v0.7.9.*v0.7.0.*bundled.*Review update.*This update.*Important.*Security, New, Improved, Changed, Fixed, Removed/s);
  assert.deepEqual(mentions.files, ["Design projects.zip", "Meeting notes.md", "Client files/Review notes.md", 'Client files/Review "draft".md']);
  assert.match(mentions.prompts[0], /@ picker.*Finder.*Cmd-click.*command palette.*single quotes.*no separate Read row/s);
  assert.equal(mentions.prompts[1], 'fixture mentions @"Meeting notes.md"');
  assert.match(mentions.expectedReply, /received meeting content/);
  assert.match(missing.prompts[0], /fixture bash-trace.*conditional.*collab-entry-too-large.*neutral mark.*Result unavailable.*unexercised.*ToolCard.test.ts.*Transcript.test.ts/s);
  assert.ok(current.chats.every(chat => !/[\u2013\u2014]/.test(chat.prompts.join(""))));
});

test("0.7.12 large-media tour checks spaced reply links and files in one spaced subfolder", () => {
  const chat = next.chats.find(chat => chat.id === "large-media");
  assert.deepEqual(chat.files, ["Large Media Files/Large video.mp4", "Large Media Files/Large image.png", "Large Media Files/Large document.pdf", "Large Media Files/Large notes.txt"]);
  assert.equal(chat.expectedReply, "Created the files in `Large Media Files/`:\n\n- `Large video.mp4`\n- `Large image.png`\n- `Large document.pdf`\n- `Large notes.txt`");
  assert.match(chat.prompts[0], /^fixture bigmedia\n.*Large Media Files\/ subfolder/);
  assert.match(chat.prompts[0], /click a file name in the reply to open the side-panel viewer/);
  assert.match(chat.prompts[0], /directory once, followed by four bare file names with spaces/);
  assert.match(chat.prompts[0], /In the Files pane, open Large Media Files\/ and then Large video\.mp4/);
  for (const name of chat.files.map(file => file.slice("Large Media Files/".length))) assert.ok(chat.prompts[0].includes(name), name);
  assert.ok(!/[\u2013\u2014]/.test(chat.prompts.join("")));
});

test("0.7.13 prepares five focused chats with local model choices and explicit interaction checks", () => {
  assert.equal(latest.version, parseArguments([]).release);
  assert.deepEqual(latest.chats.map(chat => chat.id), ["model-switching", "helper-conversations", "files-and-commands", "form-finish", "omp-question"]);
  assert.deepEqual(latest.models.map(({ id, name, reasoning }) => ({ id, name, reasoning })), [
    { id: "second", name: "Second fixture", reasoning: false },
    { id: "thinker", name: "Thinking fixture", reasoning: true },
  ]);
  assert.deepEqual(latest.models[1].thinking, { mode: "effort", efforts: ["low", "medium", "high", "max"], defaultLevel: "medium", requiresEffort: false });
  const [models, helpers, files, form, question] = latest.chats;
  for (const [index, chat] of latest.chats.entries()) {
    assert.ok(chat.title.startsWith(`${String(index + 1).padStart(2, "0")} `));
    for (const prompt of chat.prompts) {
      assert.match(prompt, /^fixture (notes|bigmedia)\n/);
      assert.match(prompt, /\n1\. .*\n2\. /s);
      assert.ok(!/[\u2013\u2014]/.test(prompt));
    }
  }
  assert.match(models.prompts[0], /Second fixture, then Live preview fixture, then Thinking fixture.*brief flashes.*Thinking.*High.*First rewind check.*Second rewind check.*Rewind to here.*\/extensions.*immediately.*Close the screen/s);
  assert.equal(helpers.pane, "tasks");
  assert.match(helpers.prompts[0], /cannot keep helpers running.*fixture helpers.*Open TourWorker1's conversation.*teal band.*small Back button.*Back to 02 Helper conversations are clearly marked.*Message helper TourWorker1.*Parent chat: 02 Helper conversations are clearly marked.*Choose Back/s);
  const previousMedia = next.chats.find(chat => chat.id === "large-media");
  assert.deepEqual(files.files, previousMedia.files);
  assert.equal(files.expectedReply, previousMedia.expectedReply);
  assert.match(files.prompts[0], /^fixture bigmedia\n.*Large Media Files\/Large notes\.txt.*No row should show the full scratch path.*Click one file row.*\/stats.*Copy URL.*no duplicate Open dashboard.*Restart omp.*Settings > Models & roles.*While the model list loads.*isn't available.*does not establish this timing/s);
  assert.match(form.prompts[0], /question card closes without jumping.*omp 18\.18\.3.*cannot keep a question open.*fixture form.*Release channel.*Platforms to check.*Release note headline.*Review depth.*last answer.*close without jumping.*all four answers/s);
  assert.match(question.prompts[0], /\/reset-question.*synthetic account.*redeems no reset.*omp 18\.18\.6.*Type \/reset-question.*question card.*work@example\.com.*described Yes and No.*omp screen should stay closed.*Answer Yes.*Reset question choice: Yes\. No reset was redeemed/s);
  const layout = tourLayout(latest.chats.map(chat => ({ ...chat, projectPath: `/scratch/${chat.id}`, sessionFile: `/scratch/${chat.id}.jsonl` })));
  assert.equal(layout.tabs.length, 5);
  assert.equal(layout.docks["tour-helper-conversations"].pane, "tasks");
});

test("0.7.11 update feed preserves a labeled unpublished sample body for This update", async t => {
  const root = await mkdtemp(join(tmpdir(), "vomp-tour-release-notes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const feedPath = await prepareUpdateFixture(root, "omp/18.17.0", current.updateFixture);
  const feed = JSON.parse(await readFile(feedPath, "utf8"));
  assert.deepEqual(feed.releases, current.updateFixture.releases);
  assert.equal(feed.releases[0].tag_name, "v0.7.12");
  const body = feed.releases[0].body;
  assert.match(body, /simulated release-notes sample.*\[!IMPORTANT\]/s);
  assert.equal([...body.matchAll(/^- \*\*\w+:\*\* \*\*/gm)].length, 2);
  assert.deepEqual([...body.matchAll(/^- \*\*(\w+):\*\*/gm)].map(match => match[1]), ["Fixed", "Removed", "Improved", "Changed", "New", "Security", "Fixed", "Improved", "Fixed"]);
  assert.deepEqual(feed.releases[0].assets, []);
});

test("0.7.12 rollback samples download the provider's health body with its digest and no omp update offer", async t => {
  const root = await mkdtemp(join(tmpdir(), "vomp-tour-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(next.version, "0.7.12");
  await assert.rejects(prepareUpdateFixture(root, "omp/18.18.3", next.updateFixture), /needs the local provider/);
  const server = await startFixture({ root, port: 0, durationMs: 0 });
  t.after(() => server.close());
  const feed = JSON.parse(await readFile(await prepareUpdateFixture(root, "omp/18.18.3", next.updateFixture, server.baseUrl), "utf8"));
  assert.equal(feed.method, "brew");
  assert.match(feed.ompCheck.stdout, /Already up to date/);
  assert.equal(feed.ompUpdateCommand, undefined);
  const assets = feed.releases.flatMap(release => release.assets);
  assert.equal(assets.length, 4);
  for (const asset of assets) {
    assert.equal(asset.browser_download_url, new URL("/health", server.baseUrl).href);
    const body = Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer());
    assert.equal(body.length, asset.size);
    assert.equal(`sha256:${createHash("sha256").update(body).digest("hex")}`, asset.digest);
  }
});

test("each tour launch reseeds the consumed successful-update record inside the scratch profile", async t => {
  const root = await mkdtemp(join(tmpdir(), "vomp-tour-pending-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, "app-profile");
  await mkdir(profile);
  const path = await seedPendingUpdate(profile, next.updateFixture.pendingUpdate, 1000);
  assert.equal(path, join(profile, "update-pending.json"));
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { method: "brew", from: "0.7.10+rollback-tour", to: "0.7.12", at: 1000 });
  await rm(path);
  await seedPendingUpdate(profile, next.updateFixture.pendingUpdate, 2000);
  assert.equal(JSON.parse(await readFile(path, "utf8")).at, 2000);
  await assert.rejects(seedPendingUpdate("relative-profile", next.updateFixture.pendingUpdate), /absolute scratch profile/);
});

test("file-mention receipts use only content supplied for the latest prompt", async t => {
  const root = await mkdtemp(join(tmpdir(), "vomp-tour-mentions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = await startFixture({ root, port: 0, durationMs: 0 });
  t.after(() => server.close());
  const reply = async messages => {
    const response = await fetch(`${server.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages }) });
    assert.equal(response.status, 200);
    const chunks = (await response.text()).split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    return chunks.flatMap(chunk => chunk.choices).map(choice => choice.delta.content ?? "").join("");
  };
  assert.match(await reply([
    { role: "user", content: "<system-reminder>\nToday: 2026-11-06\n</system-reminder>\nfixture mentions setup\nCreate the samples." },
  ]), /I will prepare the mentions fixture/);
  assert.match(await reply([
    { role: "user", content: "fixture mentions old turn tour-0711-content:client" },
    { role: "user", content: 'fixture mentions @"Meeting notes.md"' },
    { role: "assistant", content: "tour-0711-content:meeting" },
    { role: "tool", content: "tour-0711-content:quoted" },
  ]), /No readable tour file content/);
  for (const role of ["developer", "user"]) assert.equal(await reply([
    { role: "user", content: 'fixture mentions @"Meeting notes.md"' },
    { role, content: "Read Meeting notes.md\ntour-0711-content:meeting\n" },
  ]), current.chats[1].expectedReply);
  assert.match(await reply([
    { role: "user", content: "fixture mentions tour-0711-content:meeting" },
    { role: "assistant", content: "Earlier receipt." },
    { role: "user", content: "A separate new message." },
  ]), /The correction was received/);
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

test("0.7.13 writes only its synthetic reset-question extension into the scratch agent directory", async t => {
  const root = await mkdtemp(join(tmpdir(), "vomp-tour-extension-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = await initializeFixture(root, "http://127.0.0.1:12345/v1");
  await configureTour(env, latest);
  assert.deepEqual(latest.extensions.map(extension => extension.name), ["reset-question"]);
  const path = join(env.PI_CODING_AGENT_DIR, "extensions", "reset-question.ts");
  const source = await readFile(path, "utf8");
  assert.equal(source, latest.extensions[0].source);
  const { default: extension } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const commands = new Map();
  extension({ registerCommand: (name, options) => commands.set(name, options) });
  assert.deepEqual([...commands.keys()], ["reset-question"]);
  const notifications = [];
  await commands.get("reset-question").handler("", { ui: {
    select: async (title, options) => {
      assert.equal(title, "Spend a saved Claude rate-limit reset?\nwork@example.com (Example): a saved reset covers Claude 5h with about 1h45m left.");
      assert.deepEqual(options, [
        { label: "Yes", description: "Redeem now and remember yes for future eligible Claude resets." },
        { label: "No", description: "Do not auto-redeem saved Claude resets." },
      ]);
      return "Yes";
    },
    notify: (...args) => notifications.push(args),
  } });
  assert.deepEqual(notifications, [["Reset question choice: Yes. No reset was redeemed.", "info"]]);
  await assert.rejects(configureTour(env, { extensions: [{ name: "../escape", source: "" }] }), /Invalid tour extension name/);
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

test("large-chat padding stays inside the scratch root and outside the model's context", async t => {
  const root = await mkdtemp(join(tmpdir(), "vomp-tour-padding-"));
  const outside = await mkdtemp(join(tmpdir(), "vomp-tour-outside-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const file = join(root, "chat.jsonl");
  const entries = [{ type: "session", id: "session" }, { type: "message", id: "last", parentId: null, message: { role: "user", content: [{ type: "text", text: "fixture notes" }] } }];
  const original = entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(file, original);
  await padSession(root, file, entries, undefined);
  assert.equal(await readFile(file, "utf8"), original);
  const bytes = next.chats.find(chat => chat.id === "large-chat").padBytes;
  assert.ok(bytes > 32 * 1024 * 1024);
  await padSession(root, file, entries, bytes);
  const saved = (await readFile(file, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(saved.slice(0, 2), entries);
  assert.equal(saved.length, 3);
  assert.equal(saved[2].type, "custom");
  assert.equal(saved[2].parentId, "last");
  assert.equal(saved[2].message, undefined);
  assert.ok((await stat(file)).size > bytes);
  const stranger = join(outside, "chat.jsonl");
  await writeFile(stranger, original);
  await assert.rejects(padSession(root, stranger, entries, 1), /outside its scratch root/);
  if (process.platform !== "win32") {
    await symlink(stranger, join(root, "linked.jsonl"));
    await assert.rejects(padSession(root, join(root, "linked.jsonl"), entries, 1), /outside its scratch root/);
  }
  assert.equal(await readFile(stranger, "utf8"), original);
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

test("generated tour tabs use the session header cwd instead of the launch folder spelling", { skip: process.platform === "win32" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "vomp-tour-cwd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "fixture-omp.mjs");
  const sessionFile = join(root, "generated.jsonl");
  const cwd = "/recorded/header/cwd";
  const entries = [
    { type: "session", id: "cwd-test", cwd },
    { type: "message", message: { role: "user", content: "fixture" } },
    { type: "message", message: { role: "assistant", content: [], stopReason: "stop" } },
  ];
  await writeFile(sessionFile, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  await writeFile(binary, `#!${process.execPath}
import { createInterface } from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const frame = JSON.parse(line);
  if (frame.type === "prompt") send({ type: "agent_end" });
  else send({ type: "response", id: frame.id, success: true, data: frame.type === "get_state" ? { sessionFile: ${JSON.stringify(sessionFile)} } : {} });
});
send({ type: "ready" });
`, { mode: 0o755 });
  const chat = await generateChat({ root, env: process.env, binary, chat: { id: "cwd-test", title: "Project identity", prompts: ["fixture"] } });
  assert.equal(chat.projectPath, cwd);
  assert.notEqual(chat.projectPath, join(root, "chats", "cwd-test"));
  assert.equal(tourLayout([chat]).tabs[0].projectPath, cwd);
});
