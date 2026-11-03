import { execFileSync as executeFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { assertConptyLayout } from "./after-pack.mjs";
import stageConpty from "./stage-conpty.mjs";

const defaultProject = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const WINDOWS_TSP_CI_LIMITS = Object.freeze({
	downloadTimeoutMs: 30_000,
	versionTimeoutMs: 10_000,
	smokeTimeoutMs: 90_000,
	diagnosticTextBytes: 4_096,
	diagnosticBytes: 65_536,
});

function boundedText(value, limit) {
	const bytes = Buffer.from(String(value));
	if (bytes.length <= limit) return bytes.toString("utf8");
	return new TextDecoder().decode(bytes.subarray(0, limit - 3), { stream: true }) + "...";
}

function errorDetails(error, limit) {
	const details = {};
	for (const key of ["name", "message", "stack", "code", "signal", "stdout", "stderr"]) {
		if (error?.[key] !== undefined) details[key] = boundedText(error[key], limit);
	}
	if (!details.message) details.message = boundedText(error, limit);
	// One cause preserves filesystem error codes without following arbitrary error graphs.
	if (error?.cause !== undefined) {
		details.cause = {};
		for (const key of ["name", "message", "code"]) {
			if (error.cause?.[key] !== undefined) details.cause[key] = boundedText(error.cause[key], limit);
		}
	}
	return details;
}

async function persistFailure(evidence, context, error) {
	let limit = WINDOWS_TSP_CI_LIMITS.diagnosticTextBytes;
	let json;
	do {
		const record = { status: "failed" };
		for (const [key, value] of Object.entries(context)) record[key] = boundedText(value, limit);
		record.error = errorDetails(error, limit);
		json = JSON.stringify(record, null, 2);
		limit = Math.floor(limit / 2);
	} while (Buffer.byteLength(json) > WINDOWS_TSP_CI_LIMITS.diagnosticBytes);
	const arch = context.arch === "x64" || context.arch === "arm64" ? context.arch : "unknown";
	const filename = context.command === "layout" ? `layout-${arch}-failure.json` : `${context.command}-failure.json`;
	await writeFile(join(evidence, filename), json);
}

async function fetchDownload(version, fetch, timeoutMs, context) {
	const asset = "omp-windows-x64.exe";
	const base = `https://github.com/can1357/oh-my-pi/releases/download/v${version}`;
	const controller = new AbortController();
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => {
			const error = Object.assign(new Error(`omp download timed out after ${timeoutMs} ms`), { code: "ETIMEDOUT" });
			controller.abort(error);
			reject(error);
		}, timeoutMs);
	});
	try {
		return await Promise.race([timeout, (async () => {
			context.phase = "checksums-fetch";
			context.url = `${base}/SHA256SUMS.txt`;
			const sumsResponse = await fetch(context.url, { signal: controller.signal });
			controller.signal.throwIfAborted();
			if (!sumsResponse.ok) throw new Error(`SHA256SUMS download failed: ${sumsResponse.status}`);
			context.phase = "checksums-body";
			const sums = await sumsResponse.text();
			controller.signal.throwIfAborted();
			const matches = sums.split(/\r?\n/).map(line => line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)).filter(match => match?.[2] === asset);
			if (matches.length !== 1) throw new Error(`Expected exactly one checksum for ${asset}; received ${matches.length}`);
			context.phase = "binary-fetch";
			context.url = `${base}/${asset}`;
			const response = await fetch(context.url, { signal: controller.signal });
			controller.signal.throwIfAborted();
			if (!response.ok) throw new Error(`omp download failed: ${response.status}`);
			context.phase = "binary-body";
			const bytes = Buffer.from(await response.arrayBuffer());
			controller.signal.throwIfAborted();
			context.phase = "checksum";
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			if (sha256 !== matches[0][1].toLowerCase()) throw new Error("omp SHA-256 mismatch");
			return { bytes, sha256, url: context.url, asset };
		})()]);
	} finally {
		clearTimeout(timer);
	}
}

/** Run a CI operation without invoking the command line when this module is imported. */
export async function runWindowsTspCi(argv, {
	project = defaultProject,
	env = process.env,
	evidence = resolve(env.VOMP_TSP_WINDOWS_EVIDENCE ?? join(project, "windows-tsp-evidence")),
	fetch = globalThis.fetch,
	execFileSync = executeFileSync,
	downloadTimeoutMs = WINDOWS_TSP_CI_LIMITS.downloadTimeoutMs,
} = {}) {
	const command = argv[0];
	const context = { command, phase: "setup" };
	await mkdir(evidence, { recursive: true });
	try {
		if (command === "download") {
			// Resolve the app minimum from its source so the CI binary cannot silently drift below it.
			context.phase = "minimum-version";
			const source = await readFile(join(project, "src/main/omp/locate.ts"), "utf8");
			const version = source.match(/MIN_OMP_VERSION\s*=\s*["']([^"']+)["']/)?.[1];
			if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Cannot read a stable MIN_OMP_VERSION from locate.ts");
			context.version = version;
			const { bytes, sha256, url, asset } = await fetchDownload(version, fetch, downloadTimeoutMs, context);
			const binary = join(evidence, asset);
			context.phase = "binary-write";
			await writeFile(binary, bytes);
			context.phase = "version";
			const actual = execFileSync(binary, ["--version"], {
				encoding: "utf8",
				timeout: WINDOWS_TSP_CI_LIMITS.versionTimeoutMs,
				maxBuffer: WINDOWS_TSP_CI_LIMITS.diagnosticTextBytes,
				killSignal: "SIGKILL",
			}).trim();
			if (actual !== `omp/${version}`) throw new Error(`Expected omp/${version}, received ${actual}`);
			context.phase = "download-evidence";
			await writeFile(join(evidence, "omp-download.json"), JSON.stringify({ version, url, sha256 }, null, 2));
			context.phase = "github-env";
			if (!env.GITHUB_ENV) throw new Error("GITHUB_ENV is required for the CI download command");
			await appendFile(env.GITHUB_ENV, `OMP_BIN=${binary}\nOMP_EXPECTED_VERSION=${version}\n`);
			context.phase = "stage-conpty";
			await stageConpty({ electronPlatformName: "win32", arch: "x64", packager: { info: { appDir: project } } });
		} else if (command === "layout") {
			context.phase = "layout";
			context.arch = argv[2];
			context.app = resolve(argv[1]);
			const files = await assertConptyLayout(context.app, context.arch);
			context.phase = "layout-evidence";
			const listing = await Promise.all(files.map(async path => ({ path, size: (await stat(path)).size, sha256: createHash("sha256").update(await readFile(path)).digest("hex") })));
			await writeFile(join(evidence, `conpty-${context.arch}.json`), JSON.stringify(listing, null, 2));
			console.log(JSON.stringify(listing, null, 2));
		} else if (command === "smoke") {
			const app = resolve(argv[1]);
			const probe = join(evidence, "packaged-probe.mjs");
			await build({ entryPoints: [join(project, "src/main/omp/tsp/windows-probe.ts")], outfile: probe, bundle: true, platform: "node", format: "esm", external: ["node-pty"] });
			const native = join(app, "resources/app.asar.unpacked/node_modules/node-pty");
			// Run the packaged executable and its Electron-rebuilt addon, never the development addon.
			execFileSync(join(app, "visual-omp.exe"), [probe], {
				stdio: "inherit", timeout: WINDOWS_TSP_CI_LIMITS.smokeTimeoutMs, killSignal: "SIGKILL",
				env: { ...env, ELECTRON_RUN_AS_NODE: "1", VOMP_NODE_PTY: native,
					VOMP_TSP_WINDOWS_REPORT: join(evidence, "packaged-x64.json") },
			});
		} else {
			throw new Error(`Unknown Windows TSP CI command: ${command}`);
		}
	} catch (error) {
		if (command === "download" || command === "layout") await persistFailure(evidence, context, error);
		throw error;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await runWindowsTspCi(process.argv.slice(2));
}
