export default {
  version: "0.8.1",
  chats: [
    {
      id: "question-form", title: "01 Question form height", pane: "files",
      prompts: [[
        "fixture notes",
        "Send fixture form in this chat. The local fixture provider answers it, and no external model provider is contacted.",
        "Answer Release channel, then Platforms to check. The Release note headline question that follows is shorter, but the card keeps its height: the text box sits under the title, and the hint and buttons stay at the bottom of the card. Check that no empty space is left below the buttons.",
        "Answer the headline question and then Review depth, the last question. The card closes after that answer, with your answers in the transcript.",
      ].join("\n")],
    },
    {
      id: "close-chats", title: "02 Close chats", pane: "files",
      prompts: [[
        "fixture notes",
        "Send fixture helper-work in this chat. omp works here for about 45 seconds, using the local fixture provider.",
        "While it works, open the Current chats menu (the three dots beside Current chats) and choose Close all chats. The dialog lists this chat as working and offers Close idle chats beside Close all chats. Choose Cancel.",
        "If this chat has finished working, send fixture helper-work again. Then choose Select chats in the same menu, check this chat and 03 Spare chat, and choose Close. The dialog asks to close 2 chats; choose Close idle chats. 03 Spare chat closes, this chat stays open, and a message says 1 selected chat stays open.",
        "Close idle chats is also in the Current chats menu and the command palette. Reopen closed chat (⌘⇧T) brings 03 Spare chat back.",
      ].join("\n")],
    },
    {
      id: "spare-chat", title: "03 Spare chat", pane: "files",
      prompts: [[
        "fixture notes",
        "This chat stays idle so the 02 Close chats check has a chat to close.",
      ].join("\n")],
    },
  ],
};
