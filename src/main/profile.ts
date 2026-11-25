/**
 * App identity, applied before any module reads `app.getPath("userData")`: imported first by the
 * main entry. Development runs (`electron-vite dev`) use their own data directory, so they get their
 * own single-instance lock, preferences and caches and can run next to an installed visual-omp.
 */
import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { app } from "electron";

declare const __VOMP_ISOLATION_TEST_ENABLED__: boolean | undefined;
const isolationTestEnabled = typeof __VOMP_ISOLATION_TEST_ENABLED__ === "boolean"
	? __VOMP_ISOLATION_TEST_ENABLED__
	: Boolean(process.env.VITEST);
const isolationTestActive = isolationTestEnabled && process.env.VOMP_PREVIEW_ISOLATION_TEST === "1";

app.setName("visual-omp");
if (isolationTestActive && (!process.env.VOMP_DEV_PROFILE || !isAbsolute(process.env.VOMP_DEV_PROFILE))) {
	throw new Error("Isolation testing requires an absolute scratch app profile.");
}
// Isolation evidence uses the same scratch profile override in packaged builds.
if (!app.isPackaged || isolationTestActive) {
	const profile = process.env.VOMP_DEV_PROFILE;
	app.setPath("userData", profile && isAbsolute(profile) ? profile : join(app.getPath("appData"), profile || "visual-omp-dev"));
	// An explicit scratch profile (release tours, fixtures) also keeps downloads and exports inside it, so a tour's
	// verified installer samples never reach the owner's Downloads folder.
	if (profile && isAbsolute(profile)) {
		const downloads = join(profile, "Downloads");
		mkdirSync(downloads, { recursive: true });
		app.setPath("downloads", downloads);
	}
}
