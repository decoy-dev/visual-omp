import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { CONPTY_FILES } from "./stage-conpty.mjs";
import { runWindowsTspCi, WINDOWS_TSP_CI_LIMITS } from "./windows-tsp-ci.mjs";

const version = "18.15.0";
const asset = "omp-windows-x64.exe";
const base = `https://github.com/can1357/oh-my-pi/releases/download/v${version}`;
const binary = Buffer.from("inert downloaded executable fixture");
const sha256 = createHash("sha256").update(binary).digest("hex");

async function fixture(t) {
	const project = await mkdtemp(join(tmpdir(), "vomp-windows-ci-"));
	t.after(() => rm(project, { recursive: true, force: true }));
	await mkdir(join(project, "src/main/omp"), { recursive: true });
	await writeFile(join(project, "src/main/omp/locate.ts"), `export const MIN_OMP_VERSION = "${version}";\n`);
	return { project, evidence: join(project, "evidence"), env: { GITHUB_ENV: join(project, "github-env") } };
}

async function lifecycleFixture(t, mode) {
	const options = await fixture(t);
	const evidence = await mkdtemp(join(tmpdir(), "vomp-lifecycle-evidence-"));
	t.after(() => rm(evidence, { recursive: true, force: true }));
	const directory = join(options.project, "src/main/omp/tsp/testing");
	await mkdir(directory, { recursive: true });
	const nativePackage = join(options.project, "node_modules/node-pty");
	await mkdir(nativePackage, { recursive: true });
	await writeFile(join(nativePackage, "package.json"), JSON.stringify({ name: "node-pty", main: "index.cjs" }));
	await writeFile(join(nativePackage, "index.cjs"), "exports.spawn = () => 'checkout-native-package';\n");
	// A static external import exercises Node's real resolution from the emitted executable location.
	await writeFile(join(directory, "windows-lifecycle.ts"), `
import { spawn } from "node-pty";
import { writeFileSync } from "node:fs";
const mode = process.env.LIFECYCLE_FIXTURE_MODE;
const report = {
  status: mode === "complete" ? "complete" : "running",
  nativePackage: spawn(),
  reportPath: process.env.VOMP_TSP_LIFECYCLE_REPORT,
  extensionPath: process.env.VOMP_TSP_LIFECYCLE_EXTENSION,
  omp: process.env.OMP_BIN,
  cycles: [{ mode: "natural", index: 1 }],
  growth: { threads: 6, handles: 30, resources: { MessagePort: 6, PipeWrap: 6 } },
};
writeFileSync(process.env.VOMP_TSP_LIFECYCLE_REPORT, JSON.stringify(report));
if (mode === "timeout") setInterval(() => {}, 1000);
if (mode === "nonzero") { process.stderr.write("lifecycle operation failed"); process.exitCode = 7; }
`);
	return { ...options, evidence, env: { ...options.env, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
		OMP_BIN: join(options.project, asset), LIFECYCLE_FIXTURE_MODE: mode } };
}

function downloadFetch(sums = `${sha256} *${asset}\n`) {
	return async url => {
		if (url === `${base}/SHA256SUMS.txt`) return new Response(sums);
		assert.equal(url, `${base}/${asset}`);
		return new Response(binary);
	};
}

async function failure(options, command) {
	return JSON.parse(await readFile(join(options.evidence, `${command}-failure.json`), "utf8"));
}

async function assertAbsent(path) {
	await assert.rejects(readFile(path), { code: "ENOENT" });
}

test("download persists the rejected fetch and its release context before rethrowing", async t => {
	const options = await fixture(t);
	const error = new Error("Release connection closed");
	error.code = "ECONNRESET";
	await assert.rejects(runWindowsTspCi(["download"], {
		...options, fetch: async () => { throw error; },
	}), caught => caught === error);
	const report = await failure(options, "download");
	assert.equal(report.status, "failed");
	assert.equal(report.command, "download");
	assert.equal(report.phase, "checksums-fetch");
	assert.equal(report.version, version);
	assert.equal(report.url, `${base}/SHA256SUMS.txt`);
	assert.equal(report.error.message, error.message);
	assert.equal(report.error.code, "ECONNRESET");
	await assertAbsent(join(options.evidence, "omp-download.json"));
	await assertAbsent(options.env.GITHUB_ENV);
});

test("download records binary fetch rejection after reading the matching checksum", async t => {
	const options = await fixture(t);
	const fetch = downloadFetch();
	await assert.rejects(runWindowsTspCi(["download"], {
		...options, fetch: async (url, init) => {
			if (url.endsWith(".exe")) throw new Error("Binary connection closed");
			return fetch(url, init);
		},
	}), /Binary connection closed/);
	const report = await failure(options, "download");
	assert.equal(report.phase, "binary-fetch");
	assert.equal(report.url, `${base}/${asset}`);
	assert.equal(report.error.message, "Binary connection closed");
	await assertAbsent(join(options.evidence, asset));
});

test("download rejects mismatched bytes without writing or executing the binary", async t => {
	const options = await fixture(t);
	await assert.rejects(runWindowsTspCi(["download"], {
		...options, fetch: downloadFetch(`${"0".repeat(64)}  ${asset}\n`),
		execFileSync: () => assert.fail("A checksum mismatch must prevent execution"),
	}), /omp SHA-256 mismatch/);
	const report = await failure(options, "download");
	assert.equal(report.phase, "checksum");
	assert.equal(report.error.message, "omp SHA-256 mismatch");
	await assertAbsent(join(options.evidence, asset));
	await assertAbsent(join(options.evidence, "omp-download.json"));
});

for (const sums of [
	`${sha256}  another-windows.exe\n`,
	`${sha256}  ${asset}\n${sha256} *${asset}\n`,
]) {
	test(`download persists failure for ${sums.includes("another") ? "missing" : "duplicate"} matching checksums`, async t => {
		const options = await fixture(t);
		await assert.rejects(runWindowsTspCi(["download"], {
			...options, fetch: downloadFetch(sums),
		}), /Expected exactly one checksum/);
		const report = await failure(options, "download");
		assert.equal(report.phase, "checksums-body");
		assert.match(report.error.message, /Expected exactly one checksum/);
		await assertAbsent(join(options.evidence, asset));
	});
}

for (const phase of ["checksums-fetch", "checksums-body", "binary-fetch", "binary-body"]) {
	test(`download aborts and records a stalled ${phase}`, { timeout: 2_000 }, async t => {
		const options = await fixture(t);
		let signal;
		const forever = () => new Promise(() => {});
		await assert.rejects(runWindowsTspCi(["download"], {
			...options, downloadTimeoutMs: 10,
			fetch: async (url, init) => {
				signal = init.signal;
				const isSums = url.endsWith(".txt");
				if ((isSums && phase === "checksums-fetch") || (!isSums && phase === "binary-fetch")) return forever();
				return { ok: true,
					text: isSums && phase === "checksums-body" ? forever : async () => `${sha256}  ${asset}\n`,
					arrayBuffer: phase === "binary-body" ? forever : async () => binary,
				};
			},
		}), { code: "ETIMEDOUT" });
		assert.equal(signal.aborted, true);
		const report = await failure(options, "download");
		assert.equal(report.phase, phase);
		assert.equal(report.error.code, "ETIMEDOUT");
		assert.match(report.error.message, /download timed out after 10 ms/);
		await assertAbsent(join(options.evidence, asset));
		await assertAbsent(options.env.GITHUB_ENV);
	});
}

test("download persists an executed version timeout with captured process diagnostics", { timeout: 5_000 }, async t => {
	const options = await fixture(t);
	await assert.rejects(runWindowsTspCi(["download"], {
		...options, fetch: downloadFetch(),
		execFileSync: (file, args, settings) => {
			assert.equal(file, join(options.evidence, asset));
			assert.deepEqual(args, ["--version"]);
			assert.equal(settings.timeout, 10_000);
			assert.equal(settings.killSignal, "SIGKILL");
			return execFileSync(process.execPath, ["-e", "process.stdout.write('version stalled'); process.stderr.write('version diagnostic'); setInterval(() => {}, 1000)"], {
				...settings, timeout: 500,
			});
		},
	}), { code: "ETIMEDOUT" });
	const report = await failure(options, "download");
	assert.equal(report.phase, "version");
	assert.equal(report.error.code, "ETIMEDOUT");
	assert.equal(report.error.stdout, "version stalled");
	assert.equal(report.error.stderr, "version diagnostic");
	assert.deepEqual(await readFile(join(options.evidence, asset)), binary);
	await assertAbsent(join(options.evidence, "omp-download.json"));
	await assertAbsent(options.env.GITHUB_ENV);
});

test("download persists a version mismatch without exporting a usable binary", async t => {
	const options = await fixture(t);
	await assert.rejects(runWindowsTspCi(["download"], {
		...options, fetch: downloadFetch(), execFileSync: () => "omp/1.0.0\n",
	}), /Expected omp\/18\.15\.0, received omp\/1\.0\.0/);
	assert.equal((await failure(options, "download")).phase, "version");
	await assertAbsent(options.env.GITHUB_ENV);
});

test("successful download retains checksum evidence, environment exports and ConPTY staging", async t => {
	const options = await fixture(t);
	const source = join(options.project, "node_modules/node-pty/third_party/conpty/fixture/win10-x64");
	await mkdir(source, { recursive: true });
	for (const file of CONPTY_FILES) await writeFile(join(source, file), `target:${file}`);
	await runWindowsTspCi(["download"], {
		...options, fetch: downloadFetch(`${sha256.toUpperCase()} *${asset}\n`),
		execFileSync: () => `omp/${version}\n`,
	});
	assert.deepEqual(JSON.parse(await readFile(join(options.evidence, "omp-download.json"), "utf8")), {
		version, url: `${base}/${asset}`, sha256,
	});
	assert.equal(await readFile(options.env.GITHUB_ENV, "utf8"), `OMP_BIN=${join(options.evidence, asset)}\nOMP_EXPECTED_VERSION=${version}\n`);
	for (const file of CONPTY_FILES) {
		assert.equal(await readFile(join(options.project, "node_modules/node-pty/build/Release/conpty", file), "utf8"), `target:${file}`);
	}
	await assertAbsent(join(options.evidence, "download-failure.json"));
});

for (const missing of CONPTY_FILES) {
	test(`layout persists the missing ${missing} and filesystem cause`, async t => {
		const options = await fixture(t);
		const app = join(options.project, "packaged");
		const directory = join(app, "resources/app.asar.unpacked/node_modules/node-pty/build/Release/conpty");
		await mkdir(directory, { recursive: true });
		const bytes = Buffer.alloc(256);
		bytes.writeUInt16LE(0x5a4d, 0);
		bytes.writeUInt32LE(0x80, 0x3c);
		bytes.writeUInt32LE(0x00004550, 0x80);
		bytes.writeUInt16LE(0x8664, 0x84);
		for (const file of CONPTY_FILES) if (file !== missing) await writeFile(join(directory, file), bytes);
		await assert.rejects(runWindowsTspCi(["layout", app, "x64"], options), /Missing or unreadable packaged ConPTY file/);
		const report = await failure(options, "layout-x64");
		assert.equal(report.status, "failed");
		assert.equal(report.phase, "layout");
		assert.equal(report.app, app);
		assert.equal(report.arch, "x64");
		assert.ok(report.error.message.includes(join(directory, missing)));
		assert.equal(report.error.cause.code, "ENOENT");
		await assertAbsent(join(options.evidence, "conpty-x64.json"));
	});
}

test("failure diagnostics cap multibyte text and JSON-escaped output without serializing error graphs", async t => {
	const options = await fixture(t);
	const noisy = "\u0000🙂".repeat(100_000);
	const error = new Error(noisy);
	for (const key of ["name", "stack", "code", "signal", "stdout", "stderr"]) error[key] = noisy;
	error.cause = error;
	await assert.rejects(runWindowsTspCi(["download"], {
		...options, fetch: async () => { throw error; },
	}), caught => caught === error);
	const bytes = await readFile(join(options.evidence, "download-failure.json"));
	assert.ok(bytes.length <= WINDOWS_TSP_CI_LIMITS.diagnosticBytes);
	const report = JSON.parse(bytes);
	for (const key of ["name", "message", "stack", "code", "signal", "stdout", "stderr"]) {
		assert.ok(Buffer.byteLength(report.error[key]) <= WINDOWS_TSP_CI_LIMITS.diagnosticTextBytes, key);
		assert.ok(report.error[key].endsWith("..."), key);
		assert.ok(!report.error[key].includes("\ufffd"), key);
	}
	assert.deepEqual(Object.keys(report.error.cause), ["name", "message", "code"]);
	assert.equal(report.error.cause.message, report.error.message);
	assert.equal(report.phase, "checksums-fetch");
});


for (const arch of ["x64", "arm64"]) {
	test(`successful ${arch} layout retains file sizes and SHA-256 evidence`, async t => {
		const options = await fixture(t);
		const app = join(options.project, "packaged");
		const directory = join(app, "resources/app.asar.unpacked/node_modules/node-pty/build/Release/conpty");
		await mkdir(directory, { recursive: true });
		const bytes = Buffer.alloc(256);
		bytes.writeUInt16LE(0x5a4d, 0);
		bytes.writeUInt32LE(0x80, 0x3c);
		bytes.writeUInt32LE(0x00004550, 0x80);
		bytes.writeUInt16LE(arch === "x64" ? 0x8664 : 0xaa64, 0x84);
		for (const file of CONPTY_FILES) await writeFile(join(directory, file), bytes);
		await runWindowsTspCi(["layout", app, arch], options);
		assert.deepEqual(JSON.parse(await readFile(join(options.evidence, `conpty-${arch}.json`), "utf8")),
			CONPTY_FILES.map(file => ({
				path: join(directory, file),
				size: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			})));
		await assertAbsent(join(options.evidence, `layout-${arch}-failure.json`));
	});
}

test("lifecycle resolves the checkout native package and accepts completed resource growth as evidence requiring review", async t => {
	const options = await lifecycleFixture(t, "complete");
	let recorder;
	const messages = [];
	t.mock.method(console, "log", message => messages.push(message));
	await runWindowsTspCi(["lifecycle"], {
		...options,
		execFileSync: (file, args, settings) => {
			recorder = args[0];
			assert.equal(file, process.execPath);
			assert.equal(dirname(dirname(recorder)), options.project);
			assert.notEqual(dirname(recorder), options.evidence);
			assert.equal(settings.timeout, 300_000);
			assert.equal(settings.killSignal, "SIGKILL");
			assert.equal(settings.env.VOMP_TSP_LIFECYCLE_REPORT, join(options.evidence, "host-lifecycle.json"));
			assert.equal(settings.env.VOMP_TSP_LIFECYCLE_EXTENSION, join(options.project, "src/main/omp/tsp/fixtures/extension/vomp-fixture.mjs"));
			assert.equal(settings.env.OMP_BIN, options.env.OMP_BIN);
			assert.equal(settings.env.NODE_PATH, undefined);
			return execFileSync(file, args, { ...settings, cwd: options.evidence });
		},
	});
	const report = JSON.parse(await readFile(join(options.evidence, "host-lifecycle.json"), "utf8"));
	assert.equal(report.nativePackage, "checkout-native-package");
	assert.equal(report.reportPath, join(options.evidence, "host-lifecycle.json"));
	assert.equal(report.extensionPath, join(options.project, "src/main/omp/tsp/fixtures/extension/vomp-fixture.mjs"));
	assert.equal(report.omp, options.env.OMP_BIN);
	assert.deepEqual(report.growth, { threads: 6, handles: 30, resources: { MessagePort: 6, PipeWrap: 6 } });
	assert.ok(messages.some(message => message.includes("resource growth (evidence only; requires review)") && message.includes('"threads":6')));
	await assertAbsent(join(options.evidence, "lifecycle-failure.json"));
	await assertAbsent(recorder);
});

for (const mode of ["timeout", "nonzero"]) {
	test(`lifecycle ${mode} remains fatal and preserves its progressive report`, { timeout: 10_000 }, async t => {
		const options = await lifecycleFixture(t, mode);
		let recorder;
		await assert.rejects(runWindowsTspCi(["lifecycle"], {
			...options,
			execFileSync: (file, args, settings) => {
				recorder = args[0];
				assert.equal(settings.timeout, 300_000);
				// Exercise a real platform timeout without waiting for the production five-minute budget.
				return execFileSync(file, args, { ...settings, timeout: mode === "timeout" ? 500 : settings.timeout });
			},
		}), mode === "timeout" ? { code: "ETIMEDOUT" } : /Command failed/);
		const report = JSON.parse(await readFile(join(options.evidence, "host-lifecycle.json"), "utf8"));
		assert.equal(report.status, "running");
		assert.equal(report.nativePackage, "checkout-native-package");
		assert.deepEqual(report.cycles, [{ mode: "natural", index: 1 }]);
		const diagnostic = await failure(options, "lifecycle");
		assert.equal(diagnostic.status, "failed");
		assert.equal(diagnostic.phase, "run");
		assert.equal(diagnostic.timeoutMs, "300000");
		if (mode === "timeout") assert.equal(diagnostic.error.code, "ETIMEDOUT");
		else {
			assert.equal(diagnostic.error.stderr, "lifecycle operation failed");
			assert.match(diagnostic.error.message, /Command failed/);
		}
		await assertAbsent(recorder);
	});
}

test("lifecycle rejects a zero-exit subprocess with an incomplete report", async t => {
	const options = await lifecycleFixture(t, "incomplete");
	await assert.rejects(runWindowsTspCi(["lifecycle"], options), /lifecycle recorder did not complete: running/);
	const report = JSON.parse(await readFile(join(options.evidence, "host-lifecycle.json"), "utf8"));
	assert.equal(report.status, "running");
	assert.equal(report.nativePackage, "checkout-native-package");
	const diagnostic = await failure(options, "lifecycle");
	assert.equal(diagnostic.status, "failed");
	assert.match(diagnostic.error.message, /did not complete/);
});