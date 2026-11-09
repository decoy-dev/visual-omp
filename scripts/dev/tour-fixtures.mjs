import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

export async function configureTour(env, manifest) {
  const configPath = join(env.PI_CODING_AGENT_DIR, "config.yml");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  for (const [key, value] of Object.entries(manifest.config ?? {})) config[key] = { ...config[key], ...value };
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  const modelsPath = join(env.PI_CODING_AGENT_DIR, "models.yml");
  const models = JSON.parse(await readFile(modelsPath, "utf8"));
  const base = models.providers.fixture.models[0];
  for (const model of manifest.models ?? []) models.providers.fixture.models.push({ ...base, ...model });
  await writeFile(modelsPath, JSON.stringify(models, null, 2) + "\n");
  for (const skill of manifest.skills ?? []) {
    if (!/^[a-z0-9-]+$/.test(skill.name)) throw new Error("Invalid tour skill name.");
    const folder = join(env.PI_CODING_AGENT_DIR, "skills", skill.name);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "SKILL.md"), `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.body}\n`);
  }
}

/**
 * Writes the development update feed. `{{fixtureHealth}}` in release fields becomes the local provider's `/health`
 * URL, a fixed 26-byte download for checksum-verified rollback samples. `method` and the other optional feed fields
 * pass through, and `ompUpdate: false` reports omp as up to date so no omp update is offered.
 */
export async function prepareUpdateFixture(root, version, { releases = [], ompUpdate = true, method, brewCommand, installedVersion, scoopGlobal, scoopRetainedVersions } = {}, baseUrl) {
  const current = /^omp\/(\d+\.\d+\.\d+)/.exec(version)?.[1];
  if (!current) throw new Error("Cannot prepare the update fixture without an omp version.");
  const [major, minor, patch] = current.split(".").map(Number);
  const latest = `${major}.${minor}.${patch + 1}`;
  const health = baseUrl ? new URL("/health", baseUrl).href : null;
  if (!health && JSON.stringify(releases).includes("{{fixtureHealth}}")) throw new Error("The update fixture needs the local provider for {{fixtureHealth}}.");
  releases = JSON.parse(JSON.stringify(releases).replaceAll("{{fixtureHealth}}", health ?? ""));
  const feedPath = join(root, "update-feed.json");
  const scriptPath = join(root, "simulate-omp-update.mjs");
  const marker = join(root, "update-refused");
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  // This is the only command the dev update dialog runs. It changes its own
  // marker and feed under the isolated root; it never invokes omp or an installer.
  await writeFile(scriptPath, `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
if (!existsSync(marker)) {
  writeFileSync(marker, "The next simulated attempt succeeds.\\n");
  console.error("Another omp update is already running; try again once it finishes.");
  process.exitCode = 1;
} else {
  const path = ${JSON.stringify(feedPath)};
  const feed = JSON.parse(readFileSync(path, "utf8"));
  feed.ompCheck.stdout = ${JSON.stringify(`Current version: ${current}\nAlready up to date\n`)};
  writeFileSync(path, JSON.stringify(feed, null, 2) + "\\n");
  console.log("Simulated omp update completed. No installation was changed.");
}
`);
  await writeFile(feedPath, JSON.stringify({
    releases,
    ...Object.fromEntries(Object.entries({ method, brewCommand, installedVersion, scoopGlobal, scoopRetainedVersions }).filter(([, value]) => value !== undefined)),
    ompCheck: { code: 0, stdout: ompUpdate ? `Current version: ${current}\nNew version available: ${latest}\n` : `Current version: ${current}\nAlready up to date\n`, stderr: "" },
    ...(ompUpdate ? { ompUpdateCommand: `${quote(process.execPath)} ${quote(scriptPath)}` } : {}),
    ompVersionAfter: current,
  }, null, 2) + "\n");
  return feedPath;
}

/** Writes the successful-update record the app reads, and consumes, on launch; only inside an absolute scratch profile. */
export async function seedPendingUpdate(profile, pending, now = Date.now()) {
  if (!profile || !isAbsolute(profile) || !/^[0-9][\w.+-]*$/.test(pending.from ?? "") || !/^[0-9][\w.+-]*$/.test(pending.to ?? "")) throw new Error("The pending update needs an absolute scratch profile and versions.");
  const path = join(profile, "update-pending.json");
  await writeFile(path, JSON.stringify({ ...pending, at: now }) + "\n");
  return path;
}

export async function appendRecordedTools(file, entries, recordings) {
  if (!recordings?.length) return;
  const template = entries.findLast(entry => entry.message?.role === "assistant").message;
  let parentId = entries.findLast(entry => entry.id)?.id ?? null;
  const added = [];
  const append = message => {
    const entry = { type: "message", id: randomUUID().slice(0, 8), parentId, timestamp: new Date().toISOString(), message };
    parentId = entry.id;
    added.push(entry);
  };
  const assistant = (content, stopReason) => ({ role: "assistant", content, api: template.api, provider: template.provider, model: template.model, usage: template.usage, stopReason, timestamp: Date.now() });
  for (const [index, recording] of recordings.entries()) {
    const toolCallId = `tour-recorded-${index}`;
    append(assistant([{ type: "toolCall", id: toolCallId, name: recording.name, arguments: recording.args }], "toolUse"));
    append({ role: "toolResult", toolCallId, toolName: recording.name, ...recording.result, isError: false, timestamp: Date.now() });
  }
  append(assistant([{ type: "text", text: "The recorded tool-card examples are ready. No language server or web provider was contacted." }], "stop"));
  await appendFile(file, added.map(entry => JSON.stringify(entry)).join("\n") + "\n");
}

export function validateRecordedTools(entries, recordings) {
  for (const [index, recording] of (recordings ?? []).entries()) {
    const id = `tour-recorded-${index}`;
    const call = entries.flatMap(entry => entry.message?.content ?? []).find(part => part.type === "toolCall" && part.id === id);
    const result = entries.find(entry => entry.message?.role === "toolResult" && entry.message.toolCallId === id)?.message;
    if (!call || call.name !== recording.name || JSON.stringify(call.arguments) !== JSON.stringify(recording.args)
      || !result || result.toolName !== recording.name || JSON.stringify(result.content) !== JSON.stringify(recording.result.content)
      || JSON.stringify(result.details) !== JSON.stringify(recording.result.details)) throw new Error(`Incomplete recorded tour tool: ${id}`);
  }
}
