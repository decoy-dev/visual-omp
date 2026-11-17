// Recorded examples of omp 18.20.0 and 18.20.1 argument and result shapes, without searching any files.
// Sources: coding-agent/src/tools/grep.ts and tui/src/tools/grep.ts (`binaryMatches`, omp 18.20.0), and
// coding-agent/src/tools/todo.ts and tui/src/tools/todo.ts (`task` as a string or an array, omp 18.20.1).
const text = value => [{ type: "text", text: value }];

const phases = done => [
  { name: "Release", tasks: [
    { content: "Check the release notes", status: done.includes("Check the release notes") ? "completed" : "pending" },
    { content: "Check the tour chats", status: done.includes("Check the tour chats") ? "completed" : "pending" },
    { content: "Tag the release", status: "pending" },
  ] },
];

export default [
  {
    name: "grep", args: { i: "Searching the release samples", pattern: "release-sample", path: "." },
    result: {
      content: text("No matches found\nBinary files also match (name one as `path` to search it as text): samples/archive.bin, samples/icon.png"),
      details: { matchCount: 0, fileCount: 0, binaryMatches: ["samples/archive.bin", "samples/icon.png"] },
    },
  },
  {
    name: "grep", args: { i: "Searching the release notes", pattern: "Highlights", path: "." },
    result: {
      content: text("# notes.md\n3:## Highlights\nBinary files also match (name one as `path` to search it as text): samples/archive.bin"),
      details: { matchCount: 1, fileCount: 1, binaryMatches: ["samples/archive.bin"] },
    },
  },
  {
    name: "todo", args: { op: "done", task: ["Check the release notes", "Check the tour chats"] },
    result: { content: text("Marked 2 tasks done."), details: { phases: phases(["Check the release notes", "Check the tour chats"]) } },
  },
  {
    name: "todo", args: { op: "start", task: "Tag the release" },
    result: { content: text("Started Tag the release."), details: { phases: phases(["Check the release notes", "Check the tour chats"]).map(phase => ({ ...phase, tasks: phase.tasks.map(task => task.content === "Tag the release" ? { ...task, status: "in_progress" } : task) })) } },
  },
];
