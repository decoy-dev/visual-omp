import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

export function fixtureEnvironment(root) {
  root = resolve(root);
  const home = join(root, "home");
  const windows = process.platform === "win32";
  return {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    // Windows subprocesses need system paths; application data remains fixture-local.
    ...(windows ? {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      ComSpec: process.env.ComSpec,
      PATHEXT: process.env.PATHEXT,
      SystemDrive: process.env.SystemDrive,
      ProgramFiles: process.env.ProgramFiles,
      "ProgramFiles(x86)": process.env["ProgramFiles(x86)"],
      ProgramData: process.env.ProgramData,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
    } : {}),
    SHELL: windows
      ? process.env.VOMP_FIXTURE_SHELL ?? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
      : "/bin/bash",
    LANG: "en_US.UTF-8",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    OMP_PROFILE: "",
    PI_CONFIG_DIR: ".omp",
    PI_CODING_AGENT_DIR: join(home, ".omp", "agent"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    TMPDIR: join(root, "tmp"),
    TMP: join(root, "tmp"),
    TEMP: join(root, "tmp"),
    OMP_SKIP_SETUP: "1",
    PI_NO_PTY: "1",
    PI_BASH_NO_LOGIN: "1",
    PI_NOTIFICATIONS: "off",
    OTEL_SDK_DISABLED: "true",
    VOMP_DEV_PROFILE: join(root, "app-profile"),
  };
}

export async function initializeFixture(root, baseUrl) {
  root = resolve(root);
  const env = fixtureEnvironment(root);
  for (const path of [env.HOME, env.PI_CODING_AGENT_DIR, env.VOMP_DEV_PROFILE, env.TMPDIR, join(root, "work"), ...["data", "state", "cache"].map(part => join(root, part, "omp")), ...[env.APPDATA, env.LOCALAPPDATA].filter(Boolean)]) {
    await mkdir(path, { recursive: true });
  }
  const config = {
    setupVersion: 999,
    startup: { setupWizard: false, checkUpdate: false, changelogMode: "hidden", quiet: true },
    marketplace: { autoUpdate: "off" },
    worktree: { onStart: "off", onExit: "keep" },
    autocomplete: { enabled: false },
    composer: { predictions: false },
    recap: { enabled: false },
    memory: { enabled: false },
    idle: { enabled: false },
    git: { enabled: false },
    tools: { approvalMode: "yolo" },
    generate_image: { enabled: true },
    modelRoles: { default: "fixture/preview", smol: "fixture/preview", tiny: "fixture/preview" },
    disabledProviders: ["ollama", "llama.cpp", "lm-studio"],
    mcp: { enableProjectConfig: false, discovery: { native: false, claude: false, codex: false, gemini: false, vscode: false, cursor: false, windsurf: false } },
  };
  const models = { providers: { fixture: {
    baseUrl,
    apiKey: "local-fixture-only",
    api: "openai-completions",
    models: [{ id: "preview", name: "Live preview fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 32768 }],
  } } };
  await writeFile(join(env.PI_CODING_AGENT_DIR, "config.yml"), JSON.stringify(config, null, 2));
  await writeFile(join(env.PI_CODING_AGENT_DIR, "models.yml"), JSON.stringify(models, null, 2));
  await writeFile(join(root, "fixture.json"), JSON.stringify({ baseUrl, root }, null, 2));
  return env;
}

export async function requireFixture(root) {
  const marker = JSON.parse(await readFile(join(resolve(root), "fixture.json"), "utf8"));
  if (marker.root !== resolve(root)) throw new Error("The fixture root does not match its marker.");
  return fixtureEnvironment(root);
}
