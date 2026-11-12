import toolCards from "./tool-cards-18.19.mjs";

export default {
  version: "0.7.19",
  // omp 18.19.0 sends a helper's work one step at a time when `task.steps` is on.
  config: { task: { steps: true } },
  chats: [
    {
      id: "steps", title: "01 Helper steps",
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
      id: "tool-cards", title: "02 Tool cards: omp 18.19.0 formats", recordedTools: toolCards,
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
