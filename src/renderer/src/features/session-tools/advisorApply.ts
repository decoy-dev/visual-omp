import type { AdvisorFile, AdvisorScope } from "@shared/contracts/advisor";
import type { SessionController } from "../../state/session";
import { press, readScreen, runCommand, sleep, waitForScreen } from "./drive";

export function isAdvisorConfigure(lines: readonly string[]): boolean {
	return lines.some(line => line.includes("Advisor configuration")) && lines.some(line => line.includes("Save & apply"));
}

/** Uses omp's own save callback to rediscover and apply the persisted roster without toggling advisor enablement. */
export async function applyAdvisorConfig(session: SessionController, scope: AdvisorScope): Promise<AdvisorFile> {
	const token = await window.vomp.invoke("advisor:beginApply", session.projectPath, scope);
	let finalized = false;
	const select = async (phrase: string) => {
		for (let step = 0; step < 512; step++) {
			const lines = await readScreen(session);
			if (!isAdvisorConfigure(lines)) throw new Error("omp closed the advisor editor before applying its configuration");
			if (lines.join(" ").includes(phrase)) return;
			await press(session, "down");
			await sleep(30);
		}
		throw new Error("Could not select omp's advisor configuration action");
	};
	try {
		await runCommand(session, "/advisor configure", { until: lines => isAdvisorConfigure(lines), timeoutMs: 8000 });
		if (scope === "user") {
			await select("Switch between the project");
			await press(session, "enter");
			if (!await waitForScreen(session, lines => lines.some(line => /Advisor configuration.*user/.test(line)), 5000)) throw new Error("omp did not open the user advisor configuration");
		}
		await select("Write this scope's WATCHDOG.yml");
		await press(session, "enter");
		await sleep(250);
		await press(session, "escape");
		if (!await waitForScreen(session, lines => lines.some(line => line.includes(`Saved ${scope} WATCHDOG.yml`)), 5000)) throw new Error("The advisor file was saved, but omp did not confirm applying it");
		finalized = true;
		return await window.vomp.invoke("advisor:finishApply", token);
	} catch (error) {
		if (isAdvisorConfigure(await readScreen(session).catch(() => []))) await press(session, "escape").catch(() => undefined);
		if (!finalized) await window.vomp.invoke("advisor:finishApply", token);
		throw error;
	}
}
