export default {
  version: "0.8.4",
  chats: [
    {
      id: "question-form", title: "01 Question form series", pane: "files",
      prompts: [[
        "fixture notes",
        "This chat checks question cards. Send fixture form: the local fixture model asks four release questions in one form. The card shows Question 1 of 4, one question at a time, and no terminal key hints such as Escape cancel.",
        "Choose Beta, then Next question. On Platforms to check, check Linux, then Next question: the card gets shorter for Release note headline, and the chat stays scrolled to the bottom. Choose Previous question: Linux is still checked. Go forward again and choose Skip this question on the headline, which keeps the form's text for it.",
        "On Review depth, choose Quick, then Send answers. omp gets all four answers at once and replies; the ask card lists Beta, macOS, Windows and Linux, the original headline, and Quick.",
        "Send fixture form again and choose Cancel form and stop reply: the form closes without answers, omp stops its reply, and the ask row reads Form was cancelled.",
        "With omp 19.0.0, send fixture form once more and choose Open omp screen while the card waits: omp shows its own question card in its transcript, with no notices about unknown elements. Answer in the app's card.",
      ].join("\n")],
    },
    {
      id: "reply-pictures", title: "02 Pictures in replies", pane: "files",
      prompts: [[
        "fixture embeds",
        "This chat checks pictures and pages in omp's replies. omp's instructions ask the model to show a picture with an <img> tag and a web page with an <iframe> tag, which the app used to show as raw text.",
        "The reply below shows two cards side by side at the width omp asked for: a teal one named by its path relative to this chat's folder and an orange one named by its full path. Click each to open it.",
        "The web image from example.com waits behind Load image. The two pages show as link cards: Fixture page opens the local file, and Example Domain opens example.com in your browser.",
      ].join("\n")],
    },
    {
      id: "earlier-folder", title: "03 File links from an earlier folder", pane: "files",
      prompts: [[
        "fixture earlier-folder",
        "This chat checks file links for a folder the chat used earlier. The local fixture model created earlier-folder-files beside this chat's folder, read a file there by its full path, and then named it as Client Files/Return Email/return-email.txt, relative to earlier-folder-files.",
        "That path is a link in the reply, although the file is not in this chat's folder. Click it: the file opens and shows Subject: Your return label is ready.",
      ].join("\n")],
    },
    {
      id: "side-question", title: "04 Side questions with ?", pane: "files",
      prompts: [[
        "fixture notes",
        "This chat checks omp 19.0.0's side questions. A message that starts with ? goes to omp as a side question, as /btw does. Once omp has started in a chat, the message box says so while you type one.",
        "Send ? fixture notes What should I check first? Side questions opens with the question and the local model's answer, and the chat can take its next message right away. Then type ? and another question in the message box: the note appears under it.",
      ].join("\n")],
    },
  ],
};
