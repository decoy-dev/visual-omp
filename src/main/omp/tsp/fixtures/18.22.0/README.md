# omp 18.22.0 comparison recordings

`model-switch` was recorded on macOS arm64 on 2026-11-17 with the installed executable reporting `omp/18.22.0`. It is a comparison capture for the [18.15.0 baseline](../18.15.0/README.md), with one raw recording and one byte/CR/SHA-256 integrity manifest.

omp 18.22.0 opens its model switcher above the composer (`anchor: "composer"`, `search: "list"`, `density: "snug"`), adds provider scopes as an icon rail and a Thinking slider (`level`), and declares only its Task/Main toggle (`task`) as an action. The earlier Use and Close actions are gone: Enter or a click picks a row and Esc closes the sheet. The recorder clicks the composer's model control (`status.model`) and activates `fixture/fixture-small`, as in the baseline. The model-tsp tests replay this recording to check that the app picks the exact row without a declared Use action, and closes the switcher without a declared Close action before typed fallback.

The scenario uses a fresh scratch HOME, agent/config/cache/temp roots and session directory, and the recorder's loopback model. No owner files, credentials or external provider are read. The events file also records the terminal's device-attribute replies, which the replay skips.

Record it with the documented recorder bundle and:

```sh
OMP_BIN=/absolute/path/to/omp-18.22.0 VOMP_TSP_FIXTURE_VERSION=18.22.0 VOMP_TSP_FIXTURE_DIR=src/main/omp/tsp/fixtures/18.22.0 node record-tsp.mjs model-switch
```
