/**
 * App identity, applied before any module reads `app.getPath("userData")`: imported first by the
 * main entry. Development runs (`electron-vite dev`) use their own data directory, so they get their
 * own single-instance lock, preferences and caches and can run next to an installed visual-omp.
 */
import { isAbsolute, join } from "node:path";
import { app } from "electron";

app.setName("visual-omp");
if (process.env.VOMP_PREVIEW_ISOLATION_TEST === "1" && (!process.env.VOMP_DEV_PROFILE || !isAbsolute(process.env.VOMP_DEV_PROFILE))) {
	throw new Error("Isolation testing requires an absolute scratch app profile.");
}
// Isolation evidence uses the same scratch profile override in packaged builds.
if (!app.isPackaged || process.env.VOMP_PREVIEW_ISOLATION_TEST === "1") {
	const profile = process.env.VOMP_DEV_PROFILE;
	app.setPath("userData", profile && isAbsolute(profile) ? profile : join(app.getPath("appData"), profile || "visual-omp-dev"));
}
