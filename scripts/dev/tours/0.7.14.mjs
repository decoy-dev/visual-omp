export default {
  version: "0.7.14",
  models: [
    { id: "second", name: "Second fixture", reasoning: false },
    { id: "thinker", name: "Thinking fixture", reasoning: true, thinking: { mode: "effort", efforts: ["low", "medium", "high", "max"], defaultLevel: "medium", requiresEffort: false } },
  ],
  chats: [
    {
      id: "model-switching", title: "01 Switching models reports success", pane: "files",
      prompts: [[
        "fixture notes",
        "Use omp 18.18.7 for this tour. All three fixture models use the local provider and no model credits.",
        "",
        "1. Send fixture notes to start omp. From the composer's model menu, choose Second fixture, then Live preview fixture, then Thinking fixture. Wait for each switch to finish. The selected model should change, no error toast should appear, the model menu should close and the omp screen should stay closed, including brief flashes.",
        "2. Choose Restart omp from the chat menu. Immediately open the composer's model menu and choose Second fixture. Check the selected model changes, no error toast appears, the model menu closes and the omp screen stays closed.",
        "3. Switch to Live preview fixture, then Thinking fixture again, checking the same results after each switch. Send fixture notes and check the chat replies with the selected model.",
      ].join("\n")],
    },
    {
      id: "busy-helpers", title: "02 Busy helpers stay connected on omp 18.18.7", pane: "tasks",
      prompts: [[
        "fixture notes",
        "Use omp 18.18.7 for this tour. Preparation cannot keep helpers running, so start the six local helpers in the app.",
        "",
        "1. Send fixture helpers. Keep this chat open while the helpers work and check that the transcript and Tasks stay current. The chat should stay live throughout, without a lost-connection notice or a Restart omp requirement.",
        "2. After the helpers finish, send fixture notes and check that the chat replies normally and retains its earlier transcript.",
        "A backlog resync happens only when the app falls behind, for example on a slow machine. There is nothing extra to trigger by hand. The automated live test verified rejoining on omp 18.18.7 with a deliberately paused receiver and a request flood; evidence: ~/vomp-checks/collab-backlog/live-18.18.7-count.json. Ordinary helper activity does not establish that a resync occurred.",
      ].join("\n")],
    },
  ],
};
