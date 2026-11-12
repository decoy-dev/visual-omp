import { createRoot } from "react-dom/client";
import { Profiler, useMemo, useState } from "react";
import { shellProps, type ShellVizPresentation } from "@shared/tsp/shell";
import { bashRenderer } from "../../../tool-render/tools/bash";
import type { ToolRenderHost } from "../../../tool-render/types";
import { ShellView } from "../ShellView";
import { MotionProvider } from "../../../ui/motion";
import { TooltipProvider } from "../../../ui/Tooltip";
import "../../../i18n";
import "../../../theme/tokens.css";
import "../../../theme/base.css";
import "../../../ui/ui.css";
import "../../../tool-render/tool-render.css";

const cases = ["rows", "four", "huge-row", "huge-value", "row-segments", "response-bytes"] as const;
type Case = typeof cases[number];
const measurements: { phase: string; durationMs: number; scenario: Case }[] = [];
const output = Array.from({ length: 120 }, (_, index) => `Ordinary output ${index}`).join("\n");
const command = Array.from({ length: 2000 }, (_, index) => `printf 'fixture ${index}\\n'`).join("\n");
function presentation(scenario: Case): ShellVizPresentation {
	const rows = Array.from({ length: 2000 }, (_, index) => ({ id: `fixture-${index}`, node: `opaque-fixture-${index}`, depth: 0, segments: [{ text: `printf 'fixture ${index}\\n'`, node: `opaque-fixture-${index}` }], effects: [] }));
	const result: ShellVizPresentation = {
		preferences: { view: "pseudo", layers: { color: true, inline: true, idioms: true, effects: true, unwrap: true }, split: false, playing: false, speed: 1, expandedNodes: [] },
		rows, original: rows, output: "Retained fixture output", watches: [], executing: false,
		timeline: { length: 20_000, cursor: 20_000, elapsedNs: 1e9, durationNs: 1e9, trimmed: true },
	};
	if (scenario === "huge-row") rows[0]!.segments = [{ text: "x".repeat(64 * 1024 + 1), node: "opaque-fixture-0" }];
	if (scenario === "huge-value") result.watches = [{ name: "fixture", value: "x".repeat(16 * 1024 + 1) }];
	if (scenario === "row-segments") rows[0]!.segments = Array.from({ length: 1025 }, () => ({ text: "x", node: "opaque-fixture-0" }));
	if (scenario === "response-bytes") result.output = "x".repeat(2 * 1024 * 1024 + 1);
	return result;
}
function Harness() {
	const [scenario, setScenario] = useState<Case>("rows");
	const props = useMemo(() => shellProps({ presentation: presentation(scenario) }), [scenario]);
	const host = useMemo<ToolRenderHost>(() => ({ renderShellCommand: (source, fallback) => props ? <ShellView props={props} command={source} disabled showOutput={false} /> : fallback }), [props]);
	const Body = bashRenderer.Body!;
	return <MotionProvider><TooltipProvider><main className="mx-auto max-w-[760px] space-y-4 bg-sheet p-4 text-fg">
		<h1 className="text-xl font-semibold">Bash visualization resource fixtures</h1><p>Synthetic canonical-shaped data exercises production renderer budgets and ordinary-output fallback. These rows do not describe an executed command.</p>
		<label htmlFor="scenario">Boundary case </label><select id="scenario" value={scenario} onChange={event => setScenario(event.currentTarget.value as Case)}>{cases.map(name => <option key={name}>{name}</option>)}</select>
		<p data-guard-outcome>{props ? "Presentation admitted" : "Presentation refused; ordinary command and output retained"}</p>
		<Profiler id="shell-budget" onRender={(_id, phase, durationMs) => measurements.push({ phase, durationMs, scenario })}>
			{Array.from({ length: scenario === "four" ? 4 : 1 }, (_, index) => <section key={`${scenario}-${index}`} data-budget-viewer><Body name="bash" args={{ command }} result={{ content: [{ type: "text", text: output }] }} host={host} /></section>)}
		</Profiler>
	</main></TooltipProvider></MotionProvider>;
}
Object.defineProperty(window, "shellPerformanceFixture", { value: { measurements: () => measurements, output } });
createRoot(document.getElementById("root")!).render(<Harness />);
