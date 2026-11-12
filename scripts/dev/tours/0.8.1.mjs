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
  ],
};
