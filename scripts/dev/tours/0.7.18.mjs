export default {
  version: "0.7.18",
  chats: [
    {
      id: "many-files",
      title: "01 Many changed files",
      pane: "outputs",
      files: [
        ...Array.from({ length: 2200 }, (_, index) => `Many small files/file-${String(index + 1).padStart(4, "0")}.txt`),
        "Many small files/preview.svg",
      ],
      prompts: [[
        "fixture many-files",
        "The local fixture writes 2,200 small files and one SVG in a subfolder while a background bash command streams its progress and then ends.",
        "While it runs, type a short draft in the message box and check that typing stays responsive and the window does not freeze. Leave the draft unsent.",
        "Open Outputs and confirm the SVG appears as a visual file. Check that the background bash command stops showing as running after it ends.",
        "The command output includes several https:// addresses. Confirm they are not listed as files.",
      ].join("\n")],
    },
  ],
};
