import toolCards from "./tool-cards-19.1.mjs";

export default {
  version: "0.8.5",
  config: { display: { shellVisualization: true } },
  chats: [
    {
      id: "send-now-tray", title: "01 Send now tray", pane: "files",
      prompts: [[
        "fixture notes",
        "To check the Send now section's overflow, send `fixture helper-work` to start a local bash loop that runs for about 45 seconds.",
        "While it runs, use ⌘↵ to send four one-line messages: `Check the queue.`, `Check the next tool step.`, `Read the job output.`, and `Confirm the last message.`",
        "The section titled `Sending 4 messages at omp's next step.` shows three rows with a pulsing dot and `Sending next`. Choose `Show 1 more` to reveal the fourth row, then choose `Show fewer messages` to return to three.",
        "Wait for the loop to finish, then send `fixture helper-work` again. While the second loop runs, use ⌘↵ to send these two lines:",
        "Check the running step.",
        "Restore both lines after Escape.",
        "The two-line message appears as one row in `Sending at omp's next step.` with a pulsing dot and `Sending next`. It stays visible until omp records it in the chat.",
        "Open the omp screen with ⌘J and press Escape while the row waits. omp returns the text to its editor, visual-omp restores both lines to the composer, and the row clears.",
      ].join("\n")],
    },
    {
      id: "plan-review-191", title: "02 Plan review with omp 19.1", pane: "files",
      prompts: [[
        "fixture notes",
        "This chat checks omp 19.1 plan review. Send `/plan fixture plan-review`. The fixture writes a short plan and submits it with omp's `propose` command.",
        "The plan review card offers Approve and run and Approve and compact first. Open More options and confirm Refine with a comment is available. Choose Save plan as… and cancel the file name form. Then choose Approve and run. The model replies once.",
      ].join("\n")],
    },
    {
      id: "bash-step-mode", title: "03 Bash step mode", pane: "files",
      prompts: [[
        "fixture bash-visualization",
        "This chat's saved bash calls open as history, which shows no live step output. Send `fixture bash-visualization` again and expand the third bash call of the new reply, which runs a loop.",
        "Click a step in its command view. The step is highlighted, and its output replaces the bash run output below the Folder and Exit badges. Choose Show all output to return to the full bash run output.",
        "Use the Left and Right arrow keys to move between the row's targets, and press Enter or Space to choose one. An expandable chip, if the row has one, expands without selecting a step. Confirm Replay remains available on the card.",
      ].join("\n")],
    },
    {
      id: "nested-tools", title: "04 Nested tools and intent labels", recordedTools: toolCards, pane: "files",
      prompts: [[
        "fixture notes",
        "The cards below are synthetic examples built in omp 19.1.1's result formats. Preparation ran no nested tools and did not edit project files.",
        "Expand the first bash card to inspect its nested grep card. The bash card label reads Searching the source. The next bash card shows a `read --help` row.",
        "The edit card shows Markdown descriptions under its `# <path>` sections and combines repeated sections for one path. The completed job row shows Preparing the release, the label before the first colon in its intent.",
      ].join("\n")],
    },
    {
      id: "question-card-screen", title: "05 Question card with omp 19", pane: "files",
      prompts: [[
        "fixture notes",
        "Send `fixture form` to open omp 19's question card. While it waits, open the omp screen with ⌘J.",
        "Fold and reopen the card. Choose Beta with one of its option buttons and confirm the app's question card shows that choice. Choose Answer this question, then answer in the app's question card.",
      ].join("\n")],
    },
  ],
};
