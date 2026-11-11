export default {
  version: "0.7.17",
  expiredSignIn: true,
  chats: [
    {
      id: "expired-sign-in", title: "01 Expired sign-in notice", pane: "files",
      prompts: [[
        "fixture notes",
        "The expired@example.com account is fixture data stored only in this tour's isolated omp auth database.",
        "The warning \"Claude needs you to sign in again\" appears at launch. Choose Open Providers and confirm the Anthropic account needs sign-in. Then quit the development app, reopen this tour with the resume command it printed, and confirm the warning does not repeat.",
      ].join("\n")],
    },
    {
      id: "cfg-save-question", title: "02 Saving a setting", pane: "files",
      prompts: [[
        "fixture notes",
        "Send fixture cfg-save in this chat to open omp's setting-save approval in the chat card. It should appear exactly once, with the setting name formatted as code. The duplicate omp dialog and omp screen should stay closed.",
        "Choose Deny. After the turn finishes, confirm the turn summary does not say \"Changed 1 file\".",
      ].join("\n")],
    },
    {
      id: "question-form", title: "03 Question form", pane: "files",
      prompts: [[
        "fixture notes",
        "This tour runs omp 18.18.9. Send fixture form in this chat; the form is local and makes no model-provider request.",
        "Answer the questions in the chat's question card. The omp screen should stay closed, and the card should close when you send the last answer, with your answers in the transcript.",
        "omp records option notes only from its own form. The omp screen in this app shows omp's Note button as unavailable, so saved notes are checked by tests.",
      ].join("\n")],
    },
  ],
};
