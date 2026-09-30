import { broadcast, handle } from "../ipc";
import { appRunner } from "./plugins/runner";
import { PluginService } from "./plugins/service";
import { cancelOperation } from "./plugins/stream";

/** Run a mutation, then tell renderers which project (null = user scope) it affected. */
async function changed<T>(cwd: string | undefined, work: Promise<T>): Promise<T> {
	const result = await work;
	broadcast("plugins:changed", { cwd: cwd ?? null });
	return result;
}

export function register(): void {
	const plugins = new PluginService(appRunner, progress => broadcast("plugins:progress", progress));

	handle("plugins:list", cwd => plugins.list(cwd));
	handle("plugins:install", request => changed(request.cwd, plugins.install(request)));
	handle("plugins:uninstall", request => changed(request.cwd, plugins.uninstall(request)));
	handle("plugins:upgrade", request => changed(request.cwd, plugins.upgrade(request)));
	handle("plugins:setEnabled", (name, enabled, options) =>
		changed(options?.cwd, plugins.setEnabled(name, enabled, options)),
	);
	handle("plugins:features:get", (name, cwd) => plugins.features(name, cwd));
	handle("plugins:features:set", (name, features, cwd) => changed(cwd, plugins.setFeatures(name, features, cwd)));
	handle("plugins:config:get", (name, cwd) => plugins.config(name, cwd));
	handle("plugins:config:set", (name, key, value, cwd) => changed(cwd, plugins.setConfig(name, key, value, cwd)));
	handle("plugins:config:delete", (name, key, cwd) => changed(cwd, plugins.deleteConfig(name, key, cwd)));
	handle("plugins:config:validate", cwd => plugins.validateConfig(cwd));
	handle("plugins:doctor", options => plugins.doctor(options));
	handle("plugins:marketplace:list", () => plugins.marketplaces());
	handle("plugins:marketplace:add", (source, opId) => changed(undefined, plugins.addMarketplace(source, opId)));
	handle("plugins:marketplace:remove", (name, opId) => changed(undefined, plugins.removeMarketplace(name, opId)));
	handle("plugins:marketplace:update", (name, opId) => changed(undefined, plugins.updateMarketplace(name, opId)));
	handle("plugins:discover", (marketplace, cwd) => plugins.discover(marketplace, cwd));
	handle("plugins:cancel", opId => cancelOperation(opId));
}
