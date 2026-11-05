import { posix } from "node:path";

export const BREW_CASK = "decoy-dev/tap/visual-omp";
export const PACKAGE_REPOSITORY = "https://github.com/decoy-dev/visual-omp";

/** Adoption fails closed if the destination differs or another copy appears before installation. */
export function brewSwitchCommand(brew: string, target: string): string {
	const binary = `'${brew.replaceAll("'", `'\\''`)}'`;
	const appdir = `'${`--appdir=${posix.dirname(target)}`.replaceAll("'", `'\\''`)}'`;
	return `HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ASK=1 ${binary} install --cask --adopt ${appdir} ${BREW_CASK}`;
}
