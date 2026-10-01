# Working on visual-omp

visual-omp is an Electron + React desktop app that wraps the omp (oh-my-pi) coding agent. Chats running in the app use omp's TUI in a hidden pty and mirror it through omp's collab stream; saved chats and terminal-follow views read session files. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/SPEC.md](docs/SPEC.md) first, and [docs/DESIGN.md](docs/DESIGN.md) before touching UI. The latest session handoff is in [docs/context/](docs/context/).

## The owner's standing rules

- **Wrapper first.** Reuse omp's own mechanisms instead of building parallel ones. Provider auth runs through `omp login` and `omp auth-broker logout`; the app never implements its own sign-in or credential storage.
- **Voice.** Every user-facing string, doc, CHANGELOG entry, release note and commit message follows [docs/VOICE.md](docs/VOICE.md). Do not use em or en dashes anywhere, including chat replies to the owner.
- **Advisor approval.** Every change is reviewed and approved by the advisor agent (`astra`) before it is committed. Resolve its required changes, and take product trade-offs it raises to the owner.
- **Commits and releases.** Commit work as conventional commits (`feat`, `fix`, `chore`, `docs`, `build`, `ci`, `refactor`, `style`, `test`). Never push, tag or publish a release unless the owner asks, because the owner decides when a version ships. The owner tests every release first: start a development build (`npm run dev`) on the commit that will be released, leave it running for the owner, and tag only after the owner has tried it and asked for the release. Releases follow [docs/RELEASING.md](docs/RELEASING.md): the CHANGELOG section becomes the GitHub release body, and a `v*` tag starts the build.
- **One Electron window at a time.** Close any dev instance before starting another, reuse a running one (the renderer hot-reloads), and stop it when you are done, unless you started it for the owner to test. Subagents never launch Electron; they verify with headless Chrome against a Vite server that has its own `cacheDir`, then stop it. Never touch the owner's installed visual-omp.
- **Design direction.** Follow "Refine current, de-slopped": use a light default, one teal accent on near-neutral surfaces, Phosphor icons, and purposeful motion through `src/renderer/src/ui/motion.tsx`. Respect reduced motion. Avoid gradients, glass, eyebrow labels, side-stripe borders, identical card grids, nested cards, and a 1px border with a wide shadow. The logo is the "Prompt" periscope (variant C1). Define the renderer's logo geometry in `src/renderer/src/ui/BrandMark.tsx`; the packaged icons and README artwork contain copies in `assets/icon.svg`, `assets/icon-macos.svg` and `assets/hero.svg`.

## Commands

- `npm run dev` starts the development app. It uses its own profile (`~/Library/Application Support/visual-omp-dev`, or the directory named by `VOMP_DEV_PROFILE`), so it runs beside an installed copy. In development builds only, `VOMP_UPDATE_FEED=<file>` simulates releases.
- Run `npm run typecheck` for TypeScript checks, `npm test` for Vitest tests, `npm run build` for the production build, and `npm run dist:mac` or `npm run dist:win` for installers.
- CI runs typecheck, tests and installer builds on macOS and Windows for every push to `main`.

## Gotchas

- The main process does not hot-reload. Restart `npm run dev` after changing anything under `src/main`.
- Several Vite servers share `node_modules/.vite`, so a window that goes blank after another server starts usually needs one reload.
- Components look up session controllers with `controllerFor()` during render, so controllers must exist before the first render. `src/renderer/src/state/app.ts` creates them for restored tabs right after hydration.
- omp has a short-lived cross-process publish lock, but no session ownership lock. The app infers ownership from `lsof`, terminal-session files and `ps`, and refuses takeover when a required check fails. This remains best effort, which the owner accepted: an omp process that has resumed a session without writing can be missed when `ps` does not identify its terminal. The app cannot detect terminal sessions on Windows.
- Windows CI runs the unit tests, so avoid host-specific path handling in code that only matters on macOS; for example, split POSIX `PATH` values with `posix.delimiter`.
- macOS builds must be signed as a whole bundle (`mac.identity: "-"` in `electron-builder.yml`). An unsigned bundle is reported as damaged once it is quarantined.
