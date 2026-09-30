/**
 * App identity, applied before any module reads `app.getPath("userData")`: imported first by the
 * main entry. Development runs (`electron-vite dev`) use their own data directory, so they get their
 * own single-instance lock, preferences and caches and can run next to an installed visual-omp.
 */
import { join } from "node:path";
import { app } from "electron";

app.setName("visual-omp");
// VOMP_DEV_PROFILE picks another directory, so a second development instance can run beside the first.
if (!app.isPackaged) app.setPath("userData", join(app.getPath("appData"), process.env.VOMP_DEV_PROFILE || "visual-omp-dev"));
