import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Resolve aliases even when the destination's last directories do not exist yet. */
async function canonicalDestination(path: string): Promise<string> {
	try { return await realpath(path); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = dirname(path);
		if (parent === path) throw error;
		return join(await canonicalDestination(parent), relative(parent, path));
	}
}

/** Another omp release must never write into the committed baseline, including through aliases. */
export async function recordingDestination(version: string, destination?: string, baseline = resolve("src/main/omp/tsp/fixtures/18.15.0")): Promise<string> {
	const target = resolve(destination ?? baseline);
	if (version === "18.15.0") return target;
	if (!destination) throw new Error("Comparing another omp version requires a separate VOMP_TSP_FIXTURE_DIR.");
	const [canonicalBaseline, canonicalTarget] = await Promise.all([realpath(baseline), canonicalDestination(target)]);
	const withinBaseline = relative(canonicalBaseline, canonicalTarget);
	if (withinBaseline === "" || (!isAbsolute(withinBaseline) && withinBaseline !== ".." && !withinBaseline.startsWith(`..${sep}`))) {
		throw new Error("Comparing another omp version requires a separate VOMP_TSP_FIXTURE_DIR.");
	}
	return canonicalTarget;
}
