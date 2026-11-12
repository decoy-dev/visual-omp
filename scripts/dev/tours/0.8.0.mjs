import toolCards from "./tool-cards-18.19.mjs";

export default {
  version: "0.8.0",
  // Shell visualization is omp's default; the tour sets it so a changed default cannot hide the check. omp 18.19.0
  // sends a helper's work one step at a time when `task.steps` is on.
  config: { display: { shellVisualization: true }, task: { steps: true } },
  chats: [
    {
      id: "bash-visualization", title: "01 Bash visualizations",
      prompts: [[
        "fixture bash-visualization",
        "The local fixture ran three short bash calls before the app opened, so this saved chat shows them the way the app restores a saved trace: in its own isolated omp process, without running anything again.",
        "Expand each bash call. Pseudo is selected; switch to Raw and back. The first two calls keep / as their working folder and their leading cd / && and cd /; separators in both views.",
        "In the second call, open Recorded byte values. The newline and the invalid byte appear as escaped bytes, separately from omp's command above.",
        "In the third call, check the values recorded for NAME and COUNT next to their assignments and the failed false inside the pipeline. Open Replay, step back through the loop with Previous event, then choose Latest. Try Display options and the Original/Pseudo split.",
        "Send fixture bash-visualization again to watch the live path: the third call's rows update while its loop runs.",
      ].join("\n")],
    },
    {
      id: "steps", title: "02 Helper steps",
      prompts: [[
        "fixture steps",
        "This chat starts one helper whose work is split into two steps. omp 18.19.0 sends each step as its own message once the helper reports on the previous one.",
        "Expand the task card and check that it lists both steps as Step 1/2 and Step 2/2 with a 2 steps badge.",
        "A saved helper card has no open action, so send fixture steps again. The local fixture provider answers each step in about fifteen seconds.",
        "Open the new helper from Tasks or its card; omp numbers a repeated name, such as TourHelper-2. Its conversation should show Step 1 of 2 and Step 2 of 2 with each step's text, and no instruction text addressed to the helper.",
      ].join("\n")],
      helper: true,
    },
    {
      id: "tool-cards", title: "03 Tool cards: omp 18.19.0 formats", recordedTools: toolCards,
      prompts: [[
        "fixture notes",
        "These cards are recorded examples in omp 18.19.0's formats. No GitHub request was made and no browser started.",
        "Expand the GitHub card. Each job with steps shows a progress line: test shows 4/4 steps complete, lint names its failed step #4 Check formatting, and build shows 3/4 #3 Build installers in progress. Each progress line opens the job's ordered steps with their states and times. The notify job has no steps and keeps its single row.",
        "Expand both browser cards. The first shows connected http://127.0.0.1:9222 and target Release notes. The second shows webkit, the browser omp reported.",
        "Expand the task card. ReleaseReader lists two steps under its scout badge, and ReleaseWriter keeps its single task.",
      ].join("\n")],
    },
  ],
};
