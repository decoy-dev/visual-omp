# omp 18.22.0 comparison recordings

`model-switch` was recorded on macOS arm64 on 2026-11-17 with the installed executable reporting `omp/18.22.0`. It is a comparison capture for the [18.15.0 baseline](../18.15.0/README.md), with one raw recording and one byte/CR/SHA-256 integrity manifest.

omp 18.22.0 opens its model switcher above the composer (`anchor: "composer"`, `search: "list"`, `density: "snug"`), adds provider scopes as an icon rail and a Thinking slider (`level`), and declares only its Task/Main toggle (`task`) as an action. The earlier Use and Close actions are gone: Enter or a click picks a row and Esc closes the sheet. The recorder clicks the composer's model control (`status.model`) and activates `fixture/fixture-small`, as in the baseline. The model-tsp tests replay this recording to check that the app picks the exact row without a declared Use action, and closes the switcher without a declared Close action before typed fallback.

`btw-empty`, `btw-ask`, `btw-ask-again`, `btw-follow-up`, `btw-cancel`, `btw-open-main-abort` and `btw-history` were recorded the same day with the same executable. From omp 18.21.0, Tern answers `/btw <question>` in a note in its transcript (`omp.btw.note`) instead of opening the side-question history. The recorder now asks as the app's BTW driver does: it submits `/btw <question>`, waits for the history or a new note, and after a note submits `/btw`, which omp opens on the question it is answering. `btw.test.ts` drives the first six through the production driver and history state, as it does for the 18.15.0 baseline; `btw-history` is kept for comparison and no test reads it yet.

The scenarios use a fresh scratch HOME, agent/config/cache/temp roots and session directory, and the recorder's loopback model. No owner files, credentials or external provider are read. The events files also record the terminal's device-attribute replies, which the model-tsp replay skips; the BTW replay already reads only semantic events.

Record them with the documented recorder bundle and:

```sh
OMP_BIN=/absolute/path/to/omp-18.22.0 VOMP_TSP_FIXTURE_VERSION=18.22.0 VOMP_TSP_FIXTURE_DIR=src/main/omp/tsp/fixtures/18.22.0 node record-tsp.mjs model-switch btw-empty btw-ask btw-ask-again btw-follow-up btw-cancel btw-open-main-abort btw-history
```
