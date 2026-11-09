import { describe, expect, it } from "vitest";
import type { TspNode } from "../tsp";
import { commandReport } from "./reports";
import { settledCommandPanel } from "./command-panels";
import { hasUnclaimedDockPanel } from "./dock-panels";
import { isClaimable, TSP_ROLES } from "./roles";
import { commandOutcome, commandOutcomeSpec } from "./command-result";
import { openOverlay, unclaimed, walkNodes } from "./view-state";
import { commandPanelFrames, replacePanelChild } from "./testing/command-panel-fixtures";
import type { TspSurfaceSnapshot } from "../tsp-host";
import formStages185 from "../../main/omp/tsp/fixtures/18.18.5/ask-fixture-form-tabs.ask.json";
import formStages183 from "../../main/omp/tsp/fixtures/18.18.3/ask-html-form.ask.json";

const reportNames = ["tools", "changelog", "jobs-full", "advisor-status", "ssh-list", "ssh-help", "mcp-help", "mcp-list", "mcp-resources", "mcp-prompts", "mcp-notifications"];
const nodes = (name: string) => commandPanelFrames(name).flatMap(snapshot => snapshot.surfaces.flatMap(surface => [...walkNodes(surface.document)]));
const recordedReport = () => structuredClone(nodes("advisor-status").find(node => node.p?.role === TSP_ROLES.report)!);
const recordedPanel = (name: "cleanse" | "omfg-error-panel") => structuredClone(nodes(name).findLast(node => node.p?.role === (name === "cleanse" ? TSP_ROLES.cleanse : TSP_ROLES.omfg))!);

describe("read-only command reports", () => {
	it.each(reportNames)("preserves %s title, complete body and exact Close declaration", name => {
		const node = nodes(name).find(item => item.p?.role === TSP_ROLES.report)!;
		const report = commandReport(node);
		expect(report?.title).toBeTruthy(); expect(report?.lines.length).toBeGreaterThan(0);
		expect(report?.close.act).toBe("close"); expect(isClaimable(node)).toBe(true);
		const surface = commandPanelFrames(name).find(snapshot => openOverlay(snapshot.surfaces, true))!.surfaces[0]!;
		expect(openOverlay([surface], false, new Map([[surface.open.id, new Set([node.id])]]))).toBeNull();
		expect(openOverlay([surface], false, new Map())).not.toBeNull();
	});
	it.each(["tools", "changelog"])("preserves the recorded %s Markdown body and its format", name => {
		const node = nodes(name).find(item => item.p?.role === TSP_ROLES.report)!;
		const markdown = [...walkNodes(node)].find(item => item.k === "md")!;
		expect(commandReport(node)).toMatchObject({ markdown: true, lines: markdown.k === "md" ? markdown.p!.text!.split("\n") : [] });
	});
	it("keeps text-only and mixed reports in plain text", () => {
		const node = recordedReport();
		expect(commandReport(node)?.markdown).toBe(false);
		const body = [...walkNodes(node)].find(item => item.p?.role === TSP_ROLES.reportBody)!;
		body.c = [...body.c!, { id: "additional-markdown", k: "md", p: { text: "## A separate Markdown section" } }];
		expect(commandReport(node)).toMatchObject({ markdown: false, lines: ["Advisor is disabled.", "## A separate Markdown section"] });
	});
	it.each(["action", "body", "stream", "outside"])("leaves an unsupported %s report to the omp screen", kind => {
		const report = recordedReport();
		if (kind === "action") report.c = [...report.c!, { id: "new-action", k: "button", p: { text: "Delete", actions: { click: "delete" } } }];
		if (kind === "body") report.c = [...report.c!, { id: "image", k: "image", p: { alt: "Unknown report content" } }];
		if (kind === "stream") report.c = [...report.c!, { id: "live", k: "md", p: { text: "Pending", stream: true } }];
		if (kind === "outside") report.c = [...report.c!, { id: "extra", k: "text", p: { text: "Additional unrendered content" } }];
		expect(commandReport(report)).toBeNull(); expect(isClaimable(report)).toBe(false);
	});
	it.each(["memory-stats", "memory-diagnose", "memory-queue", "memory-mm-list", "memory-mm-show", "memory-mm-history"])("retains recorded unavailable %s feedback without claiming a report", name => {
		expect(nodes(name).some(node => node.p?.role === TSP_ROLES.noticeWarning || node.p?.role === TSP_ROLES.noticeError)).toBe(true);
		expect(nodes(name).some(node => commandReport(node))).toBe(false);
	});
	it.each(["Memory Stats", "Memory Diagnostics", "Memory Queue", "Mental Models", "Mental Model", "Mental Model History"])("accepts the source-defined %s report using the recorded read-only contract", title => {
		const node = recordedReport(); if (node.k === "overlay") node.p!.head = title;
		expect(commandReport(node)?.title).toBe(title);
	});
});

describe("settled command panels", () => {
	it("keeps active panels and settled failures discoverable after questions close", () => {
		for (const name of ["cleanse", "omfg-error-panel"] as const) {
			for (const frame of commandPanelFrames(name).filter(snapshot => snapshot.surfaces.some(surface => [...walkNodes(surface.document)].some(node => node.p?.role === TSP_ROLES.cleanse || node.p?.role === TSP_ROLES.omfg)))) expect(hasUnclaimedDockPanel(frame.surfaces, new Map())).toBe(true);
		}
	});
	it("reads the recorded unsupported cleanse outcome rather than an unrelated toast", () => {
		const frames = commandPanelFrames("cleanse");
		expect(settledCommandPanel(recordedPanel("cleanse"))).toMatchObject({ status: "warning", lines: ["No runnable checker", "No supported checker with an available executable was found."] });
		expect(commandOutcome(frames[0]!, frames.at(-1)!, commandOutcomeSpec("/cleanse")!)?.lines[0]).toBe("No runnable checker");
	});
	it.each([["Clean", "success"], ["Diagnostics remain", "warning"], ["No runnable checker", "warning"], ["Cancelled", "cancelled"], ["Error", "error"]])("distinguishes source-defined cleanse outcome %s", (outcome, status) => {
		const panel = recordedPanel("cleanse"); const footer = panel.c!.at(-1)!;
		replacePanelChild(footer, 0, { id: "outcome", k: "text", p: { spans: [{ t: outcome!, s: status! }] } });
		expect(settledCommandPanel(panel)).toMatchObject({ status, lines: [outcome, "No supported checker with an available executable was found."] });
	});
	it("retains the recorded omfg failure details and source-defined saved rule path", () => {
		const error = recordedPanel("omfg-error-panel");
		expect(settledCommandPanel(error)).toMatchObject({ status: "error", lines: ["Error", "Could not create rule.", "The model did not return a valid TTSR rule."] });
		const saved = structuredClone(error); const path = "/tmp/project/.omp/rules/use-context.md";
		replacePanelChild(saved, 1, { id: "saved", k: "text", p: { text: `Saved ${path}` } });
		replacePanelChild(saved.c!.at(-1)!, 0, { id: "registered", k: "text", p: { text: `Registered live · ${path}` } });
		expect(settledCommandPanel(saved)?.path).toBe(path);
	});
	it("does not claim new controls, unknown outcomes or routine HUD/editor/activity rows", () => {
		const panel = recordedPanel("cleanse"); panel.c = [...panel.c!, { id: "unknown", k: "button", p: { text: "Apply", actions: { click: "apply" } } }];
		expect(settledCommandPanel(panel)).toBeNull(); expect(isClaimable(panel)).toBe(false);
		const frame = commandPanelFrames("cleanse").at(-1)!; const surface = structuredClone(frame.surfaces[0]!);
		surface.document.c = [{ id: "dock", k: "col", c: ["omp.hud", TSP_ROLES.editor, TSP_ROLES.activity, TSP_ROLES.loader].map((role, index): TspNode => ({ id: `${index}`, k: "col", p: { role }, c: [{ id: `${index}-button`, k: "button", p: { text: "Routine action" } }] })) }];
		expect(hasUnclaimedDockPanel([surface], new Map())).toBe(false);
	});
	it("releases an exact panel claim when its Result row is no longer mounted", () => {
		const snapshot = commandPanelFrames("cleanse").at(-1)!; const surface = snapshot.surfaces[0]!;
		const panel = [...walkNodes(surface.document)].find(node => node.p?.role === TSP_ROLES.cleanse)!;
		expect(unclaimed(surface, "dock", new Set([panel.id])).some(node => JSON.stringify(node).includes("No runnable checker"))).toBe(false);
		expect(hasUnclaimedDockPanel(snapshot.surfaces, new Map([[surface.open.id, new Set([panel.id])]]))).toBe(false);
		expect(hasUnclaimedDockPanel(snapshot.surfaces, new Map())).toBe(true);
	});
});

it.each(["href", "hovercard", "children"])("leaves unsupported Close button %s content unclaimed", kind => {
	const node = recordedReport(); const close = [...walkNodes(node)].find(child => child.k === "button")!;
	if (kind === "href") close.p = { ...close.p, href: "https://example.invalid" };
	if (kind === "hovercard") close.p = { ...close.p, hovercard: { k: "text", p: { text: "Extra details" } } };
	if (kind === "children") close.c = [{ id: "extra", k: "text", p: { text: "Extra details" } }];
	expect(commandReport(node)).toBeNull();
});

it("keeps rule labels and leaves linked panel spans to fallback", () => {
	const node = recordedPanel("cleanse"); node.c = [node.c![0]!, { id: "rule-label", k: "rule", p: { label: "Checker details" } }, ...node.c!.slice(1)];
	expect(settledCommandPanel(node)?.lines).toContain("Checker details");
	node.c = [node.c![0]!, { id: "link", k: "text", p: { spans: [{ t: "Checker help", href: "https://example.invalid" }] } }, ...node.c!.slice(1)];
	expect(settledCommandPanel(node)).toBeNull();
});

it("keeps unsupported ask content out of automatic screens without hiding it from manual views", () => {
	const surface = structuredClone(commandPanelFrames("cleanse").at(-1)!.surfaces[0]!);
	const form: TspNode = { id: "ask-form", k: "col", p: { role: TSP_ROLES.askForm }, c: [{ id: "ask-form/text", k: "text", p: { text: "Release choices" } }] };
	const ask: TspNode = { id: "ask-editor", k: "col", p: { role: TSP_ROLES.editorAsk }, c: [
		form, { id: "ask-actions", k: "row", c: [{ id: "ask-submit", k: "button", p: { text: "Submit", actions: { click: "submit" } } }] },
	] };
	surface.document.c = [{ id: "dock", k: "col", c: [ask] }];
	expect(hasUnclaimedDockPanel([surface], new Map())).toBe(false);
	expect(hasUnclaimedDockPanel([surface], new Map([[surface.open.id, new Set([ask.id])]]))).toBe(false);
	expect(unclaimed(surface, "dock").flatMap(node => [...walkNodes(node)]).some(node => node.id === ask.id)).toBe(true);
	ask.p = { ...ask.p, hidden: true };
	expect(hasUnclaimedDockPanel([surface], new Map())).toBe(false);
});

it.each([...formStages183.stages, ...formStages185.stages].filter(stage => stage.request))("never auto-opens the recorded ask presentation at $stage", stage => {
	const surfaces = stage.surfaces as unknown as TspSurfaceSnapshot[];
	expect(hasUnclaimedDockPanel(surfaces, new Map())).toBe(false);
	for (const surface of surfaces) {
		expect(unclaimed(surface, "dock").flatMap(node => [...walkNodes(node)]).some(node => node.p?.role === TSP_ROLES.editorAsk || node.p?.role === TSP_ROLES.editorAskHidden)).toBe(true);
	}
});
