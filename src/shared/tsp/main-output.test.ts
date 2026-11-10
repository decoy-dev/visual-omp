import { describe, expect, it } from "vitest";
import { TspDocument } from "../../main/omp/tsp/apply";
import type { TspFrame, TspNode, TspOpen } from "../tsp";
import type { TspHostSnapshot } from "../tsp-host";
import { mainOutputFingerprint, mainOutputNodes, mainOutputText, outputLocations } from "./main-output";

function snapshot(nodes: readonly TspNode[], revision = 1): TspHostSnapshot {
	return {
		hostId: "feedback-fixture", generation: 1, epoch: 1, revision,
		negotiated: true, lifecycle: "live", documentGeneration: 1, failure: null,
		availability: { available: true, reason: null },
		surfaces: [{
			open: { id: "s:1", mode: "inline", role: "omp.session" },
			sequence: revision, closed: false, suspended: false, focus: null, settled: [], documentGeneration: 1,
			document: { id: "s:1", k: "col", c: [{ id: "main", k: "col", c: nodes }] },
		}],
	};
}

const text = (id: string, value: string): TspNode => ({ id, k: "text", p: { text: value } });
const feedbackRecordings = import.meta.glob<string>("../../main/omp/tsp/fixtures/18.18.3-feedback/*.messages.jsonl", { query: "?raw", import: "default", eager: true });

/** Actual decoded omp 18.18.3 messages, replayed without a process, provider or owner profile. */
function recordingFrames(name: string): TspHostSnapshot[] {
	const recording = Object.entries(feedbackRecordings).find(([path]) => path.endsWith(`/${name}.messages.jsonl`))?.[1];
	if (!recording) throw new Error(`Missing recorded command feedback: ${name}`);
	const documents = new Map<string, { open: TspOpen; doc: TspDocument; sequence: number; closed: boolean }>();
	const frames: TspHostSnapshot[] = [];
	for (const line of recording.trim().split("\n")) {
		const message = JSON.parse(line) as { verb: string; body: unknown };
		if (message.verb === "o") {
			const open = message.body as TspOpen;
			documents.set(open.id, { open, doc: new TspDocument(open.id), sequence: 0, closed: false });
		} else if (message.verb === "f") {
			const frame = message.body as TspFrame;
			const live = documents.get(frame.sf)!;
			expect(live.doc.applyFrame(frame), `${name}: frame ${frame.s}`).toEqual([]);
			live.sequence = frame.s;
			frames.push({
				...snapshot([], frames.length + 1),
				surfaces: [...documents.values()].map(({ open, doc, sequence, closed }) => ({
					open, sequence, closed, document: doc.snapshot(), focus: doc.focus,
					suspended: doc.suspended, settled: [...doc.settled], documentGeneration: 1,
				})),
			});
		} else if (message.verb === "x") {
			const close = message.body as { id: string };
			const live = documents.get(close.id)!;
			live.closed = true;
			live.doc.close();
		}
	}
	return frames;
}

const recordedCases = [
	{ name: "move-success", sequence: 3, nodeId: "p", text: "Moved to /tmp/vomp-fixture/destination", path: "/tmp/vomp-fixture/destination" },
	// The escaped punctuation below is literal omp output, preserved from the recording.
	{ name: "clear-success", sequence: 3, nodeId: "p", text: "Context reset \u2014 4 messages dropped; session continues." },
	{ name: "ssh-add", sequence: 3, nodeId: "k", text: '+ Added SSH host "fixture" to project config\n\n  Host: example.invalid\n\nRun /ssh list to see all configured hosts.' },
	{ name: "ssh-remove", sequence: 4, nodeId: "o", text: '- Removed SSH host "fixture" from project config' },
	{ name: "mcp-reload", sequence: 3, nodeId: "k", text: "Reloading MCP servers and runtime tools..." },
	{ name: "mcp-reload", sequence: 3, nodeId: "l", text: "MCP reload complete\n  Connected servers: 0\n  Connecting servers: 0" },
	{ name: "extension-throw", sequence: 3, nodeId: "k", text: 'Extension "command:audit-feedback-throw" error: Public fixture extension failure', tone: "err" },
	{
		name: "worktree-exit-ask", sequence: 4, nodeId: "m",
		text: "Moved to worktree /tmp/vomp-fixture/home/tmp/vomp-fixture/agent/wt/fixture-d54ba38 on branch fixture (checked out, uncommitted changes carried over).",
		path: "/tmp/vomp-fixture/home/tmp/vomp-fixture/agent/wt/fixture-d54ba38",
	},
] as const;

describe("mainOutputNodes with recorded omp 18.18.3 feedback", () => {
	it.each(recordedCases)("retains $name output at $nodeId", scenario => {
		const frames = recordingFrames(scenario.name);
		const arrival = frames.find(frame => frame.surfaces[0]!.sequence === scenario.sequence)!;
		const output = mainOutputNodes(arrival);
		const matches = output.filter(item => item.nodeId === scenario.nodeId);
		expect(matches).toHaveLength(1);
		const item = matches[0]!;
		expect(item.surfaceId).toBe("s:1");
		// Decorative icon spans are outside the literal message assertion.
		expect(item.text).toContain(scenario.text);
		expect(item.tone).toBe("tone" in scenario ? scenario.tone : "info");
		if ("path" in scenario) expect(item.locations).toContainEqual({ kind: "path", value: scenario.path });
		expect(typeof item.fingerprint).toBe("string");
		expect(() => JSON.parse(item.fingerprint)).not.toThrow();
		const previous = frames[frames.indexOf(arrival) - 1]!;
		expect(mainOutputNodes(previous).some(candidate => candidate.nodeId === scenario.nodeId)).toBe(false);
	});

	it("captures each bordered SSH block once, without its nested text node", () => {
		const frame = recordingFrames("ssh-remove").find(item => item.surfaces[0]!.sequence === 4)!;
		const output = mainOutputNodes(frame);
		expect(output.filter(item => item.text.includes("Added SSH host"))).toHaveLength(1);
		expect(output.filter(item => item.text.includes("Removed SSH host"))).toHaveLength(1);
		expect(output.some(item => ["l", "m", "n", "p", "q", "r"].includes(item.nodeId))).toBe(false);
	});

	it("keeps the worktree destination while its exit question is open", () => {
		const frame = recordingFrames("worktree-exit-ask").find(item => item.surfaces[0]!.sequence === 7)!;
		const output = mainOutputNodes(frame);
		expect(output.filter(item => item.nodeId === "m")).toHaveLength(1);
		expect(output.find(item => item.nodeId === "m")!.text).toContain(recordedCases[7].text);
		expect(output.some(item => item.text.includes("Remove worktree?"))).toBe(false);
		expect(output.some(item => item.text.includes("Creating worktree"))).toBe(false);
	});

	it("preserves named notices for the projection's reservation handling", () => {
		const frame = recordingFrames("extension-throw").find(item => item.surfaces[0]!.sequence === 2)!;
		expect(mainOutputNodes(frame)).toEqual([expect.objectContaining({
			nodeId: "i", tone: "warn",
			text: "No default model selected. Use /login, set an API key environment variable, or select a local model with /model or --model.",
		})]);
	});
});

describe("mainOutputNodes with source-derived synthetic nodes", () => {
	// These are source-shaped examples, not recorded /stats or OAuth sessions.
	// omp 18.18.3: packages/tui/src/overlays/stats-notice.ts:18-25 and
	// packages/tui/src/native/overlay.ts:119-162 (both actionButton presentations).
	it.each(["button", "row"] as const)("keeps the stats URL and raw %s label while omitting its redundant Result line", kind => {
		const url = "http://127.0.0.1:51239/";
		const message = `Dashboard available at: ${url} (sessions sync in the background)`;
		const label = "Open dashboard ↗";
		const action: TspNode = kind === "button"
			? { id: "stats/open", k: "button", p: { role: "omp.btn", text: label, actions: { click: "open" }, href: url, title: url } }
			: { id: "stats/open", k: "row", p: { role: "omp.btn", gap: "xs", align: "center", actions: { click: "open" }, href: url, title: url }, c: [text("stats/open/label", label)] };
		const stats: TspNode = { id: "stats", k: "row", p: { gap: "md", align: "center", wrap: true }, c: [
			{ id: "stats/message", k: "text", p: { role: "omp.stats", spans: [{ t: message }], wrap: "word", grow: 1 } }, action,
		] };
		const output = mainOutputNodes(snapshot([stats]));
		expect(output).toHaveLength(1);
		expect(output[0]).toMatchObject({ nodeId: "stats", text: `${message}\n${label}`, resultText: message, tone: "info", locations: [{ kind: "url", value: url }] });
	});

	it("only replaces a declared dashboard control when the Result offers that exact URL", () => {
		const url = "http://127.0.0.1:51239/";
		const label = "Open dashboard ↗";
		const control: TspNode = { id: "open", k: "button", p: { text: label, href: url, actions: { click: "open" } } };
		const root: TspNode = { id: "stats", k: "col", c: [text("url", `Dashboard: ${url}`), text("literal-label", label), control, text("note", "Keep this note from omp.")] };
		const output = mainOutputNodes(snapshot([root]))[0]!;
		expect(output.text).toBe(`Dashboard: ${url}\n${label}\n${label}\nKeep this note from omp.`);
		expect(output.resultText).toBe(`Dashboard: ${url}\n${label}\nKeep this note from omp.`);
		expect(mainOutputText(control, [])).toBe(label);
		expect(mainOutputText(control, [{ kind: "url", value: "http://127.0.0.1:1/" }])).toBe(label);
		const other: TspNode = { ...control, p: { ...control.p, text: "Open authorization URL" } };
		expect(mainOutputNodes(snapshot([other]))[0]!.resultText).toBeUndefined();
	});

	it("keeps control-related notes and fingerprints changes in the Result presentation", () => {
		const action = { href: "http://127.0.0.1:51239/", actions: { click: "open" } };
		const label = text("label", "Open dashboard ↗");
		const note = text("note", "Authorization is required.");
		const separate: TspNode = { id: "stats", k: "col", c: [{ id: "open", k: "row", p: action, c: [label] }, note] };
		const grouped: TspNode = { id: "stats", k: "col", c: [{ id: "open", k: "row", p: action, c: [label, note] }] };
		expect(mainOutputText(separate)).toBe(mainOutputText(grouped));
		expect(mainOutputNodes(snapshot([separate]))[0]!.resultText).toBe("Authorization is required.");
		expect(mainOutputNodes(snapshot([grouped]))[0]!.resultText).toBeUndefined();
		expect(mainOutputFingerprint(grouped)).not.toBe(mainOutputFingerprint(separate));
	});

	// omp 18.18.3: mcp-command-controller.ts:168-179,198-205,843-881.
	// URLs are synthetic public examples. No authorization recording is available.
	it("preserves OAuth href parameters, fallback copy text and manual callback guidance", () => {
		const url = "https://auth.example.invalid/authorize?client_id=public-fixture&redirect_uri=http%3A%2F%2F127.0.0.1%3A51240%2Fcallback&state=fixture-state&code_challenge=fixture-challenge";
		const local = "http://127.0.0.1:51240/launch";
		const copyRow = (id: string, label: string, href: string): TspNode => ({ id, k: "text", p: {
			spans: [{ t: `${label} `, s: "muted" }, { t: href, s: "mono", href }],
			wrap: "char", href, actions: { click: "copy", menu: ["copy", "open"] }, title: "Copy URL",
		} });
		const prompt: TspNode = { id: "oauth-link", k: "col", p: { gap: "xs" }, c: [
			{ id: "oauth-link/title", k: "text", p: { spans: [{ t: "Open authorization URL:", s: "success" }] } },
			{ id: "oauth-link/open", k: "text", p: { spans: [{ t: "Click here to authorize", s: "link", href: url }], href: url, actions: { click: "open", menu: ["open", "copy"] } } },
			copyRow("oauth-link/copy", "Copy URL:", url),
			copyRow("oauth-link/local", "Local shortcut (this machine only):", local),
		] };
		const block: TspNode = { id: "oauth", k: "col", c: [
			text("oauth/wait", "Waiting for authorization... (Press Esc to cancel, 5 minute timeout)"),
			text("oauth/manual", "Headless? Paste the redirect URL or code with /login <value>."),
			text("oauth/fallback", "Alternative if browser did not open:"), prompt,
		] };
		const output = mainOutputNodes(snapshot([block]));
		expect(output).toHaveLength(1);
		expect(output[0]).toMatchObject({
			nodeId: "oauth", tone: "info",
			text: [
				"Waiting for authorization... (Press Esc to cancel, 5 minute timeout)",
				"Headless? Paste the redirect URL or code with /login <value>.",
				"Alternative if browser did not open:", "Open authorization URL:",
				"Click here to authorize", `Copy URL: ${url}`, `Local shortcut (this machine only): ${local}`,
			].join("\n"),
			locations: [{ kind: "url", value: url }, { kind: "url", value: local }],
		});
	});

	it("retains a link-only recovery URL when the label does not contain it", () => {
		const url = "https://auth.example.invalid/authorize?state=public-fixture&scope=read%20write";
		const output = mainOutputNodes(snapshot([{ id: "authorization", k: "text", p: {
			spans: [{ t: "Click here to authorize", s: "link", href: url }], href: url,
			actions: { click: "open", menu: ["open", "copy"] },
		} }]));
		expect(output).toEqual([expect.objectContaining({ text: "Click here to authorize", locations: [{ kind: "url", value: url }] })]);
	});

	it("returns the complete eligible root once across roleless nested groups", () => {
		const root: TspNode = { id: "outer", k: "col", c: [
			text("first", "First line"),
			{ id: "nested", k: "row", c: [{ id: "inner", k: "col", c: [text("last", "Last line")] }] },
		] };
		expect(mainOutputNodes(snapshot([root]))).toEqual([expect.objectContaining({ nodeId: "outer", text: "First line\nLast line" })]);
	});

	it.each([
		"omp.user", "omp.user.tools", "omp.assistant", "omp.assistant.text", "omp.thinking", "omp.tool", "omp.tool.result", "omp.agent",
		"omp.activity", "omp.compaction", "omp.plan.body", "omp.plan.options", "omp.overlay.planReview",
	])("excludes %s and its descendants", role => {
		const excluded: TspNode = { id: "owned", k: "col", p: { role }, c: [text("owned/body", "Owned transcript content")] };
		expect(mainOutputNodes(snapshot([excluded, text("feedback", "Independent feedback")]))).toEqual([
			expect.objectContaining({ nodeId: "feedback", text: "Independent feedback" }),
		]);
	});

	it("excludes hidden nodes and hide spans without leaking their locations", () => {
		const output = mainOutputNodes(snapshot([
			{ id: "hidden", k: "col", p: { hidden: true }, c: [text("hidden/body", "Hidden /private/secret.txt")] },
			{ id: "visible", k: "col", c: [
				{ id: "message", k: "text", p: { spans: [{ t: "Visible feedback" }, { t: "Hidden https://secret.example.invalid/token", s: "mono hide" }] } },
				{ id: "hidden-child", k: "text", p: { hidden: true, text: "Hidden child /private/key.pem" } },
			] },
		]));
		expect(output).toEqual([expect.objectContaining({ nodeId: "visible", text: "Visible feedback", locations: [] })]);
	});

	it.each(["input", "editor"] as const)("never captures %s values or partially claims their containing group", kind => {
		const form: TspNode = { id: "form", k: "col", c: [
			text("form/label", "Enter API key"), { id: "form/secret", k: kind, p: { text: "secret-key-fixture-do-not-echo" } },
		] };
		expect(mainOutputNodes(snapshot([form, text("feedback", "Separate feedback")]))).toEqual([
			expect.objectContaining({ nodeId: "feedback", text: "Separate feedback" }),
		]);
	});

	it("preserves literal markdown and multiline text without interpreting their wording as tone", () => {
		const message = "**Connection report**\n\nFailed servers: 0\nOutput: /tmp/public-fixture/report.md";
		const output = mainOutputNodes(snapshot([{ id: "report", k: "md", p: { text: message } }]));
		expect(output).toEqual([expect.objectContaining({
			nodeId: "report", text: message, tone: "info",
			locations: [{ kind: "path", value: "/tmp/public-fixture/report.md" }],
		})]);
	});

	it("excludes tool-kind bodies even without a replicated role", () => {
		const tool: TspNode = {
			id: "tool", k: "tool", p: { name: "read", title: "Read", status: "done", target: "/private/secret.txt" },
			c: [text("tool/body", "Private tool result")],
		};
		expect(mainOutputNodes(snapshot([tool, text("feedback", "Independent feedback")]))).toEqual([
			expect.objectContaining({ nodeId: "feedback", text: "Independent feedback" }),
		]);
	});

	it("ignores dock and layer text, including input secrets outside main", () => {
		const state = snapshot([text("feedback", "Main feedback")]);
		state.surfaces[0]!.document = { id: "s:1", k: "col", c: [
			...state.surfaces[0]!.document.c!,
			{ id: "dock", k: "col", c: [text("dock/body", "Dock secret")] },
			{ id: "layer", k: "col", c: [{ id: "layer/input", k: "input", p: { text: "Layer secret" } }] },
		] };
		expect(mainOutputNodes(state)).toEqual([expect.objectContaining({ nodeId: "feedback", text: "Main feedback" })]);
	});

	it("fingerprints visible semantic content independently of presentation and child ids", () => {
		const original: TspNode = { id: "feedback", k: "col", c: [{ id: "first-child", k: "text", p: { spans: [{ t: "A visible message", s: "muted" }] } }] };
		const styled: TspNode = { id: "feedback", k: "col", p: { gap: "lg" }, c: [
			{ id: "replacement-child", k: "text", p: { spans: [{ t: "A visible message", s: "bold mono" }] } },
			{ id: "hidden-child", k: "text", p: { hidden: true, text: "Hidden changed message" } },
		] };
		const before = mainOutputNodes(snapshot([original]))[0]!;
		const after = mainOutputNodes(snapshot([styled], 2))[0]!;
		expect(JSON.stringify(JSON.parse(before.fingerprint))).toBe(before.fingerprint);
		expect(after.fingerprint).toBe(before.fingerprint);
		expect(mainOutputNodes(snapshot([text("feedback", "A changed message")]))[0]!.fingerprint).not.toBe(before.fingerprint);
	});

	it("changes the fingerprint when an href or semantic tone changes", () => {
		const feedback = (href: string, tone: "info" | "error"): TspNode => ({ id: "feedback", k: "text", p: { text: "Open result", href, tone } });
		const first = mainOutputNodes(snapshot([feedback("https://example.invalid/first", "info")]))[0]!;
		const hrefChanged = mainOutputNodes(snapshot([feedback("https://example.invalid/second", "info")]))[0]!;
		const toneChanged = mainOutputNodes(snapshot([feedback("https://example.invalid/first", "error")]))[0]!;
		expect(hrefChanged.fingerprint).not.toBe(first.fingerprint);
		expect(toneChanged.fingerprint).not.toBe(first.fingerprint);
		expect(toneChanged.tone).toBe("err");
	});
});

it("keeps path spaces and branch-like path segments without trimming the local destination", () => {
	expect(outputLocations("Moved to /tmp/project on branch notes.")).toEqual([{ kind: "path", value: "/tmp/project on branch notes." }]);
	expect(outputLocations("Moved to worktree /tmp/project on branch notes/wt/new on branch fixture (checked out, uncommitted changes carried over).")).toEqual([
		{ kind: "path", value: "/tmp/project on branch notes/wt/new" },
	]);
});
