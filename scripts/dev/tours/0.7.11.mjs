// This unpublished sample is deliberately shuffled to exercise the viewer's category order.
const sampleBody = `This is a simulated release-notes sample for the 0.7.11 tour. No update is installed by these checks.

### Highlights

> [!IMPORTANT]
> This is a sample notice. Review the layout, then close the viewer without installing an update.

- **Fixed:** A first sample fix belongs in the Fixed group.
- **Removed:** An obsolete sample option was removed.
- **Improved:** **Review the first sample headline.** This larger row should appear once above the category groups.
- **Changed:** A sample default changed.
- **New:** A sample command was added.
- **Security:** A sample permission check was tightened.
- **Fixed:** **Review the second sample headline.** Its title should omit the final period in the viewer.
- **Improved:** A sample workflow takes fewer steps.
- **Fixed:** A second sample fix keeps its authored order.

### Detailed changes

#### Changed

- This unpublished body is local tour fixture data.
`;

export default {
  version: "0.7.11",
  updateFixture: {
    releases: [{ tag_name: "v0.7.12", name: "Simulated release-notes sample", body: sampleBody, html_url: "https://github.com/decoy-dev/visual-omp/releases", draft: false, prerelease: false, assets: [] }],
  },
  chats: [
    {
      id: "release-notes", title: "01 Release notes: grouped highlights", pane: "files",
      prompts: ["fixture notes\nCheck the release-notes viewer. At release review, the development build must report 0.7.11 and CHANGELOG.md must contain the approved 0.7.11 section. Preparation does not change either file.\n\n1. Open Settings > About > Read release notes, then Past versions and v0.7.11. Check two larger headline rows: Release notes are easier to scan and File mentions support spaced paths. Their titles should have no final period and appear once. The remaining Fixed group has a wrench icon, a count of 1 and the missing-tool-result item. The actual 0.7.11 notes are bundled; this sample feed does not replace them.\n2. Select v0.7.9, then v0.7.0. Check category icons, counts and readable detailed changes; v0.7.0 includes Changed. The tour's VOMP_UPDATE_FEED replaces GitHub, so these versions use bundled notes. In an ordinary development run without that variable, published GitHub bodies are used when available, with bundled notes when missing.\n3. Close the viewer. In About, choose Check for updates, then open Review update from the update notice (the launch check can also show it after about ten seconds). Select This update. v0.7.12 contains the simulated sample; the release under review is 0.7.11. Do not choose an install or Update omp action.\n4. Check the sample Important warning notice above both larger sample headline rows. The rows appear once, with their final title periods removed. Below them, groups must be ordered Security, New, Improved, Changed, Fixed, Removed despite the shuffled feed body. Each group has its category icon; counts are 1, 1, 1, 1, 2, 1 respectively. The two ordinary Fixed items retain their first/second order. Close the viewer."],
    },
    {
      id: "file-mentions", title: "02 File mentions: paths with spaces", pane: "files",
      expectedReply: "The local provider received meeting content from omp's file-mention auto-read.",
      prompts: [
        [
          "fixture mentions setup",
          'The fixture creates a valid Design projects.zip, Meeting notes.md, Client files/Review notes.md and Client files/Review "draft".md in this chat\'s project. The next prepared message verifies that omp\'s fileMention auto-read reaches the local provider.',
          "",
          '1. Start omp here. In an empty composer, type @Meeting and select Meeting notes.md from the @ picker. Expect @"Meeting notes.md" with one chip covering the complete quoted path. Prefix it with fixture mentions and send. The sent message must retain the whole chip/link, and the local reply must confirm meeting content. Click its file link and check that Files opens Meeting notes.md.',
          '2. To find the samples in Finder, use Go > Go to Folder and paste this exact folder path: {{projectPath}}. Alternatively open the project folder in Files and choose Show folder in Finder. Drag Design projects.zip into an empty composer. Expect one @"Design projects.zip" chip. Also drag Meeting notes.md, prefix fixture mentions and send. Check both complete sent-message chips/links and the meeting content receipt. The archive is binary, so a text-content receipt is only expected for Meeting notes.md.',
          '3. In Files, expand Client files and Cmd-click Review notes.md (Ctrl-click on Windows/Linux). Expect one complete @"Client files/Review notes.md" chip. Prefix fixture mentions, send and check the sent chip/link plus the client content receipt.',
          '4. Open the command palette with Cmd+K (Ctrl+K elsewhere), search Meeting notes.md and choose its file result. It inserts the file into this chat\'s composer. Check the quoted chip, prefix fixture mentions, send and check meeting content. Repeat with Client files/Review "draft".md: the mention must use single quotes around the whole path because its name contains double quotes, and the reply must confirm quoted content.',
          "5. omp persists these auto-reads as fileMention messages; visual-omp currently has no separate Read row for that message type. The provider's content receipt confirms readable file contents reached omp's model request. It does not perform a model-backed interpretation of the files. The prepared second message already demonstrates the picker-independent quoted-path read.",
        ].join("\n"),
        'fixture mentions @"Meeting notes.md"',
      ],
      files: ["Design projects.zip", "Meeting notes.md", "Client files/Review notes.md", 'Client files/Review "draft".md'],
    },
    {
      id: "missing-result", title: "03 Tool results: omitted result status", pane: "files", timeoutMs: 180_000,
      prompts: ["fixture bash-trace\nThis local workload records three settled bash calls with many trace producers, large values and dense output. The existing bash-trace fixture can cause collab to shorten or omit entries, but a fully omitted result is conditional on omp's replication limits and saved-result recovery.\n\n1. Start omp here and inspect the prepared calls in Verbose transcript view. Expand their tool group if needed. A shortened result that is still present or recovered from disk can show its normal success status; that does not exercise the missing-result change.\n2. If a settled call has no result and collab shows the too-large-to-replicate notice (collab-entry-too-large), check its neutral mark, the Result unavailable accessible label/tooltip and the bash result unavailable wording. It must not show a success check or a running spinner. Check Normal view as well: the canonical omission notice remains readable.\n3. Send fixture bash-trace again to inspect the live replication path after the turn finishes. If all results remain present or recover, record the omitted-result UI check as unexercised. The focused regressions are src/renderer/src/chat/transcript/ToolCard.test.ts, shows the existing neutral mark for a settled omitted result, and src/renderer/src/chat/transcript/Transcript.test.ts, keeps canonical omission notices without claiming success in normal/verbose view. Preparation checks the saved transcript. Full collab omission requires a separate live check."],
    },
  ],
};
