import { describe, expect, it } from "vitest";
import { type LiveProgress, parseProgress } from "./progress";

const recordings = Object.entries(import.meta.glob<{ command: string; output: string; version: string; expectedProgress: LiveProgress }>(
	"../../../../../scripts/live-preview-fixture/samples/*.json", { eager: true, import: "default" },
)).map(([path, sample]) => ({ name: path.split("/").at(-1)!, ...sample }));

describe("recorded renderer progress", () => {
	it.each(recordings)("parses authentic $name with its captured version line", sample => {
		expect(sample.output).toContain(sample.version);
		expect(parseProgress(sample.command, sample.output)).toEqual(sample.expectedProgress);
	});

	it("reads each captured Remotion render and encode update", () => {
		const sample = recordings.find(item => item.name === "remotion-4.0.391-video.json");
		if (!sample) throw new Error("The versioned Remotion recording is missing");
		const lines = sample.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split(/[\r\n]/).filter(line => /^(?:Rendered|Encoded) \d+\/\d+/.test(line));
		expect(lines.length).toBeGreaterThan(3);
		for (const line of lines) {
			const match = /^(?:Rendered|Encoded) (\d+)\/(\d+)/.exec(line);
			if (!match) throw new Error("A captured progress line could not be read");
			expect(parseProgress(sample.command, line)).toEqual({ tool: "remotion", done: Number(match[1]), total: Number(match[2]), unit: "frame", percent: Math.min(100, Number(match[1]) / Number(match[2]) * 100) });
		}
	});

	it("reads each captured Manim tqdm update without inventing a scene total", () => {
		const sample = recordings.find(item => item.name === "manim-0.19.0-video.json");
		if (!sample) throw new Error("The versioned Manim recording is missing");
		const lines = sample.output.split(/[\r\n]/).filter(line => /^Animation \d+:/.test(line));
		expect(lines.length).toBeGreaterThan(3);
		for (const line of lines) {
			const match = /^Animation (\d+):.*?\b(\d+)%\|/.exec(line);
			if (!match) throw new Error("A captured animation progress line could not be read");
			expect(parseProgress(sample.command, line)).toEqual({ tool: "manim", done: Number(match[1]) + Number(match[2]) / 100, total: null, unit: "animation", percent: Number(match[2]) });
		}
	});
});

describe("FFmpeg progress", () => {
	it("uses the last frame count with an explicit frame total", () => {
		expect(parseProgress("ffmpeg -i source.mov -frames:v 180 out.mp4", "frame=    1 fps=0\rframe=   90 fps=30 time=00:00:03.00")).toEqual({ tool: "ffmpeg", done: 90, total: 180, unit: "frame", percent: 50 });
	});

	it("supports legacy frame limits and literal eval argv", () => {
		expect(parseProgress("subprocess.run(['ffmpeg', '-i', 'in.mov', '-vframes', '20', 'out.mp4'])", "frame=10\nprogress=continue")).toEqual({ tool: "ffmpeg", done: 10, total: 20, unit: "frame", percent: 50 });
	});

	it.each([
		"echo '-frames:v 10'; ffmpeg -i in.mov -frames:v 180 out.mp4",
		"echo '-t 1 -to 2 -ss 99'; ffmpeg -i in.mov -frames:v 180 out.mp4",
		"const unrelated = '-frames:v 10 -t 1 -to 2 -ss 99';\nsubprocess.run(['ffmpeg', '-i', 'in.mov', '-frames:v', '180', 'out.mp4'])",
		'const unrelated = "-frames:v 10 -t 1 -to 2 -ss 99"; await exec("ffmpeg -i in.mov -frames:v 180 out.mp4")',
		'await tool.bash({command: "echo \'-frames:v 10\'; ffmpeg -i in.mov -frames:v 180 out.mp4"})',
		"ffmpeg -i in.mov -frames:v=180 out.mp4",
	])("uses frame limits only from the actual invocation in %s", command => {
		expect(parseProgress(command, "frame=90 time=00:00:03.00")).toEqual({ tool: "ffmpeg", done: 90, total: 180, unit: "frame", percent: 50 });
	});

	it.each([
		"echo '-t 1 -to 2 -ss 99'; ffmpeg -i in.mov -t 10 out.mp4",
		'const unrelated = "-t 1 -to 2 -ss 99"; await exec("ffmpeg -i in.mov -t 10 out.mp4")',
		"subprocess.run(['ffmpeg', '-i', 'in.mov', '-t', '10', 'out.mp4'])",
	])("uses duration limits only from the actual invocation in %s", command => {
		expect(parseProgress(command, "time=00:00:05.00")).toEqual({ tool: "ffmpeg", done: 5, total: 10, unit: "second", percent: 50 });
	});

	it.each([
		"ffmpeg -frames:v 180 -i in.mov out.mp4",
		"ffmpeg -t 10 -i in.mov out.mp4",
		"ffmpeg -to 10 -i in.mov out.mp4",
		"ffmpeg -t 10 -i in.mov -t 20 out.mp4",
		"ffmpeg -i first.mov -i second.mov -frames:v 180 out.mp4",
		"ffmpeg -i in.mov -frames:v 180 out.mp4 -frames:v 10 other.mp4",
		"ffmpeg -i in.mov -frames:v 10 out.mp4; ffmpeg -i in.mov -frames:v 180 out.mp4",
		"ffmpeg -i in.mov -frames:v 180 out.mp4; ffmpeg -i in.mov -frames:v 180 out.mp4",
		"ffmpeg -i in.mov -frames:v 180 -vframes 10 out.mp4",
		"ffmpeg -i in.mov -t 10 -to 20 out.mp4",
		"ffmpeg -i in.mov -ss 1 -ss 2 -t 10 out.mp4",
		"ffmpeg -i in.mov -frames:v 180 -t 10 out.mp4",
		"ffmpeg -i in.mov out.mp4 -t 10",
		"ffmpeg -i in.mov -frames:v $COUNT out.mp4",
		"ffmpeg -i in.mov -t 0 out.mp4",
		"ffmpeg -i in.mov -frames:v 00:03:00 out.mp4",
	])("preserves measured counts without guessing an ambiguous total in %s", command => {
		expect(parseProgress(command, "Duration: 00:01:00.00\nframe=90 time=00:00:03.00")).toEqual({ tool: "ffmpeg", done: 90, total: null, unit: "frame", percent: null });
		expect(parseProgress(command, "out_time_us=3000000\n")).toEqual({ tool: "ffmpeg", done: 3, total: null, unit: "second", percent: null });
	});

	it("keeps unrelated flags from supplying a missing total", () => {
		expect(parseProgress("echo '-frames:v 180 -t 10'; ffmpeg -i in.mov out.mp4", "frame=90 time=00:00:03.00")).toEqual({ tool: "ffmpeg", done: 90, total: null, unit: "frame", percent: null });
	});

	it.each([
		["ffmpeg -ss 5 -i in.mov -to 15 out.mp4", "", 15],
		["ffmpeg -ss 5 -i in.mov -ss 2 -to 12 out.mp4", "", 10],
		["ffmpeg -ss 5 -i in.mov out.mp4", "Duration: 00:00:15.00\n", 10],
		["ffmpeg -ss 5 -i in.mov -ss 2 out.mp4", "Duration: 00:00:17.00\n", 10],
	] as const)("keeps seek origins scoped in %s", (command, header, total) => {
		expect(parseProgress(command, `${header}time=00:00:05.00`)).toEqual({ tool: "ffmpeg", done: 5, total, unit: "second", percent: 5 / total * 100 });
	});

	it("does not choose between multiple reported source durations", () => {
		expect(parseProgress("ffmpeg -i in.mov out.mp4", "Duration: 00:00:10.00\nDuration: 00:00:20.00\ntime=00:00:05.00")).toEqual({ tool: "ffmpeg", done: 5, total: null, unit: "second", percent: null });
	});

	it.each([
		["-t 10", "frame=30 time=00:00:05.00", 5, 10],
		["-t 00:01:00", "time=00:00:15.00", 15, 60],
		["-ss 5 -to 15", "time=00:00:05.00", 5, 10],
		["-to 10", "time=00:00:05.00", 5, 10],
		["", "Duration: 00:00:10.00, start: 0\nframe=30 time=00:00:05.00", 5, 10],
		["-ss 5", "Duration: 00:00:15.00, start: 0\ntime=00:00:05.00", 5, 10],
	] as const)("reads duration from %s", (flags, output, done, total) => {
		expect(parseProgress(`ffmpeg -i in.mov ${flags} out.mp4`, output)).toEqual({ tool: "ffmpeg", done, total, unit: "second", percent: done / total * 100 });
	});

	it.each(["out_time_us=5000000", "out_time_ms=5000000", "out_time=00:00:05.000000"])("reads -progress pipe:1 %s", line => {
		expect(parseProgress("ffmpeg -i in.mov -t 10 -progress pipe:1 out.mp4", `frame=12\n${line}\nprogress=continue\n`)).toEqual({ tool: "ffmpeg", done: 5, total: 10, unit: "second", percent: 50 });
	});

	it("uses the latest timestamp across ordinary and machine output", () => {
		expect(parseProgress("ffmpeg -i in.mov -t 10 out.mp4", "out_time_us=1000000\nout_time=00:00:01.00\nframe=30 time=00:00:05.00")).toMatchObject({ done: 5, total: 10, percent: 50 });
		expect(parseProgress("ffmpeg -i in.mov -t 10 out.mp4", "time=00:00:01.00\nout_time_us=5000000\n")).toMatchObject({ done: 5, total: 10, percent: 50 });
	});

	it("preserves unknown totals after Duration has left the output tail", () => {
		expect(parseProgress("ffmpeg -i in.mov out.mp4", "frame=90 time=00:00:03.00")).toEqual({ tool: "ffmpeg", done: 90, total: null, unit: "frame", percent: null });
		expect(parseProgress("ffmpeg -i in.mov out.mp4", "out_time_us=2500000\n")).toEqual({ tool: "ffmpeg", done: 2.5, total: null, unit: "second", percent: null });
	});

	it("clamps percentages without rewriting measured counts", () => {
		expect(parseProgress("ffmpeg -i in.mov -frames:v 10 out.mp4", "frame=11")).toEqual({ tool: "ffmpeg", done: 11, total: 10, unit: "frame", percent: 100 });
	});

	it.each(["frame=N/A time=N/A", "Duration: N/A", "progress=end", "", "frame=-4", "out_time_us=-3"])("rejects unmeasured output %s", output => {
		expect(parseProgress("ffmpeg -i in.mov out.mp4", output)).toBeNull();
	});
});

describe("other renderer progress", () => {
	it("handles ANSI output and carriage-return Remotion updates", () => {
		expect(parseProgress("npx remotion render index.ts Sample out.mp4", "\x1b[32mRendered 30/60\x1b[0m\rEncoded 10/60")).toEqual({ tool: "remotion", done: 10, total: 60, unit: "frame", percent: 10 / 60 * 100 });
	});

	it("does not turn bundling or arbitrary fractions into render progress", () => {
		expect(parseProgress("npx remotion render index.ts Sample out.mp4", "Bundling 80%\nDownloaded 2/3\n")).toBeNull();
		expect(parseProgress("npx remotion render index.ts Sample out.mp4", "Rendered 0/0")).toBeNull();
	});

	it("does not call an animation percentage an overall scene percentage", () => {
		expect(parseProgress("manim -ql scene.py Sample", "Animation 3: Create(Circle): 25%|██▌ | 5/20")).toEqual({ tool: "manim", done: 3.25, total: null, unit: "animation", percent: 25 });
		expect(parseProgress("manim scene.py Sample", "Animation 0: Create(Circle): 101%|x|")).toBeNull();
	});

	it.each(["pdflatex", "lualatex", "xelatex", "latexmk -pdf", "tectonic"])("reads the reported LaTeX page count from %s", tool => {
		expect(parseProgress(`${tool} report.tex`, "Output written on report.pdf (3 pages, 12345 bytes).\n")).toEqual({ tool: "latex", done: 3, total: 3, unit: "page", percent: 100 });
		expect(parseProgress(`${tool} report.tex`, "Output written on report.pdf (1 page, 234 bytes).\n")).toMatchObject({ done: 1, total: 1, unit: "page", percent: 100 });
	});

	it.each(["echo ffmpeg", "cat output.log", "python build.py", "unknown", "blender -b scene.blend -a"])("rejects progress from an unknown or unsupported command %s", command => {
		expect(parseProgress(command, "frame=90 time=00:00:03.00\nRendered 30/60\nOutput written on report.pdf (3 pages, 12345 bytes).\n")).toBeNull();
	});
});
