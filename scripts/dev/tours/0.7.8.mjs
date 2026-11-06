export default {
  version: "0.7.8",
  chats: [
    {
      id: "video", title: "01 Outputs: video and progress", pane: "outputs",
      prompts: ["fixture video\nOn a fresh app launch, check the first-use transcript loading: the composer should remain usable while the transcript loads, and the reply should appear without switching chats. Check Outputs: play out.mp4, seek and click each key frame. Send fixture video again: the fragmented MP4 should show moving content and advance to newer rendered frames before the six-second render finishes. Send fixture regular-video for the ordinary MP4 case, which may wait for its final index before it can play. Hide or minimize the window during the render, then return and check that the latest reply appears."],
      files: ["out.mp4"],
    },
    ...["docx", "xlsx"].map((kind, index) => ({
      id: kind, title: `0${index + 2} Outputs: ${kind.toUpperCase()} and truncated saves`, pane: "outputs",
      prompts: [
        `fixture ${kind}\nCheck Outputs for Office revisions and the truncated save in this tool card. This recorded run ends with an incomplete file. The next message restores a complete file for startup.`,
        `fixture ${kind} complete\nOpen Outputs and wait for revision 3. Then send fixture ${kind} again while Outputs stays open. An earlier development check found that the last complete revision disappeared after the truncated save and after switching subjects; commit 31704d5 addresses it. Check whether that still occurs: the last complete revision should stay visible after the truncated save, and after you select another output or chat and return to this file. The complete file prepared for startup does not establish revision retention. ${kind === "xlsx" ? "Switch between both sheets and check cached formula values." : "Check the heading, table and embedded image."} Remote assets must stay blocked. Headless generation does not establish preview acceptance.`,
      ],
      files: [`office.${kind}`],
    })),
    {
      id: "html", title: "04 HTML: Watch and Files viewer", pane: "files",
      prompts: ["fixture html\nCheck the Watch button's alignment on the page.html tool card. Open page.html from Files: Preview should render local CSS and the image; Source should show code. Scripts and remote resources must remain blocked. sample.html is also ready in this folder. Send fixture html again to watch the streamed page."],
      files: ["page.html", "style.css", "image.svg"],
      sampleHtml: true,
    },
    {
      id: "colors", title: "05 Hex swatches and questions",
      prompts: ["fixture colors\nCheck swatches in prose and inline code, including alpha transparency. Short hex in prose, issue numbers, URLs, paths and code blocks stay unchanged. Send fixture colors again to open the question with hex options; the prepared question was answered during headless generation."],
      answer: "#2B72E5",
    },
    {
      id: "helper", title: "06 Helper conversation",
      prompts: ["fixture helper\nThis chat contains a fixture-backed helper. Saved helper cards may have no open action. Send fixture helper again, then open TourHelper from Tasks or its live helper card. Check that its type icon matches across the card, Tasks, pinned row and conversation header in light and dark themes. While it runs, its corner badge shows its current activity; after completion, the badge becomes a check and Done remains visible. On the first helper open after a fresh launch, check that the loading state resolves and the conversation appears without reopening it. Check Back and Esc, draft and scroll retention, and a message to the idle helper. This uses the same local server without model credits."],
      helper: true,
    },
    {
      id: "sequence", title: "07 Outputs: grouped frames", pane: "outputs",
      prompts: ["fixture sequence\nCheck that frames/frame0001.png through frame0006.png form one sequence and photo1.png through photo3.png remain separate. Send fixture sequence again to watch the newest frame and frame count update."],
      files: ["frames/frame0006.png", "frames/photo1.png", "frames/photo2.png", "frames/photo3.png"],
    },
    {
      id: "process", title: "08 Saved process exit replay",
      prompts: ["fixture process\nThis example starts a named supervised process which reports readiness, then exits with code 1 while a second command keeps the chat running long enough to record it. Its historical process-exit row should remain in the transcript. Restart omp in this saved chat, send fixture notes, and check that the old Supervised process failed line does not appear again as a new notice below the chat. Repeat after closing and reopening the chat. This deliberately failed sample process requires no provider credentials."],
    },
    {
      id: "commands", title: "09 Settings and command checks",
      prompts: ["fixture notes\nRelease 0.7.8 checks:\n\n1. Right-click the status bar. Toggle optional items and open Arrange status bar. Check that the menu stays within the window. In Settings > Appearance, reorder items; omp status and update notices stay visible.\n2. Choose Auto thinking and send a short message. Inspect the thinking button, menu and optional status item. The local fixture cannot establish omp's model-backed Auto effort selection; check that with a signed-in model separately, with the owner's approval.\n3. Run Export from the command palette and open the resulting HTML. This chat folder contains spaces to exercise the path fallback. Windows still needs its own check.\n4. Toggle Ask omp for a proof before long renders in Settings > General. Start a new chat or restart omp to load the skill. Send fixture proof, inspect its proof and question, choose No, then repeat and choose Yes to render. This deterministic provider exercises the UI; it cannot prove another model follows the skill.\n5. Share this chat, inspect the control-link QR code and scan it on a phone. Sharing requires your explicit action and a network connection. Stop sharing and check guest disconnection.\n6. OAuth account selection requires multiple stored accounts, which this isolated profile deliberately does not copy. Windows ARM64 installer, Scoop migration, packaged isolation and freeze measurements remain separate release checks.\n7. Recorded helper and render replies let you inspect the UI, but they do not reproduce the reported premature-finished incident. Replay fixture helper and fixture video to inspect live completion behavior.\n8. PPTX previews require LibreOffice installed and available to visual-omp. Send fixture pptx complete, open office.pptx in Outputs, check both slides, then send fixture pptx while the preview is open. Verify the last complete revision stays visible after the truncated save and after switching subjects. Without LibreOffice, check the prerequisite message and its file-opening action. This tour does not establish the installed-LibreOffice result.\n\nAll files, configuration and chats for this tour are in its scratch root. The tour does not read the owner's omp profile."],
      folder: "commands with spaces",
    },
  ],
};
