export default {
  version: "0.7.12",
  // Keep almost nothing verbatim, so a short fixture chat still has earlier context to hand off.
  config: { compaction: { keepRecentTokens: 1 } },
  // Rollback samples: two earlier local "releases" whose installers are the provider's 26-byte /health response, with
  // its real SHA-256, so the verified download-only path runs without a published installer. The +rollback-tour build
  // metadata keeps the sample file names apart from real installers. The brew command refuses to run anything.
  updateFixture: {
    method: "brew",
    brewCommand: "printf 'This local tour does not run Homebrew.\\n'; exit 1",
    ompUpdate: false,
    pendingUpdate: { method: "brew", from: "0.7.10+rollback-tour", to: "0.7.12" },
    releases: ["0.7.12", "0.7.11+rollback-tour", "0.7.10+rollback-tour"].map(version => ({
      tag_name: `v${version}`,
      name: `Local rollback sample v${version}`,
      body: `This is local rollback tour data for v${version}. No published installer is included.\n\n### Fixed\n\n- The rollback tour checks version selection and a verified download-only sample.`,
      html_url: "{{fixtureHealth}}",
      draft: false,
      prerelease: false,
      assets: version === "0.7.12" ? [] : ["arm64", "x64"].map(arch => ({
        name: `visual-omp-${version}-mac-${arch}.dmg`,
        browser_download_url: "{{fixtureHealth}}",
        size: 26,
        // SHA-256 of the provider's exact /health body, {"fixture":"live-preview"}.
        digest: "sha256:b98a5ff70759f05a119edb9137a81489cb7dde0dbce8cfe6fbf866ad37659db2",
      })),
    })),
  },
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
    {
      id: "rollback", title: "03 Roll back to an earlier version", pane: "files",
      prompts: [[
        "fixture notes",
        "Check rollback in this development build, which pretends to be a Homebrew copy. Settings > About must report v0.7.12. The installed Homebrew copy is separate and stays unchanged. The two earlier releases are local samples; their installer is 26 bytes of fixture data with an installer name, so never open or install it.",
        "",
        "1. Right after the build opens, the notice says visual-omp is now v0.7.12. Choose Roll back to v0.7.10+rollback-tour within five seconds. Past versions should open with v0.7.10+rollback-tour selected. If the notice disappears first, quit this development build and run npm run tour -- --resume with this tour root to show it again.",
        "2. Close the viewer. Open Settings > About and choose Roll back…. Past versions should open with v0.7.11+rollback-tour selected. The Homebrew steps should explain uninstalling without --zap, keeping app data, and returning with brew install --cask decoy-dev/tap/visual-omp. Read them without running them.",
        "3. Choose Download v0.7.11+rollback-tour installer. Cancel should start focused, and the confirmation should say the app downloads, verifies and reveals the installer and that you choose when to install it. Choose Cancel; nothing downloads.",
        "4. Choose the download again and confirm. Expect Verified installer saved to and the file name, with Finder showing the file in this tour's scratch Downloads folder (app-profile/Downloads in the tour root) without opening it. Do not open the file.",
        "5. Close the viewer. About should say automatic checks skip updates through v0.7.12. Open Roll back… again: v0.7.11+rollback-tour is still selected. Select v0.7.10+rollback-tour and check its confirmation names that version, then Cancel. Repeat the About checks in the other theme.",
        "6. This build cannot show a real installer replacing visual-omp, Windows Explorer and NSIS behavior, or Scoop installs. Checksum rejection and boundary restoration have separate headless evidence in ~/vomp-checks/rollback-0712/.",
      ].join("\n")],
    },
    {
      id: "ask-form", title: "04 Questions as forms (omp 18.18.3)", pane: "files",
      prompts: [
        "fixture notes\nomp 18.18.3 asks questions as one HTML form. Questions cannot stay open across preparation, so send them here.\n\n1. Send fixture form. omp asks four release questions: a radio group, a checkbox group, a text field and a list. The chat's question card should ask them one at a time, with the preselected answers chosen, and the omp screen should not open for the same form.\n2. Answer each question. For Release channel, choose Other and type a custom channel to check the free-text Other answer. Send the answers once.\n3. The ask tool row in the transcript should show each question with the answer you gave, and none should say the form was invalid.\n4. Send fixture colors. The hex colors in the question and options show swatches.\n5. Older chats saved before omp 18.18.3 still show their questions and answers in the earlier list format.",
      ],
    },
    {
      id: "large-media", title: "05 Large local files in Files", pane: "files",
      files: ["Large video.mp4", "Large image.png", "Large document.pdf", "Large notes.txt"],
      prompts: [
        "fixture bigmedia\nThis chat's folder now holds four local files larger than the Files viewer used to accept. Files shows their sizes as 57.2 MB, 22.0 MB, 104.0 MB and 3.1 MB.\n\n1. In the Files pane, open Large video.mp4. It should play, and you should be able to seek to the end; it previously said the file was too big to preview.\n2. Open Large image.png. It should show a teal and pink checkerboard.\n3. Open Large document.pdf. It should open to one page titled Large PDF preview.\n4. Open Large notes.txt. The viewer shows its first 2 MB with a note that the rest is not shown, and an Open in another app action.\n5. Close each view; reopening should load again without delay messages or errors.",
      ],
    },
    {
      id: "slash-feedback", title: "06 Slash command results stay in the chat", pane: "files",
      prompts: [
        "fixture notes\nCheck that slash commands report back in this chat. Before this release several of them printed only inside omp's own screen or opened it unexpectedly.\n\n1. Type /tools. A command result row should show omp's tool report with its title, its table formatted, and the omp screen should not open.\n2. Repeat with /changelog, /jobs full and /advisor status. Each should become its own result row. Expand the changelog with Show all, then hover over a result row and dismiss it.\n3. Type /stats. The result should keep the local dashboard address, with Copy.\n4. Type /clear. The result should say what omp reset, in this chat.\n5. Type /ssh list. The result row should show omp's host list or its empty message.\n6. Type /cleanse. This folder has no checker, so omp asks what to detect and fix, and that question opens in the omp screen. Choose Cancel: the screen closes and the chat keeps a No runnable checker result row.",
      ],
    },
    {
      id: "large-chat", title: "07 Large chat: start over with a handoff", pane: "files",
      // Just over the app's 32 MiB large-chat threshold, as extension state omp keeps out of the model's context.
      padBytes: 33 * 1024 * 1024,
      prompts: [
        "fixture notes\nThis saved chat is padded past 32 MB, so sending a message here asks whether to resume it.\n\n1. Type a message such as Continue with the release checks and send it. The Resume this large chat? dialog opens with Bring a handoff and my message to the new chat checked.\n2. Choose Start new chat. A new chat opens in the same folder at once, with a row reading Writing a handoff from this chat's title, a running time and Cancel. The fixture model takes about eight seconds.\n3. When it finishes, the new chat sends one message: a mention of the handoff file followed by your message. The handoff is saved in the old chat's session folder, and omp reads it from the mention.\n4. Return here, send another message, choose Start new chat again and Cancel while the handoff is written. Your message stays as the new chat's draft, and the row above the composer offers Send without handoff and Try again.\n5. Repeat once with the checkbox cleared: the new chat opens empty and your message stays unsent here, as before this release.",
      ],
    },
  ],
};
