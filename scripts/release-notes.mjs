// Prints the CHANGELOG.md section for one version, which the release workflow publishes as the
// GitHub release body. Exits non-zero when the section is missing or empty, so a tag cannot ship
// without written notes.
import { readFile } from "node:fs/promises";

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error("Usage: node scripts/release-notes.mjs <version>");

const lines = (await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8")).split(/\r?\n/);
const start = lines.findIndex(line => line.startsWith(`## [${version}]`));
if (start === -1) {
	console.error(`CHANGELOG.md has no "## [${version}]" section.`);
	process.exit(1);
}
const next = lines.findIndex((line, index) => index > start && line.startsWith("## ["));
const body = lines
	.slice(start + 1, next === -1 ? undefined : next)
	.join("\n")
	.trim();
if (!body) {
	console.error(`The CHANGELOG.md section for ${version} is empty.`);
	process.exit(1);
}
process.stdout.write(`${body}\n`);
