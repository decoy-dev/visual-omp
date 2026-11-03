# TSP recordings

The current baseline is [omp 18.15.0](18.15.0/README.md), upstream commit `3fedf8d53267e32a6d7521ce725fdcc4a36fdc67`. It contains 90 isolated recordings, including scripted loopback-provider scenarios and the rejected-image recovery capture. All raw streams use the recorder's privacy sanitizer and byte/CR/SHA-256 integrity manifests.

`extension/` contains the explicitly loaded test extension and synthetic session input used by the recorder. No recording uses the owner's HOME, credentials or installed omp. The versioned README documents configuration, interactions, observed differences and re-recording commands.

The prior 18.14.0 baseline and standalone byte capture are removed. Tests load the current baseline, using the shared renderer document replay helper for browser replays. The image attachment recording also retains a collab guest transcript. `18.16.0/` contains one separately recorded rejected-image comparison and does not replace the 18.15.0 baseline.
