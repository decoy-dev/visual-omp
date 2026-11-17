import toolCards from "./tool-cards-18.22.mjs";

export default {
  version: "0.8.2",
  models: [{ id: "second", name: "Second fixture", reasoning: false }],
  chats: [
    {
      id: "model-switch", title: "01 Model switch", pane: "files",
      prompts: [[
        "fixture notes",
        "This chat checks model switching with omp 18.22.0's model switcher.",
        "Open the model picker in the composer and choose Second fixture. The picker closes and the composer shows Second fixture. No notice says omp has a menu open.",
        "Send fixture notes to check that the composer accepts a message. Then choose Live preview fixture the same way.",
      ].join("\n")],
    },
    {
      id: "side-questions", title: "02 Side questions", pane: "files",
      prompts: [[
        "fixture notes",
        "This chat checks side questions with omp 18.21.0 and later, which answer them in a note in the chat instead of opening the side-question history.",
        "Send /btw fixture notes What should I check first? Side questions opens with the question, and the local fixture model's answer appears there.",
        "Ask a second question from the Side questions field, such as fixture notes Anything else? It appears under the first one.",
      ].join("\n")],
    },
    {
      id: "plan-review", title: "03 Plan review", pane: "files",
      prompts: [[
        "fixture notes",
        "This chat checks the plan card with omp 18.22.0's plan review.",
        "Send /plan fixture plan-review. omp enters plan mode, and the local fixture model writes a short plan and submits it. The plan card offers Approve and run, Approve and compact first, More options and Save plan as….",
        "Choose Save plan as…. The omp screen opens on omp's Save plan prompt; save the plan. The card comes back with the same review.",
        "Choose More options, then Refine with a comment, type a comment and send it. The review closes, plan mode stays on and the comment goes to omp.",
        "Send fixture plan-review to get a new review, then choose Approve and run. The card gives way to a status line and the local model replies once.",
      ].join("\n")],
    },
    {
      id: "commands-and-cards", title: "04 Commands and tool cards", recordedTools: toolCards, pane: "files",
      prompts: [[
        "fixture notes",
        "Type / in the composer. The menu lists /commit with \"Commit only the changes this agent and its subagents made\" and does not list /seance, which omp 18.20.3 removed.",
        "The cards below are recorded examples in omp 18.20's formats. No files were searched.",
        "Expand the first grep card. It reports 0 matches and warns \"binary matches: 2 files\". The second shows its one match and \"binary matches: 1 file\".",
        "The first todo card names 2 tasks in its summary and lists both as done. The second names Tag the release.",
      ].join("\n")],
    },
  ],
};
