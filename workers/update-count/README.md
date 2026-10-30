# Update-check counts

This Worker counts fresh visual-omp update checks at
`https://visual-omp-update-count.chris-216.workers.dev/v1/check`.
It is deployed to the project's Cloudflare account separately from the Electron app.
The app's explicit TypeScript includes and installer file allowlist exclude this directory.

## Stored data and limitations

The app sends its version, platform and architecture once per fresh update check. Cached status
reads and release-note fetches do not send a request. Development builds and tests are excluded.
The collector stores only UTC day, version, platform, architecture and count in the Cloudflare D1
database `visual-omp-update-count`. It stores no IP address, user agent, headers or identifier.
An optional channel is validated and discarded. Worker logs, invocation logs, traces and Logpush
are disabled in `wrangler.jsonc`; the Worker contains no logging calls. Cloudflare still receives
network requests as the hosting provider.

Counts measure update checks rather than unique installations. An open copy checks about every
30 minutes, and manual checks add counts. There is no identifier for deduplication. The public
endpoint has no authentication, so third parties can inflate counts. Input validation and a 1 KiB
body limit restrict accepted requests; they do not provide per-client rate limiting. A failed
background write is discarded, so totals can also undercount.

## Deploy and read counts

From this directory, install the pinned tools with `npm ci`. Wrangler must be signed into the
account named in `wrangler.jsonc` with Workers deployment and D1 write access. The database and
binding are already provisioned. Apply migrations before deploying:

```sh
npm run migrate
npm run types
npm run typecheck
npm run deploy
```

Read the last 30 UTC calendar days by version and platform:

```sh
npm run counts
```

The equivalent query is:

```sh
npx wrangler d1 execute visual-omp-update-count --remote --command "SELECT version, platform, SUM(count) AS checks FROM daily_counts WHERE day >= date('now', '-29 days') GROUP BY version, platform ORDER BY checks DESC, version, platform"
```

To inspect daily counts including architecture:

```sh
npx wrangler d1 execute visual-omp-update-count --remote --command "SELECT day, version, platform, arch, count FROM daily_counts ORDER BY day DESC, version, platform, arch"
```

## Request contract

Only `POST /v1/check` is accepted. Send `Content-Type: application/json` and an object containing
`version` (a semver-like string of at most 32 characters), `platform` (`darwin`, `win32` or `linux`)
and `arch` (`arm64`, `x64` or `ia32`). Optional `channel` must contain 1-32 ASCII letters, digits,
periods or hyphens and start with a letter or digit. Unknown fields, malformed JSON, invalid
UTF-8 and bodies over 1 KiB return 400, including streamed bodies without a content length.
Other methods return 405; other paths return 404. There are no CORS headers.

Accepted requests return 204 before the D1 write completes. `ctx.waitUntil` owns the write's
lifetime. The single `daily_counts` table uses `(day, version, platform, arch)` as its primary key
and increments `count` on conflict. Wrangler also maintains its own migration bookkeeping table.
