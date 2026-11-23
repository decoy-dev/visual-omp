// Synthetic examples built in omp 19.1.1's result formats. Preparation runs no nested tools or edit commands.
// Sources in omp v19.1.1: coding-agent/src/tools/tool-commands.ts (ToolCommandDispatch),
// coding-agent/src/tools/bash.ts (BashToolDetails recorder), tui/src/tools/bash.ts (BashToolDetails),
// tui/src/tools/tool-commands.ts (execute and help dispatches), tui/src/tools/edit.ts and
// tui/src/tools/magic-sections.ts (magic edit payloads), and wire/src/index.ts (intent labels).
// App tests: src/renderer/src/tool-render/tools/bash.test.ts, grep.test.ts, job.test.ts, edit.test.ts,
// and src/renderer/src/features/panes/derive.test.ts.
const text = value => value ? [{ type: "text", text: value }] : [];
const grepPath = "src/renderer/src/tool-render/tools/bash.tsx";
const magicInput = [
  "# src/renderer/src/chat/composer/QueueTray.tsx",
  "Keep the sending row visible while omp works.",
  "The section belongs above the message box.",
  "A message with multiple lines uses one row.",
  "",
  "# src/renderer/src/state/session.ts",
  "Clear the row when omp records the message or restores it to the editor.",
  "",
  "# src/renderer/src/chat/composer/QueueTray.tsx",
  "Keep Send message now available on queued messages.",
].join("\n");

export default [
  {
    name: "bash",
    args: { i: "Searching the source: finding the nested tool card", command: `grep --pattern toolCommands --path ${grepPath}` },
    result: {
      content: text(`${grepPath}: const toolCommands = toolCommandRecords(result);`),
      details: {
        exitCode: 0,
        toolCommands: [{
          tool: "grep", mode: "execute", exitCode: 0,
          args: { pattern: "toolCommands", path: grepPath },
          inner: { matchCount: 1, fileCount: 1, scopePath: grepPath },
        }],
      },
    },
  },
  {
    name: "bash",
    args: { i: "Checking tool help: reading the schema", command: "read --help" },
    result: {
      content: text(""),
      details: { exitCode: 0, toolCommands: [{ tool: "read", mode: "help", exitCode: 0 }] },
    },
  },
  {
    name: "edit",
    args: { input: magicInput },
    result: { content: text("") },
  },
  {
    name: "job",
    args: { i: "Polling the tour job: checking its status", poll: ["bg_19_1"] },
    result: {
      content: text("1 job completed."),
      details: {
        jobs: [{
          id: "bg_19_1", type: "bash", status: "completed", label: "grep --pattern toolCommands",
          intent: "Preparing the release: checking recorded output", durationMs: 1840,
          resultText: "The local search found one source line.",
        }],
      },
    },
  },
];
