// Recorded examples of omp 18.19.0 argument and result shapes, without contacting GitHub or starting a browser.
// Sources: coding-agent/src/tools/gh-run-watch.ts (buildRunWatchJobDetails steps), tui/src/tools/github.ts
// (GhRunWatchViewDetails), coding-agent/src/tools/browser.ts (string `app`, top-level `target`) and
// coding-agent/src/task/types.ts (`steps` spawns).
const text = value => [{ type: "text", text: value }];

const job = (id, name, status, conclusion, durationSeconds, steps) => ({ id, name, status, ...(conclusion ? { conclusion } : {}), durationSeconds, ...(steps ? { steps } : {}) });
const step = (number, name, status, conclusion, durationSeconds) => ({ number, name, status, ...(conclusion ? { conclusion } : {}), ...(durationSeconds === undefined ? {} : { durationSeconds }) });

export default [
  {
    name: "github", args: { op: "run_watch", repo: "example/release-sample", run: "4242" },
    result: {
      content: text("Run #4242 failed: job lint failed at step #4 Check formatting."),
      details: { watch: { mode: "run", state: "completed", repo: "example/release-sample", run: {
        id: 4242, workflowName: "CI", status: "completed", conclusion: "failure", branch: "main",
        jobs: [
          job(1, "test", "completed", "success", 94, [
            step(1, "Set up job", "completed", "success", 2), step(2, "Install dependencies", "completed", "success", 31),
            step(3, "Run tests", "completed", "success", 58), step(4, "Complete job", "completed", "success", 1),
          ]),
          job(2, "lint", "completed", "failure", 40, [
            step(1, "Set up job", "completed", "success", 2), step(2, "Install dependencies", "completed", "success", 30),
            step(3, "Check types", "completed", "success", 6), step(4, "Check formatting", "completed", "failure", 2),
            step(5, "Complete job", "completed", "skipped"),
          ]),
          job(3, "build", "in_progress", null, 75, [
            step(1, "Set up job", "completed", "success", 2), step(2, "Install dependencies", "completed", "success", 29),
            step(3, "Build installers", "in_progress", null, 44), step(4, "Upload artifacts", "queued"),
          ]),
          job(4, "notify", "queued", null, undefined),
        ],
      } } },
    },
  },
  {
    name: "browser", args: { action: "open", name: "docs", url: "https://example.invalid/docs", app: "http://127.0.0.1:9222", target: "Release notes" },
    result: { content: text("Opened tab \"docs\" on connected http://127.0.0.1:9222."), details: { action: "open", name: "docs", url: "https://example.invalid/docs", browser: "connected" } },
  },
  {
    name: "browser", args: { action: "open", name: "main", url: "https://example.invalid/", app: "own" },
    result: { content: text("Opened tab \"main\" on omp's headless WebKit browser."), details: { action: "open", name: "main", url: "https://example.invalid/", browser: "webkit" } },
  },
  {
    name: "task", args: { i: "Checking stepped helpers", context: "Recorded example. No helper ran.", tasks: [
      { name: "ReleaseReader", agent: "scout", steps: ["Read the release sample.", "List the changed files."], solutionSpace: "Read only." },
      { name: "ReleaseWriter", agent: "task", task: "Draft one sentence for the release sample.", solutionSpace: "One sentence." },
    ] },
    result: { content: text("Recorded example: no helper ran."), details: {} },
  },
];
