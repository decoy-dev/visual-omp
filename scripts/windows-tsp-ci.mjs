import { execFileSync as executeFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
	lifecycleTimeoutMs: 300_000,
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
	const filename = context.command === "layout" ? `layout-${arch}-failure.json`
		: context.command === "lifecycle" && context.transport ? `lifecycle-${context.transport}-failure.json`
		: `${context.command}-failure.json`;
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

/** Keep the actual SessionHost and native transports; adapt only desktop/launch boundaries. */
export async function buildWindowsLifecycleProbe(project, outfile) {
	const platform = join(project, "src/main/omp/tsp/testing/windows-lifecycle-platform.ts");
	return build({
		entryPoints: [join(project, "src/main/omp/tsp/testing/windows-lifecycle.ts")],
		outfile, bundle: true, platform: "node", format: "esm", external: ["node-pty"],
		alias: { "@shared": join(project, "src/shared"), "@oh-my-pi/pi-wire": join(project, "src/renderer/src/collab/wire/index.ts") },
		banner: { js: "import { createRequire as lifecycleCreateRequire } from 'node:module'; const require = lifecycleCreateRequire(import.meta.url);" },
		plugins: [{
			name: "headless-lifecycle-boundaries",
			setup(builder) {
				builder.onResolve({ filter: /^(electron|\.\.\/(env|ipc|prefs)|\.\/locate)$/ }, () => ({ path: platform }));
			},
		}],
	});
}
/** Worker retention is a gate; thread, handle and other resource totals remain evidence. */
export function assertWindowsLifecycleReport(result, transport) {
	if (result.status !== "complete") throw new Error(`SessionHost lifecycle recorder did not complete: ${result.error ?? result.status}`);
	if (result.transport !== transport || result.variant !== (transport === "tsp" ? "1" : "0")) throw new Error(`SessionHost lifecycle report has the wrong transport: ${result.transport}`);
	if (!result.baseline?.resources || result.cycles?.length !== 6) throw new Error("SessionHost lifecycle report must contain a baseline and six settled cycles");
	const failures = [...(result.retentionFailures ?? [])];
	for (const mode of ["natural", "force"]) for (let index = 1; index <= 3; index++) {
		const matches = result.cycles.filter(cycle => cycle.mode === mode && cycle.index === index);
		const cycle = matches[0];
		if (matches.length !== 1 || cycle.error || !cycle.before?.resources || !cycle.settled?.resources
			|| cycle.confirmations !== (mode === "force" ? 1 : 0) || (mode === "natural" && cycle.exitCode !== 0)) {
			throw new Error(`SessionHost lifecycle report lacks a successful settled ${mode} ${index} cycle`);
		}
		for (const [reference, sample] of [["baseline", result.baseline], ["cycle", cycle.before]]) {
			const names = new Set([...Object.keys(sample.resources), ...Object.keys(cycle.settled.resources)]);
			for (const name of names) {
				const growth = (cycle.settled.resources[name] ?? 0) - (sample.resources[name] ?? 0);
				if (/MessagePort|Worker/i.test(name) && growth > 0) failures.push(`${mode} ${index}: ${name} grew by ${growth} from ${reference}`);
			}
		}
	}
	if (failures.length) throw new Error(`SessionHost ${transport} lifecycle retained worker resources:\n${failures.join("\n")}`);
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
			await build({ entryPoints: [join(project, "src/main/omp/tsp/windows-probe-cli.ts")], outfile: probe, bundle: true, platform: "node", format: "esm", external: ["node-pty"] });
			const native = join(app, "resources/app.asar.unpacked/node_modules/node-pty");
			// Run the packaged executable and its Electron-rebuilt addon, never the development addon.
			execFileSync(join(app, "visual-omp.exe"), [probe], {
				stdio: "inherit", timeout: WINDOWS_TSP_CI_LIMITS.smokeTimeoutMs, killSignal: "SIGKILL",
				env: { ...env, ELECTRON_RUN_AS_NODE: "1", VOMP_NODE_PTY: native,
					VOMP_TSP_WINDOWS_REPORT: join(evidence, "packaged-x64.json") },
			});
		} else if (command === "lifecycle") {
			// Static external imports resolve from the bundle, not cwd or the createRequire banner.
			// Keep the executable beneath this checkout so node-pty finds its native installation.
			const bundleDir = await mkdtemp(join(resolve(project), ".tsp-host-lifecycle-"));
			const recorder = join(bundleDir, "host-lifecycle.mjs");
			const failures = [];
			try {
				context.phase = "build";
				await buildWindowsLifecycleProbe(project, recorder);
				context.phase = "transports";
				// Separate subprocesses also give each recorder its own isolated home/profile.
				// Always attempt both transports, including after a timeout or malformed report.
				for (const [transport, variant] of [["tsp", "1"], ["classic", "0"]]) {
					const report = join(evidence, `host-lifecycle-${transport}.json`);
					const runContext = { command, transport, variant, report, phase: "run", timeoutMs: WINDOWS_TSP_CI_LIMITS.lifecycleTimeoutMs };
					try {
						execFileSync(process.execPath, [recorder], {
							stdio: "pipe", timeout: WINDOWS_TSP_CI_LIMITS.lifecycleTimeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
							env: { ...env, VOMP_TSP: variant, VOMP_TSP_LIFECYCLE_REPORT: report,
								VOMP_TSP_LIFECYCLE_EXTENSION: join(project, "src/main/omp/tsp/fixtures/extension/vomp-fixture.mjs") },
						});
						runContext.phase = "report";
						const result = JSON.parse(await readFile(report, "utf8"));
						assertWindowsLifecycleReport(result, transport);
						console.log(`SessionHost ${transport} lifecycle resource growth (thread, handle and other totals are observational): ${JSON.stringify(result.growth)}`);
					} catch (error) {
						await persistFailure(evidence, runContext, error);
						failures.push(error);
					}
				}
				if (failures.length) throw new AggregateError(failures, `${failures.length} SessionHost lifecycle transport(s) failed: ${failures.map(error => error.message).join("; ")}`);
			} finally {
				await rm(bundleDir, { recursive: true, force: true });
			}
		} else {
			throw new Error(`Unknown Windows TSP CI command: ${command}`);
		}
	} catch (error) {
		if (command === "download" || command === "layout" || command === "lifecycle") await persistFailure(evidence, context, error);
		throw error;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await runWindowsTspCi(process.argv.slice(2));
}
