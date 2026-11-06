import type { AssistantMessage, SessionEntry, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { describe, expect, it } from "vitest";
import type { ActiveTool } from "../../collab/lib/client";
import { deriveSubjects, isVisualCall, namedPaths, relatedPaths, sequencePatterns, type SubjectInput } from "./subjects";

function assistant(id = "draw", name = "write", args: Record<string, unknown> = { path: "poster.svg", content: "<svg>" }, timestamp = 200): AssistantMessage {
	return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp, stopReason: "toolUse", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } };
}

function entry(message: AssistantMessage | ToolResultMessage, id = "entry"): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: new Date(message.timestamp).toISOString(), message };
}

function user(timestamp = 100): SessionEntry {
	return { type: "message", id: `user:${timestamp}`, parentId: null, timestamp: new Date(timestamp).toISOString(), message: { role: "user", content: "Draw a poster", timestamp } };
}

function result(isError = false, details?: unknown, content: ToolResultMessage["content"] = []): ToolResultMessage {
	return { role: "toolResult", toolCallId: "draw", toolName: "write", isError, details, content, timestamp: 600 };
}

function input(overrides: Partial<SubjectInput> = {}): SubjectInput {
	return { stream: assistant(), streamDone: false, activeTools: new Map(), backgroundTools: new Map(), entries: [user()], changes: [], working: true, folder: "/project/work", now: 1000, ...overrides };
}

function running(id = "draw", args: unknown = { path: "poster.svg", content: "<svg>" }, name = "write", startedAt = 300): ActiveTool {
	return { toolCallId: id, toolName: name, args, startedAt };
}

describe("current-turn live subjects", () => {
	it.each([["poster.svg", "svg"], ["flow.mmd", "mermaid"], ["flow.mermaid", "mermaid"], ["page.html", "html"], ["page.htm", "html"], ["report.md", "markdown"], ["report.markdown", "markdown"], ["data.csv", "csv"], ["data.tsv", "csv"]])("renders %s as %s source before execution", (path, format) => {
		const [subject] = deriveSubjects(input({ stream: assistant("draw", "write", { path, content: "partial" }) }), []);
		expect(subject).toMatchObject({ id: "call:draw", kind: "source", format, path: `/project/work/${path}`, text: "partial", state: "writing", revision: 1 });
	});

	it("preserves identity and revision through execution and saving when content stays unchanged", () => {
		const writing = deriveSubjects(input(), []);
		const activeTools = new Map([["draw", running()]]);
		const live = deriveSubjects(input({ streamDone: true, activeTools, now: 1100 }), writing);
		expect(live[0]).toMatchObject({ id: writing[0].id, revision: 1, state: "running", startedAt: writing[0].startedAt, updatedAt: writing[0].updatedAt });
		const saved = deriveSubjects(input({ stream: null, entries: [user(), entry(assistant()), entry(result())], working: false }), live);
		expect(saved[0]).toMatchObject({ id: writing[0].id, revision: 1, state: "saved" });
	});

	it("increments revision exactly when displayed content changes", () => {
		const first = deriveSubjects(input(), []);
		const second = deriveSubjects(input({ stream: assistant("draw", "write", { path: "poster.svg", content: "<svg><rect/>" }), now: 1100 }), first);
		expect(second[0]).toMatchObject({ revision: 2, updatedAt: 1100, startedAt: first[0].startedAt });
		expect(deriveSubjects(input({ stream: assistant("draw", "write", { path: "poster.svg", content: "<svg><rect/>" }), now: 1200 }), second)[0]).toMatchObject({ revision: 2, updatedAt: 1100 });
	});

	it("preserves UTF-8 byte size when unchanged source is derived again", () => {
		const snapshot = input({ stream: assistant("draw", "write", { path: "poster.svg", content: "😀é" }) });
		const first = deriveSubjects(snapshot, []);
		expect(first[0].size).toBe(6);
		expect(deriveSubjects({ ...snapshot, now: 2000 }, first)[0]).toMatchObject({ size: 6, revision: 1 });
		expect(deriveSubjects({ ...snapshot, stream: assistant("draw", "write", { path: "poster.svg", content: "😀éé" }) }, first)[0]).toMatchObject({ size: 8, revision: 2 });
	});

	it.each([{ isError: true, details: undefined, state: "failed" }, { isError: true, details: { __synthetic: true, source: "interrupt_skipped", executed: false }, state: "skipped" }, { isError: true, details: { __interrupted: true, source: "interrupt_skipped", execution: "started" }, state: "skipped" }])("records $state after a result", ({ isError, details, state }) => {
		const first = deriveSubjects(input(), []);
		const next = deriveSubjects(input({ stream: null, entries: [user(), entry(assistant()), entry(result(isError, details))] }), first);
		expect(next[0]).toMatchObject({ state, revision: first[0].revision });
	});

	it("stops aborted arguments and turns ending without a result", () => {
		const first = deriveSubjects(input(), []);
		expect(deriveSubjects(input({ stream: { ...assistant(), stopReason: "aborted" }, streamDone: true }), first)[0].state).toBe("stopped");
		expect(deriveSubjects(input({ working: false }), first)[0].state).toBe("stopped");
		expect(deriveSubjects(input({ stream: null, working: false }), first)[0]).toMatchObject({ state: "stopped", revision: 1, text: "<svg>" });
	});

	it("ignores sources and watcher events from before the last user message", () => {
		const previous = deriveSubjects(input(), []);
		const next = deriveSubjects(input({ entries: [user(), entry(assistant()), user(700)], activeTools: new Map([["draw", running()]]), changes: [{ watchId: "watch", path: "/project/work/old.png", size: 20, mtimeMs: 500 }] }), previous);
		expect(next).toEqual([]);
	});

	it("keeps only the newest turn, including collab guest prompts", () => {
		const prompt: SessionEntry = { type: "custom_message", id: "guest", parentId: null, timestamp: new Date(700).toISOString(), customType: "collab-prompt", content: "New request", display: true };
		expect(deriveSubjects(input({ stream: null, entries: [user(), entry(assistant()), prompt] }), [])).toEqual([]);
	});

	it("marks collab elision and switches to saved file when the tool completes", () => {
		const stream = assistant("draw", "write", { path: "report.md", content: "large…[250000 chars elided for collab session]" });
		const first = deriveSubjects(input({ stream }), []);
		expect(first[0].elided).toBe(true);
		const next = deriveSubjects(input({ stream: null, entries: [user(), entry(stream), entry(result())], working: false }), first);
		expect(next).toHaveLength(1);
		expect(next[0]).toMatchObject({ id: "call:draw", kind: "file", format: "markdown", text: null, elided: false, state: "saved", revision: 2 });
	});

	it("replaces elided SVG with its complete watcher file", () => {
		const stream = assistant("draw", "write", { path: "poster.svg", content: "…[12 chars elided for collab session]" });
		const next = deriveSubjects(input({ stream, activeTools: new Map([["draw", running("draw", { path: "poster.svg", content: "…[12 chars elided for collab session]" })]]), changes: [{ watchId: "w", path: "/project/work/poster.svg", size: 200, mtimeMs: 500 }] }), []);
		expect(next).toHaveLength(1);
		expect(next[0]).toMatchObject({ id: "call:draw", kind: "file", format: "svg", elided: false, toolCallId: "draw" });
		expect(deriveSubjects(input({ stream, activeTools: new Map([["draw", running("draw", { path: "poster.svg", content: "…[12 chars elided for collab session]" })]]), changes: [{ watchId: "w", path: "/project/work/poster.svg", size: 200, mtimeMs: 500 }], now: 2000 }), next)[0].revision).toBe(next[0].revision);
	});

	it("folds a write's own save into its source subject and keeps a later command's save as a file", () => {
		const saved = input({ stream: null, entries: [user(), entry(assistant()), entry(result())], working: true, changes: [{ watchId: "w", path: "/project/work/poster.svg", size: 200, mtimeMs: 400 }] });
		const own = deriveSubjects(saved, []);
		expect(own.map(subject => subject.id)).toEqual(["call:draw"]);
		// collab can deliver the call's start after the file was written, so the save predates the call's window.
		const early = deriveSubjects({ ...saved, changes: [{ watchId: "w", path: "/project/work/poster.svg", size: 200, mtimeMs: 150 }] }, []);
		expect(early.map(subject => subject.id)).toEqual(["call:draw"]);
		const bash = { ...running("redraw", { command: "python draw.py poster.svg" }, "bash", 700) };
		const later = deriveSubjects({ ...saved, activeTools: new Map([["redraw", bash]]), changes: [{ watchId: "w", path: "/project/work/poster.svg", size: 300, mtimeMs: 900 }] }, own);
		expect(later.map(subject => subject.id).sort()).toEqual(["call:draw", "file:/project/work/poster.svg"]);
		expect(later.find(subject => subject.kind === "file")).toMatchObject({ toolCallId: "redraw", format: "svg" });
	});

	it.each(["/tmp/work", "/private/tmp/work"])("folds macOS watcher aliases into the write under %s", folder => {
		const snapshot = input({
			folder, platform: "darwin",
			stream: assistant("draw", "write", { path: "poster.svg", content: "<svg/>" }),
			activeTools: new Map([["draw", running()]]),
			changes: [{ watchId: "w", path: folder.startsWith("/private") ? "/tmp/work/poster.svg" : "/private/tmp/work/poster.svg", size: 200, mtimeMs: 500 }],
		});
		expect(deriveSubjects(snapshot, [])).toEqual([expect.objectContaining({ id: "call:draw", path: `${folder}/poster.svg` })]);
	});

	it("merges watcher aliases by newest modification and keeps one stable file identity", () => {
		const snapshot = input({ stream: null, folder: "/tmp/work", platform: "darwin", changes: [
			{ watchId: "w", path: "/private/tmp/work/frames.png", size: 20, mtimeMs: 500 },
			{ watchId: "w", path: "/tmp/work/frames.png", size: 30, mtimeMs: 600 },
		] });
		expect(deriveSubjects(snapshot, [])).toEqual([expect.objectContaining({ id: "file:/tmp/work/frames.png", path: "/tmp/work/frames.png", size: 30, updatedAt: 600 })]);
	});

	it.each(["linux", "win32"])("keeps distinct watcher paths on %s", platform => {
		const snapshot = input({ stream: null, folder: "/tmp/work", platform, changes: [
			{ watchId: "w", path: "/private/tmp/work/frames.png", size: 20, mtimeMs: 500 },
			{ watchId: "w", path: "/tmp/work/frames.png", size: 30, mtimeMs: 600 },
		] });
		expect(deriveSubjects(snapshot, []).map(subject => subject.path).sort()).toEqual(["/private/tmp/work/frames.png", "/tmp/work/frames.png"]);
	});

	it("shows structured image generation arguments without inventing defaults", () => {
		const stream = assistant("image", "generate_image", { subject: "A bird", action: "perched", scene: "a tree", composition: "Close view", style: "Ink", aspect_ratio: "3:4", image_size: "1024x1536", provider: "openai" });
		const [subject] = deriveSubjects(input({ stream }), []);
		expect(subject).toMatchObject({ kind: "request", format: "generate-image", state: "writing", request: { prompt: "A bird, perched, a tree. Close view. Ink.", size: "1024x1536", aspectRatio: "3:4", model: "openai", count: null } });
		expect(deriveSubjects(input({ stream: assistant("image", "generate_image", { prompt: "A flower", model: "image-1", count: 2 }) }), [subject])[0]).toMatchObject({ revision: 2, request: { prompt: "A flower", model: "image-1", count: 2 } });
	});

	it("shows eval cell images, drops incomplete base64 and retains frames when the tool ends", () => {
		const tool = { ...running("draw", { code: "display(plot)" }, "eval"), partialResult: { content: [{ type: "image", mimeType: "image/png", data: "aGV5" }, { type: "image", mimeType: "image/png", data: "broken…[12 chars elided for collab session]" }] } };
		const stream = assistant("draw", "eval", { code: "display(plot)" });
		const first = deriveSubjects(input({ stream, activeTools: new Map([["draw", tool]]) }), []);
		expect(first[0]).toMatchObject({ id: "call:draw", kind: "images", format: "result-images", state: "running", images: [{ mimeType: "image/png", data: "aGV5" }] });
		const next = deriveSubjects(input({ stream: null, entries: [user(), entry(stream), entry(result())] }), first);
		expect(next[0]).toMatchObject({ state: "saved", images: first[0].images, revision: 1 });
	});

	it("reads eval aggregate and per-cell detail images without duplicates", () => {
		const image = { type: "image", mimeType: "image/png", data: "aGV5" };
		const stream = assistant("draw", "eval", { code: "display(plot)" });
		const tool = { ...running("draw", { code: "display(plot)" }, "eval"), partialResult: { content: [{ type: "text", text: "Figure 1" }], details: { images: [image], cells: [{ displayOutputs: [image] }] } } };
		const first = deriveSubjects(input({ stream, activeTools: new Map([["draw", tool]]) }), []);
		expect(first[0].images).toEqual([{ mimeType: "image/png", data: "aGV5" }]);
		const perCell = { ...tool, partialResult: { content: [], details: { cells: [{ displayOutputs: [image] }] } } };
		expect(deriveSubjects(input({ stream, activeTools: new Map([["draw", perCell]]) }), first)[0].revision).toBe(1);
	});

	it("resolves relative command paths using the call's cwd and keeps absolute paths intact", () => {
		const tool = running("draw", { cwd: "./build", code: 'save("plot.png")' }, "eval");
		expect(namedPaths(input({ stream: null, activeTools: new Map([["draw", tool]]) }))).toContain("/project/work/build/plot.png");
		expect(deriveSubjects(input({ stream: assistant("draw", "write", { path: "/elsewhere/poster.svg", content: "<svg/>" }) }), [])[0].path).toBe("/elsewhere/poster.svg");
		expect(deriveSubjects(input({ folder: null }), [])[0].path).toBeNull();
	});

	it("recognizes device-based generator and eval calls", () => {
		expect(isVisualCall("write", { path: "xd://generate_image", content: '{"subject":"Bird"}' })).toBe(true);
		expect(deriveSubjects(input({ stream: assistant("draw", "write", { path: "xd://generate_image", content: '{"subject":"Bird"}' }) }), [])[0]).toMatchObject({ toolName: "generate_image", request: { prompt: "Bird." } });
	});

	it("attributes a file to the named running call before the newest overlapping call", () => {
		const activeTools = new Map([["named", running("named", { command: "python build.py '/project/work/plots'" }, "bash", 250)], ["other", running("other", { command: "sleep 5" }, "bash", 450)]]);
		const [subject] = deriveSubjects(input({ stream: null, activeTools, changes: [{ watchId: "w", path: "/project/work/plots/plot.png", size: 30, mtimeMs: 500 }] }), []);
		expect(subject).toMatchObject({ kind: "file", toolCallId: "named", state: "running" });
	});

	it("falls back to the call time window and leaves unrelated discovery unattributed", () => {
		const activeTools = new Map([["draw", running("draw", { command: "python build.py" }, "bash", 400)]]);
		const next = deriveSubjects(input({ stream: null, activeTools, changes: [{ watchId: "w", path: "/project/work/report.pdf", size: 20, mtimeMs: 500 }, { watchId: "w", path: "/project/work/other.html", size: 30, mtimeMs: 200 }] }), []);
		expect(next.find(subject => subject.path?.endsWith("report.pdf"))).toMatchObject({ format: "pdf", toolCallId: "draw" });
		expect(next.find(subject => subject.path?.endsWith("other.html"))).toMatchObject({ format: "html", toolCallId: null, toolName: null });
	});

	it("revises a file only on a new stable save, even at unchanged byte length", () => {
		const change = { watchId: "w", path: "/project/work/plot.png", size: 20, mtimeMs: 500 };
		const first = deriveSubjects(input({ stream: null, changes: [change] }), []);
		expect(deriveSubjects(input({ stream: null, changes: [change], now: 1500 }), first)[0].revision).toBe(1);
		expect(deriveSubjects(input({ stream: null, changes: [change, { ...change, mtimeMs: 700 }] }), first)[0]).toMatchObject({ id: first[0].id, revision: 2, updatedAt: 700 });
	});

	it("extracts running arguments and printed paths with the Outputs parser", () => {
		const tool = { ...running("draw", { cwd: "./build", command: 'OUT="/project/work/dist"; python render.py "$OUT/poster.png"' }, "bash"), partialResult: { content: [{ type: "text", text: "Saved /project/work/final.pdf" }] } };
		const snapshot = input({ stream: null, activeTools: new Map([["draw", tool]]) });
		expect(namedPaths(snapshot)).toEqual(expect.arrayContaining(["/project/work/dist", "/project/work/dist/poster.png", "/project/work/final.pdf"]));
		expect(relatedPaths(input({ stream: assistant("draw", "write", { path: "style.css", content: "body {}" }) }))).toContain("/project/work/style.css");
		expect(namedPaths(input())).toEqual([]);
	});

	it("deduplicates command arguments, printed output and watcher scopes using macOS path identity", () => {
		const tool = { ...running("draw", { command: "python draw.py /tmp/work/frames.png" }, "bash"), partialResult: { content: [{ type: "text", text: "Saved /private/tmp/work/frames.png" }] } };
		const snapshot = input({ stream: null, folder: "/tmp/work", platform: "darwin", activeTools: new Map([["draw", tool], ["other", running("other", { path: "/private/tmp/work/frames.png" })]]) });
		expect(namedPaths(snapshot)).toEqual(["/tmp/work/frames.png"]);
		expect(relatedPaths(snapshot)).toEqual(["/tmp/work/frames.png"]);
	});

	it("keeps finished call paths in grants and background call paths in watches", () => {
		const stream = assistant("draw", "bash", { command: "python render.py /project/work/plot.png" });
		const snapshot = input({ stream: null, entries: [user(), entry(stream), entry(result())] });
		expect(relatedPaths(snapshot)).toContain("/project/work/plot.png");
		expect(namedPaths(snapshot)).toEqual([]);
		expect(namedPaths({ ...snapshot, backgroundTools: new Map([["draw", running("draw", { command: "python render.py /project/work/plot.png" }, "bash")]]) })).toContain("/project/work/plot.png");
	});

	it.each(["script.ts", "movie.mp4", "deck.pptx"])("does not offer out-of-phase source %s", path => {
		expect(isVisualCall("write", { path })).toBe(false);
		expect(deriveSubjects(input({ stream: assistant("draw", "write", { path, content: "data" }) }), [])).toEqual([]);
	});
});

describe("recognized render subjects", () => {
	it("keeps an existing input sequence frame inside its encoding movie subject", () => {
		const command = "ffmpeg -framerate 30 -i frames/frame%04d.png out.mp4";
		const pattern = { folder: "/project/work/frames", prefix: "frame", digits: 4, suffix: ".png" };
		const snapshot = input({ stream: null, activeTools: new Map([["draw", running("draw", { command }, "bash")]]), changes: [
			{ watchId: "w", path: "/project/work/frames/frame0002.png", size: 100, mtimeMs: 50, sequence: { pattern, count: 2 } },
		] });
		expect(sequencePatterns(snapshot)).toEqual([pattern]);
		expect(namedPaths(snapshot)).toContain(pattern.folder);
		const first = deriveSubjects(snapshot, []);
		expect(first).toHaveLength(1);
		expect(first[0]).toMatchObject({ kind: "render", format: "video", path: "/project/work/out.mp4", videoFrame: { path: "/project/work/frames/frame0002.png", mtimeMs: 50 } });
		const second = deriveSubjects({ ...snapshot, changes: [{ ...snapshot.changes[0]!, path: "/project/work/frames/frame0003.png", mtimeMs: 60 }] }, first);
		expect(second[0].revision).toBe(first[0].revision + 1);
		expect(second[0].videoFrame?.path).toContain("frame0003.png");
	});
	it("uses the newest completed Manim animation clip and then the final movie under one identity", () => {
		const command = "manim -ql scene.py Sample";
		const clip1 = "/project/work/media/partial_movie_files/Sample/one.mp4";
		const clip2 = "/project/work/media/partial_movie_files/Sample/two.mp4";
		const snapshot = (path: string, final = false) => input({ stream: null, activeTools: new Map([["draw", {
			...running("draw", { command }, "bash"), partialResult: { content: [{ type: "text", text: `${final ? "File ready at" : "Partial movie file written in"} '${path}'` }] },
		}]]), changes: [clip1, clip2, "/project/work/final.mp4"].map((path, index) => ({ watchId: "w", path, size: 100, mtimeMs: 500 + index })) });
		const first = deriveSubjects(snapshot(clip1), []);
		const second = deriveSubjects(snapshot(clip2), first);
		expect(second.find(subject => subject.id === "call:draw")).toMatchObject({ path: clip2, kind: "file" });
		expect(second.filter(subject => subject.path === clip1)).toHaveLength(0);
		const final = deriveSubjects(snapshot("/project/work/final.mp4", true), second);
		expect(final.find(subject => subject.id === "call:draw")).toMatchObject({ path: "/project/work/final.mp4", format: "video" });
		expect(namedPaths(snapshot(clip2))).toContain(clip2);
	});
	it("shows advancing ffmpeg progress before a stable save, then keeps the same selected identity", () => {
		const command = "ffmpeg -f lavfi -i testsrc=duration=6:size=320x240:rate=30 -frames:v 180 -progress pipe:1 out.mp4";
		let previous = deriveSubjects(input({ stream: null, activeTools: new Map([["draw", running("draw", { command }, "bash")]]) }), []);
		expect(previous[0]).toMatchObject({ id: "call:draw", kind: "render", format: "video", path: "/project/work/out.mp4", progress: null });
		for (const done of [30, 60, 120]) {
			const tool = { ...running("draw", { command }, "bash"), partialResult: { content: [{ type: "text", text: `frame=${done}\nout_time=00:00:02.000000\nprogress=continue` }] } };
			previous = deriveSubjects(input({ stream: null, activeTools: new Map([["draw", tool]]) }), previous);
			expect(previous[0]).toMatchObject({ id: "call:draw", kind: "render", progress: { tool: "ffmpeg", done, total: 180, unit: "frame" } });
		}
		const snapshot = input({ stream: null, activeTools: new Map([["draw", running("draw", { command }, "bash")]]), changes: [{ watchId: "w", path: "/project/work/out.mp4", size: 5000, mtimeMs: 900 }] });
		const saved = deriveSubjects(snapshot, previous);
		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatchObject({ id: "call:draw", kind: "file", format: "video", path: "/project/work/out.mp4", size: 5000 });
		expect(deriveSubjects({ ...snapshot, now: 2000 }, saved)[0].revision).toBe(saved[0].revision);
	});

	it("recognizes bash and eval render calls while leaving unknown commands alone", () => {
		expect(isVisualCall("bash", { command: "ffmpeg -i input.mov out.mp4" })).toBe(true);
		expect(isVisualCall("bash", { command: "echo hello" })).toBe(false);
		const snapshot = input({ stream: null, activeTools: new Map([["draw", running("draw", { code: 'subprocess.run(["ffmpeg", "-i", "input.mov", "out.mp4"])' }, "eval")]]) });
		expect(deriveSubjects(snapshot, [])[0]).toMatchObject({ kind: "render", format: "video" });
	});

	it("resolves render output and sequence folders from the call's cwd", () => {
		const snapshot = input({ stream: null, activeTools: new Map([["draw", running("draw", { command: 'ffmpeg -i input.mp4 frames/frame%04d.png', cwd: "build" }, "bash")]]) });
		expect(sequencePatterns(snapshot)).toEqual([{ folder: "/project/work/build/frames", prefix: "frame", digits: 4, suffix: ".png" }]);
		expect(namedPaths(snapshot)).toContain("/project/work/build/frames");
	});

	it("keeps one sequence subject with the newest frame and keeps unrelated numbered images separate", () => {
		const pattern = { folder: "/project/work/frames", prefix: "frame", digits: 4, suffix: ".png" };
		const snapshot = input({ stream: null, activeTools: new Map([["draw", running("draw", { command: "ffmpeg -i source.mp4 frames/frame%04d.png" }, "bash")]]), changes: [
			{ watchId: "w", path: "/project/work/frames/frame0001.png", size: 200, mtimeMs: 500, sequence: { pattern, count: 1 } },
			{ watchId: "w", path: "/project/work/frames/frame0006.png", size: 250, mtimeMs: 900, sequence: { pattern, count: 6 } },
			...[1, 2, 3].map(index => ({ watchId: "w", path: `/project/work/frames/photo${index}.png`, size: 30, mtimeMs: 800 })),
		] });
		const subjects = deriveSubjects(snapshot, []);
		expect(subjects).toHaveLength(4);
		expect(subjects.find(subject => subject.sequence)).toMatchObject({ id: "call:draw", kind: "file", format: "sequence", path: "/project/work/frames/frame0006.png", sequence: { pattern, count: 6 } });
		expect(subjects.filter(subject => !subject.sequence).map(subject => subject.path).sort()).toEqual([1, 2, 3].map(index => `/project/work/frames/photo${index}.png`));
	});

	it("does not reload a stable video just because its render progress advanced", () => {
		const command = "ffmpeg -i input.mov -frames:v 180 out.mp4";
		const snapshot = input({ stream: null, activeTools: new Map([["draw", running("draw", { command }, "bash")]]), changes: [{ watchId: "w", path: "/project/work/out.mp4", size: 300, mtimeMs: 500 }] });
		const first = deriveSubjects(snapshot, []);
		const tool = { ...running("draw", { command }, "bash"), partialResult: { content: [{ type: "text", text: "frame=120" }] } };
		const next = deriveSubjects({ ...snapshot, activeTools: new Map([["draw", tool]]) }, first);
		expect(next[0].progress?.done).toBe(120);
		expect(next[0].revision).toBe(first[0].revision);
	});
});

it("updates a declared sequence's count and remaining frame after its newest image is deleted", () => {
	const pattern = { folder: "/project/work/frames", prefix: "frame", digits: 4, suffix: ".png" };
	const snapshot = input({ stream: null, activeTools: new Map([["draw", running("draw", { command: "ffmpeg -i source.mp4 frames/frame%04d.png" }, "bash")]]), changes: [
		{ watchId: "w", path: "/project/work/frames/frame0006.png", size: 250, mtimeMs: 900, sequence: { pattern, count: 6 } },
	] });
	const first = deriveSubjects(snapshot, []);
	const next = deriveSubjects({ ...snapshot, changes: [
		{ watchId: "w", path: "/project/work/frames/frame0005.png", size: 240, mtimeMs: 800, sequence: { pattern, count: 5 } },
	] }, first);
	expect(next).toHaveLength(1);
	expect(next[0]).toMatchObject({ id: "call:draw", path: "/project/work/frames/frame0005.png", sequence: { pattern, count: 5 }, revision: first[0].revision + 1 });
});

describe("Office preview file discovery", () => {
	it.each(["docx", "xlsx", "pptx"])("discovers %s saves with stable revision identity", format => {
		const change = { watchId: "office", path: `/project/work/office.${format}`, size: 100, mtimeMs: 500 };
		const first = deriveSubjects(input({ stream: null, changes: [change] }), []);
		expect(first).toEqual([expect.objectContaining({ kind: "file", format, path: change.path })]);
		const next = deriveSubjects(input({ stream: null, changes: [{ ...change, size: 200, mtimeMs: 600 }] }), first);
		expect(next[0]?.id).toBe(first[0]?.id);
		expect(next[0]?.revision).toBe(first[0]!.revision + 1);
	});
	it("never discovers a macro-enabled Office extension", () => {
		expect(deriveSubjects(input({ stream: null, changes: [{ watchId: "office", path: "/project/work/macro.pptm", size: 100, mtimeMs: 500 }] }), [])).toEqual([]);
	});
});
