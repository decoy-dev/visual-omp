export default {
  version: "0.7.16",
  models: [{ id: "second", name: "Second fixture", reasoning: false }],
  chats: [
    {
      id: "grep-patterns", title: "01 Grep patterns", pane: "files",
      files: ["Search samples/alpha.txt", "Search samples/beta.txt"],
      prompts: [[
        "fixture grep-patterns",
        "Use omp 18.18.7 for this tour. The local fixture writes two text files, then runs three grep tool calls with character classes, groups, quantifiers and alternation.",
        "",
        "1. Expand the search calls. Check the regex patterns are highlighted, including [0-9], parentheses, +, {2,3} and |.",
        "2. Check the single-file search for Search samples/alpha.txt does not repeat 1 file. The no-match search should show one 0 matches line.",
      ].join("\n")],
    },
    {
      id: "undo-rewind", title: "02 Undo a rewind", pane: "files",
      prompts: [[
        "fixture notes",
        "Check rewind and Undo in this main chat. Undo requires a restorable prior tree leaf. Send the two marked messages in the app so the chat has a branch to restore.",
        "",
        "1. Send fixture notes First rewind check, wait for its reply, then send fixture notes Second rewind check and wait again. Choose Rewind to here on the first marked message.",
        "2. Choose Undo in the toast. Check the second marked message returns and the omp screen stays closed throughout.",
        "3. Rewind to the first marked message again, then begin a new message. Check Undo disappears when the input or chat state changes. Send fixture notes New branch check and confirm Undo stays gone.",
      ].join("\n")],
    },
    {
      id: "continue", title: "03 Continue", pane: "files",
      prompts: [[
        "fixture notes",
        "Check Continue in this main chat's header menu. Continue requires omp 18.18.2 or later. The fixture timestamps turn runs three separate 45-second waits, so it gives you time to stop it.",
        "",
        "1. Send fixture timestamps. Once the first bash call is running, choose Stop and wait for the turn to stop.",
        "2. Open the main chat's header menu and choose Continue. Check the turn resumes without adding a new user message. Wait for the remaining timestamp rounds and the final reply.",
        "Continue is a main-chat check. Preparation does not keep a turn running.",
      ].join("\n")],
    },
    {
      id: "narrow-helper-cards", title: "04 Helper cards in narrow chats", pane: "files",
      prompts: [[
        "fixture notes",
        "Check the helper row with limited chat width. Preparation cannot keep the six helpers running.",
        "",
        "1. Keep the side panel open, narrow the window and send fixture helpers.",
        "2. While the helpers work, check the visible cards keep their width and extra cards move into the overflow control. Open that control and check it opens Tasks with all six helpers.",
      ].join("\n")],
    },
    {
      id: "shortcut-glyphs", title: "05 Shortcut glyphs and omp screen", pane: "files",
      prompts: [[
        "fixture notes",
        "Check the model notice's shortcut and explicit omp screen controls in this scratch chat. Both fixture models use the local provider with no model credits.",
        "",
        "1. Send fixture notes to start omp. From the composer's model menu, choose Second fixture for this session only.",
        "2. Check the notice shows the shortcut with readable key glyphs and no empty boxes. Switch back to Live preview fixture for this session only and inspect the notice again.",
        "3. Leave any omp error, task list, leftover picker or other output alone. The omp screen should never open automatically, including for rate-limit errors. This policy also applies to classic chats; the local fixture does not produce rate-limit errors.",
        "4. Press Cmd+J to open the omp screen deliberately, then close it. Type /extensions and press Enter; that requested screen should open. Close it to return to the chat. View question in omp screen should also open when a question offers that action.",
      ].join("\n")],
    },
  ],
};
