import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type {
	AvailablePlugin,
	MarketplaceAddResult,
	MarketplaceSource,
	PluginConfig,
	PluginConfigValidation,
	PluginDoctorReport,
	PluginFeatureState,
	PluginInstallRequest,
	PluginInstallResult,
	PluginOperationResult,
	PluginProgress,
	PluginScope,
	PluginsListing,
	PluginUninstallRequest,
	PluginUpgradeRequest,
	PluginUpgradeResult,
} from "@shared/contracts/plugins";
import type { CliResult } from "@shared/ipc";
import {
	failureMessage,
	parseConfigValidation,
	parseDiscover,
	parseDoctor,
	parseFeatureState,
	parseInstalledPlugin,
	parseMarketplaceInstall,
	parseMarketplaceList,
	parsePluginConfig,
	parsePluginList,
	parseUpgrades,
} from "./parse";
import type { OmpRunner } from "./stream";

/** Where streamed progress goes (the feature entry broadcasts it). */
export type ProgressSink = (progress: PluginProgress) => void;

interface OperationRun {
	opId: string;
	result: CliResult;
	log: string[];
	ok: boolean;
	error: string | null;
}

export class PluginService {
	readonly #omp: OmpRunner;
	readonly #progress: ProgressSink;

	constructor(omp: OmpRunner, progress: ProgressSink) {
		this.#omp = omp;
		this.#progress = progress;
	}

	/** Run a buffered query; rejects with omp's message on failure. */
	async #query(argv: string[], cwd: string | undefined): Promise<string> {
		const result = await this.#omp.run(["plugin", ...argv], { cwd: cwd ?? homedir() });
		if (result.code !== 0) {
			throw new Error(failureMessage(result.stdout, result.stderr, `omp plugin ${argv[0]} exited with ${result.code}`));
		}
		return result.stdout;
	}

	async #operation(argv: string[], cwd: string | undefined, opId: string = randomUUID()): Promise<OperationRun> {
		const log: string[] = [];
		const result = await this.#omp.stream(["plugin", ...argv], {
			cwd: cwd ?? homedir(),
			opId,
			onLine: (line, stream) => {
				log.push(line);
				this.#progress({ opId, stream, line });
			},
		});
		const ok = result.code === 0;
		const error = ok ? null : failureMessage(result.stdout, result.stderr, `omp plugin ${argv[0]} exited with ${result.code}`);
		return { opId, result, log, ok, error };
	}

	list(cwd?: string): Promise<PluginsListing> {
		return this.#query(["list", "--json"], cwd).then(parsePluginList);
	}

	async install(request: PluginInstallRequest): Promise<PluginInstallResult> {
		const argv = ["install", request.spec, "--json"];
		if (request.scope) argv.push("--scope", request.scope);
		if (request.force) argv.push("--force");
		const run = await this.#operation(argv, request.cwd, request.opId);
		const base = { opId: run.opId, ok: run.ok, error: run.error, log: run.log };
		if (!run.ok) return { ...base, installed: null, marketplace: null };
		const marketplace = parseMarketplaceInstall(run.result.stdout);
		if (marketplace) return { ...base, installed: null, marketplace };
		try {
			return { ...base, installed: parseInstalledPlugin(run.result.stdout), marketplace: null };
		} catch (error) {
			// omp reported success but printed no plugin JSON; the install stands, the details are unknown.
			const message = error instanceof Error ? error.message : String(error);
			return { ...base, installed: null, marketplace: null, error: message };
		}
	}

	async uninstall(request: PluginUninstallRequest): Promise<PluginOperationResult> {
		const argv = ["uninstall", request.name, "--json"];
		if (request.scope) argv.push("--scope", request.scope);
		const { opId, ok, error, log } = await this.#operation(argv, request.cwd, request.opId);
		return { opId, ok, error, log };
	}

	async upgrade(request: PluginUpgradeRequest): Promise<PluginUpgradeResult> {
		const argv = ["upgrade", "--json"];
		if (request.id) argv.push(request.id);
		if (request.scope && request.id) argv.push("--scope", request.scope);
		const { opId, ok, error, log, result } = await this.#operation(argv, request.cwd, request.opId);
		return { opId, ok, error, log, upgrades: ok ? parseUpgrades(result.stdout) : [] };
	}

	async setEnabled(name: string, enabled: boolean, options: { scope?: PluginScope; cwd?: string } = {}): Promise<void> {
		const argv = [enabled ? "enable" : "disable", name, "--json"];
		if (options.scope) argv.push("--scope", options.scope);
		await this.#query(argv, options.cwd);
	}

	async features(name: string, cwd?: string): Promise<PluginFeatureState> {
		return parseFeatureState(await this.#query(["features", name, "--json"], cwd));
	}

	/**
	 * `--set` replaces the list but ignores an empty value, so clearing every feature goes through
	 * `--disable <all available>` (omp resolves it against the current list, leaving `[]`).
	 */
	async setFeatures(name: string, features: string[], cwd?: string): Promise<PluginFeatureState> {
		if (features.length > 0) {
			return parseFeatureState(await this.#query(["features", name, "--set", features.join(","), "--json"], cwd));
		}
		const current = await this.features(name, cwd);
		if (current.availableFeatures.length === 0) return current;
		const argv = ["features", name, "--disable", current.availableFeatures.join(","), "--json"];
		return parseFeatureState(await this.#query(argv, cwd));
	}

	async config(name: string, cwd?: string): Promise<PluginConfig> {
		return parsePluginConfig(name, await this.#query(["config", "list", name, "--json"], cwd));
	}

	async setConfig(name: string, key: string, value: string, cwd?: string): Promise<PluginConfig> {
		await this.#query(["config", "set", name, key, value], cwd);
		return this.config(name, cwd);
	}

	async deleteConfig(name: string, key: string, cwd?: string): Promise<PluginConfig> {
		await this.#query(["config", "delete", name, key], cwd);
		return this.config(name, cwd);
	}

	async validateConfig(cwd?: string): Promise<PluginConfigValidation> {
		return parseConfigValidation(await this.#query(["config", "validate", "--json"], cwd));
	}

	/** Doctor exits 1 when errors remain but still prints the checks, so only missing JSON is a failure. */
	async doctor(options: { fix?: boolean; cwd?: string } = {}): Promise<PluginDoctorReport> {
		const argv = ["plugin", "doctor", "--json"];
		if (options.fix) argv.push("--fix");
		const result = await this.#omp.run(argv, { cwd: options.cwd ?? homedir() });
		try {
			return parseDoctor(result.stdout);
		} catch (error) {
			if (result.code === 0) throw error;
			throw new Error(failureMessage(result.stdout, result.stderr, `omp plugin doctor exited with ${result.code}`));
		}
	}

	async marketplaces(): Promise<MarketplaceSource[]> {
		return parseMarketplaceList(await this.#query(["marketplace", "list"], undefined));
	}

	async addMarketplace(source: string, opId?: string): Promise<MarketplaceAddResult> {
		const before = new Set((await this.marketplaces()).map(entry => entry.name));
		const { opId: id, ok, error, log } = await this.#operation(["marketplace", "add", source], undefined, opId);
		const added = ok ? ((await this.marketplaces()).find(entry => !before.has(entry.name)) ?? null) : null;
		return { opId: id, ok, error, log, added };
	}

	async removeMarketplace(name: string, opId?: string): Promise<PluginOperationResult> {
		const { opId: id, ok, error, log } = await this.#operation(["marketplace", "remove", name], undefined, opId);
		return { opId: id, ok, error, log };
	}

	async updateMarketplace(name?: string, opId?: string): Promise<PluginOperationResult> {
		const argv = name ? ["marketplace", "update", name] : ["marketplace", "update"];
		const { opId: id, ok, error, log } = await this.#operation(argv, undefined, opId);
		return { opId: id, ok, error, log };
	}

	/** Catalog entries per marketplace, annotated with the scopes each is installed at. */
	async discover(marketplace?: string, cwd?: string): Promise<AvailablePlugin[]> {
		const [names, listing] = await Promise.all([
			marketplace ? Promise.resolve([marketplace]) : this.marketplaces().then(list => list.map(entry => entry.name)),
			this.list(cwd),
		]);
		const installed = new Map<string, PluginScope[]>();
		for (const plugin of listing.marketplace) {
			installed.set(plugin.id, [...(installed.get(plugin.id) ?? []), plugin.scope]);
		}
		const catalogs = await Promise.all(
			names.map(async name => parseDiscover(await this.#query(["discover", name], cwd), name, installed)),
		);
		return catalogs.flat();
	}
}
