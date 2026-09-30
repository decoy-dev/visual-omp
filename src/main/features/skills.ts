import { broadcast, handle } from "../ipc";
import { editConfig } from "../omp/config-file";
import { appRunner } from "./plugins/runner";
import { cancelOperation } from "./plugins/stream";
import { SkillService } from "./skills/service";

/** Run a mutation, then tell renderers which project (null = user/global) it affected. */
async function changed<T>(cwd: string | null, work: Promise<T>): Promise<T> {
	const result = await work;
	broadcast("skills:changed", { cwd });
	return result;
}

export function register(): void {
	const skills = new SkillService(
		appRunner,
		progress => broadcast("skills:progress", progress),
		edit => editConfig("global", undefined, edit),
	);

	handle("skills:list", cwd => skills.list(cwd));
	handle("skills:read", filePath => skills.read(filePath));
	handle("skills:setEnabled", (name, enabled) => changed(null, skills.setEnabled(name, enabled)));
	handle("skills:settings:get", () => skills.settings());
	handle("skills:settings:set", patch => changed(null, skills.setSettings(patch)));

	handle("skills:registry:search", (query, sort) => skills.search(query, sort));
	handle("skills:registry:info", id => skills.info(id));
	handle("skills:registry:version", (id, version) => skills.version(id, version));
	handle("skills:registry:installed", cwd => skills.installed(cwd));
	handle("skills:registry:install", request =>
		changed(request.global ? null : request.cwd, skills.install(request)),
	);
	handle("skills:registry:update", request => changed(request.global ? null : request.cwd, skills.update(request)));
	handle("skills:registry:uninstall", request =>
		changed(request.global ? null : request.cwd, skills.uninstall(request)),
	);
	handle("skills:cancel", opId => cancelOperation(opId));
}
