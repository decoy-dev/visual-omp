// Prints the CHANGELOG.md section for one version, which the release workflow publishes as the
// GitHub release body. Exits non-zero when the section is missing or empty, so a tag cannot ship
// without written notes.
import { readFile } from "node:fs/promises";
import { parseChangelog } from "../src/shared/changelog.ts";

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error("Usage: node scripts/release-notes.mjs <version>");

const sections = parseChangelog(await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8"));
const section = sections.find(section => section.version === version);
if (!section) {
	console.error(`CHANGELOG.md has no "## [${version}]" section.`);
	process.exit(1);
}
const body = section.body;
if (!body) {
	console.error(`The CHANGELOG.md section for ${version} is empty.`);
	process.exit(1);
}
process.stdout.write(`${body}\n`);
