export default {
  version: "0.7.13",
  models: [
    { id: "second", name: "Second fixture", reasoning: false },
    { id: "thinker", name: "Thinking fixture", reasoning: true, thinking: { mode: "effort", efforts: ["low", "medium", "high", "max"], defaultLevel: "medium", requiresEffort: false } },
  ],
  extensions: [{
    name: "reset-question",
    source: `export default function (omp) {
  omp.registerCommand("reset-question", {
    description: "Show a synthetic saved-reset question for the release tour.",
    handler: async (_args, ctx) => {
      const choice = await ctx.ui.select(
        "Spend a saved Claude rate-limit reset?\\nwork@example.com (Example): a saved reset covers Claude 5h with about 1h45m left.",
        [
          { label: "Yes", description: "Redeem now and remember yes for future eligible Claude resets." },
          { label: "No", description: "Do not auto-redeem saved Claude resets." },
        ],
      );
      ctx.ui.notify("Reset question choice: " + (choice ?? "Cancelled") + ". No reset was redeemed.", "info");
    },
  });
}
`,
  }],
  chats: [
    {
      id: "model-switching", title: "01 Switching models keeps the omp screen closed", pane: "files",
      prompts: [[
        "fixture notes",
        "Check model changes and rewinding from this chat. All three fixture models use the local provider.",
        "",
        "1. Start omp by sending fixture notes. From the composer's model menu, choose Second fixture, then Live preview fixture, then Thinking fixture. Wait for each switch to finish. The omp screen should stay closed throughout, including brief flashes.",
        "2. With Thinking fixture selected, change Thinking to High. The omp screen should stay closed.",
        "3. Send fixture notes First rewind check, wait for the reply, then send fixture notes Second rewind check and wait again. On the last sent message, choose Rewind to here. The omp screen should stay closed.",
        "4. Type /extensions and press Enter. The omp screen should open immediately because you requested it. Close the screen to return to the chat.",
      ].join("\n")],
    },
    {
      id: "helper-conversations", title: "02 Helper conversations are clearly marked", pane: "tasks",
      prompts: [[
        "fixture notes",
        "Check the helper conversation's name and return controls. Preparation cannot keep helpers running, so start them in the app.",
        "",
        "1. Send fixture helpers. In Tasks, use Open TourWorker1's conversation on its helper row.",
        "2. Check the teal band names TourWorker1 and this parent chat, 02 Helper conversations are clearly marked. The small Back button has a left arrow; hover over it and check the tooltip says Back to 02 Helper conversations are clearly marked.",
        "3. Check the message box is labeled Message helper TourWorker1 and the chat header says Parent chat: 02 Helper conversations are clearly marked.",
        "4. Choose Back. You should return to this chat and its composer.",
      ].join("\n")],
    },
    {
      id: "files-and-commands", title: "03 File rows and command results", pane: "files",
      files: ["Large Media Files/Large video.mp4", "Large Media Files/Large image.png", "Large Media Files/Large document.pdf", "Large Media Files/Large notes.txt"],
      expectedReply: "Created the files in `Large Media Files/`:\n\n- `Large video.mp4`\n- `Large image.png`\n- `Large document.pdf`\n- `Large notes.txt`",
      prompts: [[
        "fixture bigmedia",
        "Check project-relative file rows, /stats and model loading.",
        "",
        "1. In the reply, check each file row shows a project-relative path such as Large Media Files/Large notes.txt. No row should show the full scratch path. Click one file row and check its file opens in the side-panel viewer.",
        "2. Type /stats and press Enter. Check the result shows the dashboard address with Copy URL. The result should have no duplicate Open dashboard line.",
        "3. Choose Restart omp from the chat menu, then immediately open Settings > Models & roles. While the model list loads, no role should show This model isn't available. Pick another one. Repeat if the list loads before you can inspect it; preparation does not establish this timing check.",
      ].join("\n")],
    },
    {
      id: "form-finish", title: "04 Finishing a form question", pane: "files",
      prompts: [[
        "fixture notes",
        "Check that the question card closes without jumping after the last answer. This check requires omp 18.18.3 or later. Preparation cannot keep a question open, so ask it in the app.",
        "",
        "1. Send fixture form. Answer Release channel, Platforms to check, Release note headline and Review depth in the question card.",
        "2. Watch the card as you send the last answer. It should close without jumping or briefly changing its position or size.",
        "3. Check the ask row records all four answers and the chat accepts another fixture notes message. Repeat fixture form if you need to watch the last answer again.",
      ].join("\n")],
    },
    {
      id: "omp-question", title: "05 omp questions stay in the chat card", pane: "files",
      prompts: [[
        "fixture notes",
        "Check a multi-line omp question with described options. The tour's /reset-question extension uses a synthetic account and only reports your choice. It redeems no reset and changes no account preference. This check requires omp 18.18.6 or later.",
        "",
        "1. Type /reset-question and press Enter. A question card should ask Spend a saved Claude rate-limit reset? with the work@example.com (Example) detail and described Yes and No options. The omp screen should stay closed.",
        "2. Answer Yes in the card. The card should close and a notice should say Reset question choice: Yes. No reset was redeemed.",
      ].join("\n")],
    },
  ],
};
