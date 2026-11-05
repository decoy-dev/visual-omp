import { expect, it } from "vitest";
import { brewSwitchCommand } from "./install-switch";

it("uses adoption and quotes the binary and destination literally", () => {
	expect(brewSwitchCommand("/Users/Chris's tools/bin/brew", "/Users/Chris's Apps/visual-omp.app")).toBe(
		"HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ASK=1 '/Users/Chris'\\''s tools/bin/brew' install --cask --adopt '--appdir=/Users/Chris'\\''s Apps' decoy-dev/tap/visual-omp",
	);
});
it("never generates a forced replacement", () => {
	const command = brewSwitchCommand("/opt/homebrew/bin/brew", "/Applications/visual-omp.app");
	expect(command).toContain("install --cask --adopt");
	expect(command).not.toContain("--force");
});
