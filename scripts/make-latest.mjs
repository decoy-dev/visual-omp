import { compareStable, stableCore } from "./stable-channel.mjs";

// Prints `true` when the stable release `version` is at least as new as every stable release already on
// GitHub (their tags arrive on stdin, one per line), so publishing it marks it as Latest. Otherwise prints
// `false`: a stable tag published after a newer one (a fix on an older line, a re-run of an old release)
// leaves the Latest label on the newer release. Tags that aren't stable versions are ignored.
const [version] = process.argv.slice(2);
if (!version || !stableCore(version)) throw new Error(`Expected a stable release version, got "${version}"`);

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const published = Buffer.concat(chunks)
	.toString("utf8")
	.split(/\r?\n/)
	.map((tag) => tag.trim().replace(/^v/, ""))
	.filter((tag) => stableCore(tag));

console.log(published.every((tag) => compareStable(version, tag) >= 0) ? "true" : "false");
