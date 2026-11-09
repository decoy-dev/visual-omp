export default {
  version: "0.7.12",
  // Keep almost nothing verbatim, so a short fixture chat still has earlier context to hand off.
  config: { compaction: { keepRecentTokens: 1 } },
  chats: [
    {
      id: "handoff", title: "01 Handoff progress and documents", pane: "files",
      prompts: [
        "fixture notes\nCheck what /handoff and /compact show while omp works and after it finishes. The local fixture model takes about eight seconds to write a handoff.\n\n1. Type /handoff and press Enter. While omp writes the handoff, the row above the composer should read Generating handoff… with a running time and a Stop button, and the chat header should say the same.\n2. When it finishes, a Handed off row should open to the handoff document with a Copy button, and no separate Session compacted notice should appear. Copy it and paste it anywhere to check the text.\n3. Send another message, type /handoff again and choose Stop while it runs. omp should report Handoff cancelled and the chat should stay as it was.\n4. Send another message, then type /compact. omp may compact this short chat locally in an instant; check that the Context summarized row opens to its summary.\n5. Close and reopen this chat from the sidebar. Earlier Handed off rows stay closed until you open them.",
        "fixture notes\nThis second message gives omp enough conversation to hand off.",
      ],
    },
    {
      id: "helper-cards", title: "02 Helper cards above the composer", pane: "tasks",
      prompts: [
        "fixture notes\nCheck the compact helper cards. Helpers cannot stay running across preparation, so start them here.\n\n1. Send fixture helpers. Six local helpers start, each running a 45-second command.\n2. Above the composer, one thin row should show at most four cards (fewer when the window is narrow or text is larger), each with the helper's name, a running time and Stop, and no task text. A +N button counts the helpers that do not fit, and See all tasks at the far right opens the Tasks panel.\n3. When a helper starts a new tool call or reports activity, its card shows a brief teal cue. With Reduce motion on in System Settings > Accessibility > Display, the cue is a short fade without movement.\n4. Choose Stop on one card; that helper stops and its card leaves the row. Narrow the window or enlarge text in Settings > Appearance and check the row keeps names readable, with +N absorbing the rest.\n5. When all helpers finish, the row closes.",
      ],
    },
  ],
};
