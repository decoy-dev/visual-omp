// A git repository with one committed file and an uncommitted change, for the Git card and omp's /git app.
const gitSample = longLine => [
  "git init -q",
  "git checkout -q -b tour-sample",
  "printf 'Release notes\\n' > notes.md",
  "git add notes.md",
  "git -c user.name=Tour -c user.email=tour@example.invalid commit -q -m 'Add release notes'",
  longLine
    ? `printf '%s\\n' '${"This line is long on purpose, so the diff has to wrap it to show the whole change. ".repeat(4).trim()}' >> notes.md`
    : "printf 'One more line\\n' >> notes.md",
].join(" && ");

export default {
  version: "0.8.3",
  chats: [
    {
      id: "robot-mark", title: "01 Robot mark", pane: "tasks",
      prompts: [[
        "fixture notes",
        "This chat checks the status mark while omp waits for its helpers.",
        "Send fixture helpers. omp starts six helpers and then ends its own reply while they work. Watch this chat's row in Current chats: once omp's reply ends, the spinning mark turns into a pulsing robot, without reloading the app. The chat header says Waiting for background jobs.",
        "The helpers work for about 45 seconds. When their results come back, omp starts a new turn in this chat: the row shows the spinner while omp replies, and then the finished mark.",
      ].join("\n")],
    },
    {
      id: "busy-a", title: "02 Busy chat A", pane: "files",
      prompts: [[
        "fixture notes",
        "This chat and 03 Busy chat B check that the sidebar keeps its order while omp works. Each is in its own project.",
        "Send fixture helper-work here, then open 03 Busy chat B and send fixture helper-work there too. Each keeps omp working for about 45 seconds.",
        "While both work, watch the Projects list: busy-a and busy-b keep their places instead of trading the top spot. Each chat's rows show a brief teal wash when omp adds to that chat, such as when a command starts or ends. The chat you are viewing shows none.",
        "When both finish, send fixture notes in the chat whose project is lower in the list. That project moves to the top once, because you sent it a message, and its row's time shows that message.",
      ].join("\n")],
    },
    {
      id: "busy-b", title: "03 Busy chat B", pane: "files",
      prompts: [[
        "fixture notes",
        "The second chat for the 02 Busy chat A check. Send fixture helper-work here when 02 asks.",
      ].join("\n")],
    },
    {
      id: "project-page", title: "04 Project page", pane: "files", setup: gitSample(false),
      prompts: [[
        "fixture notes",
        "This chat's folder, project-page, is a git repository with one changed file. Choose project-page in the Projects list to open its project page.",
        "The page has the gray page background, like Home. The header shows the folder icon, the name and the path with Copy and Show in folder. Chats is the first card, with this chat in it. When the window is wide enough, Instructions and settings and Git appear in one row below it. Start from an example comes last.",
        "The Git card shows the branch tour-sample and 1 file changed, with the lines added and removed. Give the project a folder color from its menu in the sidebar: the folder icon in the page header takes the color.",
        "Make the window narrow: the two cards stack, and long names and paths wrap.",
      ].join("\n")],
    },
    {
      id: "color-themes", title: "05 Color themes", pane: "files",
      prompts: [[
        "fixture notes",
        "This chat checks color themes. Open Settings, Appearance and find Colors.",
        "Choose Ocean, then Plum: the whole app changes, including the sidebar, buttons, links and this chat. Switch Theme to Dark and back: each preset has its own dark colors, and the editor follows the mode on screen.",
        "With Ocean selected, change the Accent color with its color well or by typing a hex value such as #cc3366. A theme called My Ocean appears in the list, selected, and the app shows the new accent right away. The reset arrow beside Accent returns it to Ocean's.",
        "Set the Sidebar color to a light gray such as #e8edf3: the sidebar text turns dark so it stays readable. Set Text to a pale gray such as #9aa3ad: a warning lists the pairs that fall below 4.5:1.",
        "From My Ocean's menu, rename it, duplicate it and delete the copy; Undo in the message brings the copy back in its place. Choose Teal to return to the default when you finish.",
      ].join("\n")],
    },
    {
      id: "question-form", title: "06 Question form", pane: "files",
      prompts: [[
        "fixture notes",
        "This chat checks question cards. Send fixture form: the local fixture model asks a few release questions in one form.",
        "Answer Release channel. On Platforms to check, check and uncheck a box: the card keeps its height. Then choose Send choices. The next question, Release note headline, is shorter, and the card shrinks to fit it instead of keeping the taller card's height. The chat stays scrolled to the bottom.",
        "Answer the remaining questions; the card closes after the last answer.",
        "Then send fixture form-context. Above the first question, the card shows the form's introduction, a Proposals heading, a numbered list of three proposals with a link to the preview guide, and the group's name, Pick three to build. Each option shows its description under its name. The link opens example.com in your browser.",
        "Choose three options and Send choices. The Review note question shows only its own line, Add a note for the proposal review, and the card gets shorter.",
      ].join("\n")],
    },
    {
      id: "new-chat-folder", title: "07 Folder for new chats", pane: "files", setup: "mkdir -p rename-me",
      prompts: [[
        "fixture notes",
        "This chat checks Folder for new chats. Open Settings, General: under Chats, Folder for new chats names the folder New chat uses. Choose… sets it, and Use default clears it.",
        "On Home, the folder menu under the message box has Use for new chats for the folder it shows. Choose New chat in the sidebar: the new chat starts in that folder.",
        "To check a missing folder, choose Choose… in Settings and pick the rename-me folder inside this chat's folder, {{projectPath}}. Rename rename-me in Finder, then choose New chat: nothing starts, and a message offers Choose… and Use default. Choose Use default to finish.",
      ].join("\n")],
    },
    {
      id: "diff-wrap", title: "08 Diff wrap", pane: "files", setup: gitSample(true),
      prompts: [[
        "fixture notes",
        "This chat's folder is a git repository whose one changed line is long. Choose Open omp screen in the composer and send /git there.",
        "In omp's git app, open the change to notes.md. The long line wraps to the screen's width, as omp draws it. Turn Wrap lines off in the git app: the line stays on one row and scrolls sideways.",
      ].join("\n")],
    },
  ],
};
