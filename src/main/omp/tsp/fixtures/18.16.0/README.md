# omp 18.16.0 rejected-image recording

`image-reject` was recorded on macOS arm64 on 2026-11-03 with the standalone executable `/tmp/omp-18.16/omp-darwin-arm64`, reporting `omp/18.16.0`. It is a comparison capture for the [18.15.0 baseline](../18.15.0/README.md), with one raw recording and one byte/CR/SHA-256 integrity manifest. The executable was not independently reproduced from upstream source.

The recorder creates the exact 78-byte bad-CRC PNG from the reported standalone paste failure, using the base64 bytes embedded in `record-fixtures.ts`. It seeds `Keep café 🧭 draft` with UTF-16 cursor 5 through public TSP edit, clears that editor and pastes `./live-check.png`. omp inserts the unreadable path as text and reports `Failed to read pasted image path`. Production attachment recovery replaces that text with the original draft and cursor through another len-checked public edit, then the recorder submits `/exit`. No attachment submit action is emitted.

The scenario uses a fresh scratch HOME, agent/config/cache/temp roots and session directory. It configures only the recorder's loopback model with an empty response script; `image-reject.provider.json` records zero requests. No owner files, credentials or external provider are read. The relative image path preserves UTF-16 offsets through privacy sanitization. This capture records no autocomplete popup; constructed input tests cover restoration while a failed absolute path's autocomplete is open.

The six scenario files use the same journal, raw stream, decoded messages, emitted events, integrity manifest and provider-request formats documented by the baseline. Record this subset with the documented recorder bundle and:

```sh
OMP_BIN=/tmp/omp-18.16/omp-darwin-arm64 VOMP_TSP_FIXTURE_VERSION=18.16.0 VOMP_TSP_FIXTURE_DIR=src/main/omp/tsp/fixtures/18.16.0 node record-tsp.mjs image-reject
```
