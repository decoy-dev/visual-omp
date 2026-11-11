export default {
  version: "0.7.17",
  expiredSignIn: true,
  chats: [
    {
      id: "expired-sign-in", title: "01 Expired sign-in notice", pane: "files",
      prompts: [[
        "fixture notes",
        "The expired@example.com account is fixture data stored only in this tour's isolated omp auth database.",
        "The warning appears at launch. Open Settings > Providers and confirm the Anthropic account needs sign-in. Relaunch visual-omp and confirm the warning does not repeat.",
      ].join("\n")],
    },
    {
      id: "cfg-save-question", title: "02 Saving a setting", pane: "files",
      prompts: [[
        "fixture notes",
        "Send fixture cfg-save in this chat to open omp's setting-save approval in the chat card. It should appear exactly once, with the setting name formatted as code. The duplicate omp dialog and omp screen should stay closed.",
        "Choose Deny. After the turn finishes, confirm the reply does not say 'Changed 1 file'.",
      ].join("\n")],
    },
    {
      id: "ask-option-notes", title: "03 Ask option notes", pane: "files",
      prompts: [[
        "fixture notes",
        "Use omp 18.18.8 for this check. Send fixture form in this chat; the form is local and makes no model-provider request.",
        "Open the omp screen with Cmd+J. Add a note to the Stable option with omp's Note button or n, then submit the question in omp.",
        "Check that the transcript shows the note under the matching Stable answer. The app's question card should not offer a note control.",
      ].join("\n")],
    },
  ],
};
