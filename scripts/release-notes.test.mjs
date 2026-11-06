import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

async function fixture(t, body) {
	const root = await mkdtemp(join(tmpdir(), "vomp-release-notes-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "scripts"));
	await mkdir(join(root, "src/shared"), { recursive: true });
	for (const path of ["scripts/release-notes.mjs", "src/shared/changelog.ts", "src/shared/releaseHighlights.ts"]) {
		await writeFile(join(root, path), await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
	}
	await writeFile(join(root, "CHANGELOG.md"), `# Changelog\n\n## [Unreleased]\n\n## [0.7.9] - 2026-11-06\n\n${body}\n`);
	return spawnSync(process.execPath, [join(root, "scripts/release-notes.mjs"), "0.7.9"], { encoding: "utf8" });
}

test("release script sorts Highlights stably while leaving overview and detailed changes unchanged", async t => {
	const overview = "Overview.\n\n### Highlights\n\n";
	const notice = "> [!WARNING]\n> Update this release.\n\n";
	const bullets = ["- **Fixed:** First repair.", "- **Other:** Unknown category.", "- **Improved:** Faster replies.", "- **New:** A feature.", "- **Fixed:** Second repair.", "- **Changed:** A requirement.", "- **Security:** A security change.", "- **Removed:** An old option."];
	const detailed = "\n\n### Detailed changes\n\n#### Fixed\n\n- **Fixed:** Detailed repair.\n- **New:** Detailed feature.";
	const result = await fixture(t, overview + notice + bullets.join("\n") + detailed);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, overview + notice + [bullets[6], bullets[3], bullets[2], bullets[5], bullets[0], bullets[4], bullets[7], bullets[1]].join("\n") + detailed + "\n");
	assert.match(result.stderr, /Unknown Highlights category: Other/);
});

test("release script warns without failing or losing excess notices and headlines", async t => {
	const body = "### Highlights\n\n> [!IMPORTANT]\n> First notice.\n\n> [!CAUTION]\n> Second notice.\n\n- **Fixed:** **One headline title.** First.\n- **New:** **Two headline title.** Second.\n- **Improved:** **Three headline title.** Third.";
	const result = await fixture(t, body);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /3 headlines; use at most 2/);
	assert.match(result.stderr, /2 notices; use at most 1/);
	assert.match(result.stdout, /Second notice/);
	assert.match(result.stdout, /One headline title/);
	assert.ok(result.stdout.indexOf("> [!CAUTION]") < result.stdout.indexOf("- **New:**"));
});

test("release script preserves a legacy body without Highlights", async t => {
	const body = "Older overview.\n\n- First entry.\n- Second entry.";
	const result = await fixture(t, body);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, `${body}\n`);
	assert.equal(result.stderr, "");
});
