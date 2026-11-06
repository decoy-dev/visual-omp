import previous from "./0.7.8.mjs";
import toolCards from "./tool-cards-18.17.mjs";

const old = id => previous.chats.find(chat => chat.id === id);
const retain = (id, title, check = "") => ({ ...old(id), title, prompts: old(id).prompts.map((prompt, index) => index ? prompt : prompt + (check ? `\n\n${check}` : "")) });

export default {
  version: "0.7.9",
  // Keep release-specific setup here so later checks need only a chat or prompt addition.
  models: [
    { id: "reasoner", name: "Tour reasoning fixture", reasoning: true, thinking: { mode: "effort", efforts: ["low", "medium", "high", "max"], defaultLevel: "medium", requiresEffort: false } },
    { id: "cache", name: "Tour prompt cache fixture", reasoning: false, promptCache: { short: 12 } },
  ],
  config: { providers: { cacheWarming: "off", cacheRetention: "short" }, skills: { manualSkills: ["tour-manual-*"] } },
  skills: [
    { name: "tour-manual-review", description: "Manual-only release-tour sample.", body: "Reply with the words: Manual skill selected." },
    { name: "tour-catalog-review", description: "Catalog-visible release-tour sample.", body: "Reply with the words: Catalog skill selected." },
  ],
  // Seed an earlier observed version in this disposable profile. Startup observes the
  // installed omp version and uses the normal installed-update notice path.
  updateFixture: true,
  preferences: { ompUpdateNotice: { observedVersion: "18.16.0", pendingVersion: null, acknowledgedVersion: "18.16.0" } },
  chats: [
    {
      ...old("video"), title: "01 Outputs: live video and replacement",
      prompts: [
        "fixture video\nCheck first-use transcript loading after a fresh launch: the composer remains usable and the reply appears without switching chats. In Outputs, play out.mp4, seek and click the key frames. This preparation sends fixture video twice to the same path. For the live check, send fixture video, watch moving content advance before the six-second render finishes, then send fixture video a second time and confirm it replaces the finished video. Pause or seek to stop following, then choose Follow render. With reduced motion, use Load latest video. Send fixture regular-video for an ordinary MP4 that may wait for its final index. Hide or minimize during a render, return and check the newest reply. For Outputs stage height, compare out.mp4 and the tall poster.svg here, the frame sequence in chat 13 and Word in chat 02. Resize the window and pane to make short and tall stages. Large previews should use the available height while preserving proportions and keeping their controls visible. Select frames.png in the live stage's chips to check a compact preview. Compact previews should end after their content so saved outputs follow directly without an empty stage below it. From the saved outputs, open frames.png: its viewer should replace the live stage. Choose Back and check the stage, saved list and image-tile focus return. Open sample.pdf from the saved list and press Escape to return. Check both viewers in a short and a tall pane.",
        "fixture video\nThis second recorded render replaces out.mp4. Replay the two sends in the app to check live rendering and replacement.",
        "fixture png\nThis saved raster image exercises compact stage sizing and the saved-image viewer.",
        "fixture pdf\nThis saved PDF exercises the viewer that replaces the live stage and returns with Back or Escape.",
        "fixture svg\nThis tall poster is the image comparator for the Outputs stage-height checks in the first message.",
      ],
      files: ["out.mp4", "poster.svg", "frames.png", "sample.pdf"],
    },
    retain("docx", "02 Outputs: Word page proportions", "Check Word page proportions and margins at both narrow and wide pane widths. Scroll through the document and confirm pages retain their proportions. The recorded truncated save is restored by the second message; repeat fixture docx to check retention live."),
    retain("xlsx", "03 Outputs: spreadsheet layout", "Check that the spreadsheet fills the available pane height and width. Scroll the fifty-thousand-row grid: both sheet tabs must stay visible. Resize the pane, switch sheets and return. Repeat fixture xlsx for live save retention."),
    retain("html", "04 Outputs: HTML sizing and following", "Open Outputs and send fixture html. Check the desktop-width default and Fit width, 100% and Phone. During writing, the preview follows changed content and briefly marks it when an element can be found. Choose Pause following or click the page to keep your place, let writing finish, then choose Show latest. Changing size also pauses following; scrolling inside the page alone does not. Open page.html from Files, select Preview and repeat the sizing and following checks."),
    retain("helper", "05 Transcript: helper card following", "Send fixture helper and stay at the bottom of the main chat. While TourHelper changes from working to done and its card shrinks, the transcript must remain pinned without a new content below prompt. Repeat, then scroll up with the wheel or keyboard while it runs: following must stop and your place must remain. Return to the bottom to resume. The fixture helper streams its reply slowly so the card can change while you watch. In Tasks, check each helper row has one conversation button, labelled Open TourHelper's conversation for this helper. There is no separate message button; the running helper keeps its independent Stop button. Open the conversation with that single button and send a message from its composer, checking queued delivery while the helper runs and direct delivery when it is idle. If you open a messageable helper before its conversation file exists, check the message No conversation yet. You can still send a message. The composer must remain usable; the conversation should appear after the file is available. This early state can be brief. Check the transcript card and pinned helper also use one conversation entry."),
    {
      id: "composer", title: "06 Composer: settings, tags and keywords", model: "fixture/reasoner",
      prompts: ["fixture notes\nCheck the compact settings row: the permission button shows its mode name, Suggestions has a visible pressed state, and the row scrolls in a narrow window. Shortened account names need multiple stored OAuth accounts; this isolated profile has none. Use a separately approved account-backed chat for that check. Start omp in this chat, type /unpin and confirm it appears in the slash menu on omp 18.17. Type ^fixture/reasoner: and check low, medium, high and max completions; choose one and confirm the text is inserted. Type ultrathink and chillax as standalone prose, inspect their highlights and effect tooltips, and compare inline code and part-word matches. In Settings > Advanced, search for Ultrathink Keyword, turn it off, return and edit the draft: ultrathink loses its highlight while chillax stays highlighted. Restore it afterward. No message needs to be sent for these draft checks."],
    },
    {
      id: "cache", title: "07 Status bar: prompt cache", model: "fixture/cache", expectedCacheRead: 10000,
      prompts: [
        "fixture cache\nEnable Prompt cache in Settings > Appearance or the status bar menu. Start omp here and send fixture cache twice. After the second reply, hover or focus the item: it should predict a cache hit and about 10K cached tokens. Cache warming is off and this fixture model has a twelve-second cache lifetime. Wait at least fifteen seconds without sending again, then inspect the expired miss explanation and the approximate resend size. Send again to restore a hit. The provider reports deterministic cache usage locally; this demonstrates omp's prediction and expiration UI without a paid provider. Preparation alone cannot preserve a live countdown across process exit.",
        "fixture cache\nThe second prepared reply includes cache-read usage. Repeat the two sends after opening the app to inspect the live prediction.",
      ],
    },
    {
      id: "tool-cards", title: "08 Tool cards: recorded LSP and search results", recordedTools: toolCards,
      prompts: ["fixture notes\nThese are recorded fixture examples in omp 18.17's result formats. No language server or web search was contacted. Expand the LSP references card and check both highlighted source previews and their file targets. Check the diagnostics card: one error, one warning, a clean file, an all-server failure, an unverified file and a partial failure remain distinct. The separate hover failure must say the request failed. Expand the search cards and check provider identifiers, reasons and HTTP status codes without hiding the successful fallback answer or its source. The final card records an all-provider failure. These examples check saved result rendering; live server startup and provider requests need separate environments."],
    },
    {
      id: "bash-trace", title: "09 Bash: recovered saved output",
      prompts: ["fixture bash-trace\nExpand all three bash cards. The fixture emits many producers, large values and dense output so collab shortens results. Check that saved output is recovered within display limits and that the artifact line and instructions remain available. Compare the beginning and end where shown. If automatic recovery is unavailable, use Load saved output and check its loading, result and bounded-output explanation. Send fixture bash-trace again to check the live path. This creates local output only and uses no provider credits."],
    },
    {
      id: "settings", title: "10 Settings: manual skills and omp updates",
      prompts: ["fixture notes\nIn Settings > Skills & plugins, check tour-manual-review is labelled Manual only and tour-catalog-review remains in the catalog. The scratch config contains tour-manual-*. Add tour-catalog-* and check its Manual only label, then remove that pattern and check the label clears. Start a new chat or restart omp when checking the changed model catalog; manual invocation must remain available. In Settings > General, toggle omp automatic updates off and back, checking the saved value. In About, open What's new in omp. This scratch profile records omp 18.16.0 as its previous observed version, so startup with 18.17 or later should show the normal installed-update notice. Open its release notes, dismiss it and confirm it stays dismissed; check chat restart actions when a stale running chat is available. The runner also sets VOMP_UPDATE_FEED to this tour's update-feed.json. In About, choose Check for updates, then Update omp. The first simulated attempt prints Another omp update is already running; try again once it finishes. Check that the dialog explains another installer is running and offers Try again instead of reporting success. Choose Try again: the second simulated attempt succeeds, the busy explanation clears and the existing omp version remains installed. Both attempts run only a scratch script; no installer or network command runs. A fresh preparation resets this two-attempt check. Automatic installation and notices after replacing a running engine still need separate checks."],
    },
    {
      id: "office-quit", title: "11 Quit: Office conversion and cancellation", pane: "outputs",
      prompts: ["fixture pptx complete\nRun this check last because confirming Quit closes the development app. LibreOffice is required to exercise conversion; without it, check the prerequisite message and record that conversion could not be tested. Send fixture pptx complete with Outputs open, select office.pptx and request Quit while its conversion is still in progress. Choose Cancel first: the app stays open and the preview can finish. Repeat, request Quit during conversion and confirm Quit: the app should close cleanly, allowing up to six seconds for cleanup. On macOS this checks Quit and Cancel only. The working-folder deletion risk needs the same check on Windows. The fixture does not slow or fake the converter, so repeat if conversion finishes before you request Quit."],
      files: ["office.pptx"],
    },
    retain("colors", "12 Hex swatches and questions"),
    retain("sequence", "13 Outputs: grouped frames"),
    retain("process", "14 Saved process exit replay"),
    { ...old("commands"), title: "15 Other retained release checks", prompts: old("commands").prompts.map(prompt => prompt.replace("Release 0.7.8 checks:", "Retained release checks:")) },
    {
      id: "timestamps", title: "16 Transcript: grouped tool timestamps", timeoutMs: 180_000,
      prompts: ["fixture timestamps\nCheck the collapsed tool group's timestamp as three bash calls finish about 45 seconds apart. Its first time should become a first-to-latest range, such as 10:37-10:40 AM, as the next calls appear. Hover over or keyboard-focus the timestamp to read the full start and latest times. Expand the group and check each call keeps its own timestamp. This prepared chat records all three calls; send fixture timestamps again to watch the range update live. The complete live run takes about two minutes and fifteen seconds and runs only local sleep and date commands."],
    },
    {
      id: "helpers-load", title: "17 Chats: many helpers stay current", timeoutMs: 180_000,
      prompts: ["fixture helpers\nSend fixture helpers to start six helpers that each print a line ten times a second for about 45 seconds. While they run, the transcript, the Tasks pane and the elapsed times should stay current, and the window should keep responding to typing and scrolling; compare the status bar's CPU with 0.7.8 if you have it. Switch to another chat for a few seconds and come back: the helpers should show their latest progress when you return. Open another chat beside this one in split view and check both update. Minimize or hide the window briefly and return. Send fixture colors in another chat while the helpers run: its question card should appear at once. Send fixture helpers again to inspect the live workload; it uses only local echo and sleep commands."],
    },
  ],
};
