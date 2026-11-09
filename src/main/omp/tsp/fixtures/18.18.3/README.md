# omp 18.18.3 HTML ask recording

`ask-html-form` was recorded on macOS arm64 on 2026-11-09 with the installed `/Users/chrishaddox/.bun/bin/omp`, reporting `omp/18.18.3`. The corresponding source is upstream tag `v18.18.3`, commit `21f1188cf88b2f534c092181968cd5a4d1a9c296`. The executable was not independently rebuilt from that source.

The scenario uses the existing Node fixture recorder and scripted loopback provider. A fresh isolated HOME, agent directory, configuration, cache, temporary directory and session directory exclude owner credentials and sessions. No Electron process or external provider is used. The assistant calls `ask` once with an HTML form containing a preselected radio group, a preselected checkbox group and a prefilled text input. An attached production collab guest answers both groups through Other, toggles an additional checkbox, finishes the checkbox group and replaces the text input.

The standard raw stream, journal, decoded-message, emitted-event and integrity files follow the [18.15.0 format](../18.15.0/README.md). The provider file records the two scripted model requests, and the collab file contains the finished transcript. `ask-html-form.ask.json` adds staged TSP surfaces and collab requests, plus the complete saved session JSONL. Its eight stages contain seven field-by-field requests and the answered state. The saved session contains one ask call and one tool result.

The native form is a dock column under `omp.editor.ask`, containing `omp.ask.form`. It uses existing kinds and remains unchanged while guest requests advance. The Other editors use the field question as their title, without the legacy custom-answer prefix. The guest's checkbox markable count includes Other. Result details contain `answers[]` with name, question and plain-text answer fields.

Bundle the recorder with the [baseline command](../18.15.0/README.md#re-recording), then run:

```sh
OMP_BIN=/absolute/path/to/omp VOMP_TSP_FIXTURE_VERSION=18.18.3 VOMP_TSP_FIXTURE_DIR=/tmp/vomp-ask-1818 node record-tsp.mjs ask-html-form
```

Node must execute the recorder. This scenario completes its scripted turn and exits normally. The recorder deletes its scratch profile after capture. Timeout details, empty answers, media alt text and additional control types are covered by synthetic renderer tests rather than this recording.
