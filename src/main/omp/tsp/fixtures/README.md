# TSP recordings

The current baseline is [omp 18.15.0](18.15.0/README.md), upstream commit `3fedf8d53267e32a6d7521ce725fdcc4a36fdc67`. It contains 38 isolated no-model recordings, including the BTW overlay that previously had a separate byte-only fixture. All raw streams use the recorder's privacy sanitizer and byte/CR/SHA-256 integrity manifests.

`extension/` contains the explicitly loaded test extension and synthetic session input used by the recorder. No recording uses the owner's HOME, credentials or installed omp. The versioned README documents configuration, interactions, observed differences and re-recording commands.

The prior 18.14.0 baseline and standalone byte capture are removed. Tests must load the current baseline, using the shared renderer document replay helper for browser replays. Model-backed workflows and a live collab guest remain outside these recordings.
