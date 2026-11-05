import { describe, expect, it } from "vitest";
import { parseRenderCommand, parseRenderInvocation, type RenderCommand } from "./render-command";

const recordings = Object.entries(import.meta.glob<{ command: string; output: string; version: string; expectedRender: RenderCommand }>(
	"../../../../../scripts/live-preview-fixture/samples/*.json", { eager: true, import: "default" },
)).map(([path, sample]) => ({ name: path.split("/").at(-1)!, ...sample }));

describe("recorded render commands", () => {
	it.each(recordings)("reads outputs from authentic $name", sample => {
		expect(sample.output).toContain(sample.version);
		expect(parseRenderCommand(sample.command, sample.output)).toEqual(sample.expectedRender);
	});
});

describe("literal render commands", () => {
	it.each([
		["ffmpeg -i input.mov -c:v libx264 output.mp4", "output.mp4"],
		['ffmpeg -i "input file.mov" -c:v libx264 "output file.mp4"', "output file.mp4"],
		["mkdir -p renders && ffmpeg -i input.mov -an renders/out.webm", "renders/out.webm"],
		["env FFMPEG_LOG=1 /usr/bin/ffmpeg -y -i input.mov /tmp/out.m4v", "/tmp/out.m4v"],
		['"C:\\tools\\ffmpeg.exe" -i "C:\\in.mov" "C:\\render\\out.mp4"', "C:\\render\\out.mp4"],
		["ffmpeg -i in.mov output\\ file.mp4 > log.txt 2>&1", "output file.mp4"],
	] as const)("retains the raw output in %s", (command, path) => {
		expect(parseRenderCommand(command, "")).toEqual({ tool: "ffmpeg", path, sequences: [] });
	});

	it("uses a confirmed FFmpeg output over an ambiguous command", () => {
		expect(parseRenderCommand("ffmpeg -i input.mov $OUTPUT", "Output #0, mp4, to '/tmp/finished.mp4':\n")).toEqual({ tool: "ffmpeg", path: "/tmp/finished.mp4", sequences: [] });
	});

	it.each(["ffmpeg -i input.mp4", "ffmpeg -i input.mp4 -an", "ffmpeg -i in.mov $OUTPUT", "ffmpeg -i in.mov pipe:1", "ffmpeg -i in.mov https://example.com/out.mp4", "ffmpeg -i in.mov a.mp4 b.mp4"])("recognizes the tool without guessing a file in %s", command => {
		expect(parseRenderCommand(command, "")).toEqual({ tool: "ffmpeg", path: null, sequences: [] });
	});

	it("ignores input filename numbering", () => {
		expect(parseRenderCommand("ffmpeg -i frames/%04d.png movie.mp4", "")).toEqual({ tool: "ffmpeg", path: "movie.mp4", sequences: [] });
	});

	it.each([
		["frames/frame-%04d.png", { folder: "frames", prefix: "frame-", digits: 4, suffix: ".png" }],
		["frames/%d.jpg", { folder: "frames", prefix: "", digits: null, suffix: ".jpg" }],
		["%06d.png", { folder: ".", prefix: "", digits: 6, suffix: ".png" }],
		["/frames/render-%03d-final.webp", { folder: "/frames", prefix: "render-", digits: 3, suffix: "-final.webp" }],
		["C:\\frames\\render-%04d.png", { folder: "C:\\frames", prefix: "render-", digits: 4, suffix: ".png" }],
		["C:\\%04d.png", { folder: "C:\\", prefix: "", digits: 4, suffix: ".png" }],
	] as const)("identifies only the declared FFmpeg pattern %s", (path, pattern) => {
		expect(parseRenderCommand(`ffmpeg -i input.mov '${path}'`, "")).toEqual({ tool: "ffmpeg", path: null, sequences: [pattern] });
	});

	it.each(["frames/%04d-%04d.png", "frames/%00d.png", "frames/%04d/nested-%04d.png"])("does not invent a concrete file for an unsupported template %s", path => {
		expect(parseRenderCommand(`ffmpeg -i in.mov '${path}'`, "")).toEqual({ tool: "ffmpeg", path: null, sequences: [] });
	});

	it.each(["ffmpeg -i in.mov out.png", "ffmpeg -i in.mov frame-0001.png"])("leaves ordinary numbered images as individual outputs in %s", command => {
		expect(parseRenderCommand(command, "")?.sequences).toEqual([]);
	});

	it.each(["npx remotion", "npx --yes remotion@4.0.391", "bunx remotion", "npm exec -- remotion"])("recognizes %s render", prefix => {
		expect(parseRenderCommand(`${prefix} render src/index.ts Scene renders/movie.mp4 --concurrency=1`, "")).toEqual({ tool: "remotion", path: "renders/movie.mp4", sequences: [] });
	});

	it("recognizes a Remotion output option and keeps the default output unknown", () => {
		expect(parseRenderCommand("npx remotion render src/index.ts Scene --output=custom.mp4", "")).toMatchObject({ path: "custom.mp4" });
		expect(parseRenderCommand("npx remotion render src/index.ts Scene", "")).toEqual({ tool: "remotion", path: null, sequences: [] });
	});

	it("uses Remotion's reported output when the command omits it", () => {
		expect(parseRenderCommand("npx remotion render src/index.ts Scene", "Output               out/Scene.mp4\n")).toMatchObject({ path: "out/Scene.mp4" });
	});

	it("coalesces Remotion sequences only with an identified output folder", () => {
		expect(parseRenderCommand("npx remotion render src/index.ts Scene frames --sequence --image-format=png", "")).toEqual({ tool: "remotion", path: null, sequences: [{ folder: "frames", prefix: "element-", digits: null, suffix: ".png" }] });
		expect(parseRenderCommand("npx remotion render src/index.ts Scene frames --sequence", "")).toEqual({ tool: "remotion", path: null, sequences: [{ folder: "frames", prefix: "element-", digits: null, suffix: ".jpeg" }] });
		expect(parseRenderCommand("npx remotion render src/index.ts Scene --sequence", "")?.sequences).toEqual([]);
		expect(parseRenderCommand("npx remotion render src/index.ts Scene frames --sequence=false", "")?.sequences).toEqual([]);
	});

	it.each(["manim -ql scene.py Sample", "python3 -m manim -ql scene.py Sample", "uv run manim -ql scene.py Sample"])("recognizes %s without inventing its video path", command => {
		expect(parseRenderCommand(command, "")).toEqual({ tool: "manim", path: null, sequences: [] });
		expect(parseRenderCommand(command, "File ready at '/tmp/media/Sample.mp4'\n")).toEqual({ tool: "manim", path: "/tmp/media/Sample.mp4", sequences: [] });
	});

	it("never takes Manim's per-animation temporary movie as its output", () => {
		expect(parseRenderCommand("manim -ql scene.py Sample", "Animation 0 : Partial movie file written in '/tmp/partial_movie_files/Sample/0.mp4'\n")?.path).toBeNull();
	});

	it("declares Manim PNG output with the captured naming convention", () => {
		expect(parseRenderCommand("manim -ql --save_pngs scene.py Sample", "")).toEqual({ tool: "manim", path: null, sequences: [{ folder: "media/images/scene", prefix: "Sample", digits: 4, suffix: ".png" }] });
		expect(parseRenderCommand("manim --format=png --media_dir frames -o Custom scene.py Sample", "")).toEqual({ tool: "manim", path: null, sequences: [{ folder: "frames/images/scene", prefix: "Custom", digits: 4, suffix: ".png" }] });
	});

	it("does not coalesce ambiguous multi-scene Manim renders", () => {
		expect(parseRenderCommand("manim --save_pngs scene.py First Second", "")?.sequences).toEqual([]);
	});

	it("uses the confirmed LaTeX path without guessing from the input filename", () => {
		expect(parseRenderCommand("pdflatex report.tex", "")).toEqual({ tool: "latex", path: null, sequences: [] });
		expect(parseRenderCommand("latexmk -pdf report.tex", "Output written on build/report.pdf (2 pages, 3423 bytes).\n")).toEqual({ tool: "latex", path: "build/report.pdf", sequences: [] });
	});

	it("identifies Blender hash patterns only with a known file extension", () => {
		expect(parseRenderCommand("blender -b scene.blend -o frames/frame_####.png -a", "")).toEqual({ tool: "blender", path: null, sequences: [{ folder: "frames", prefix: "frame_", digits: 4, suffix: ".png" }] });
		expect(parseRenderCommand("blender -b scene.blend -o frames/frame_###### -F OPEN_EXR -a", "")).toEqual({ tool: "blender", path: null, sequences: [{ folder: "frames", prefix: "frame_", digits: 6, suffix: ".exr" }] });
		expect(parseRenderCommand("blender -b scene.blend -o frames/frame_#### -a", "")).toEqual({ tool: "blender", path: null, sequences: [] });
	});

	it("keeps Blender project-relative paths unknown until a saved path is reported", () => {
		expect(parseRenderCommand("blender -b scene.blend -o //frames/frame_####.png -a", "")).toEqual({ tool: "blender", path: null, sequences: [] });
	});

	it("respects explicit Manim padding and refuses dynamic configuration paths", () => {
		expect(parseRenderCommand("manim --save_pngs --zero_pad 6 scene.py Sample", "")?.sequences).toEqual([{ folder: "media/images/scene", prefix: "Sample", digits: 6, suffix: ".png" }]);
		expect(parseRenderCommand("manim --save_pngs --zero_pad 0 scene.py Sample", "")?.sequences).toEqual([{ folder: "media/images/scene", prefix: "Sample", digits: null, suffix: ".png" }]);
		expect(parseRenderCommand("manim --save_pngs --media_dir $MEDIA scene.py Sample", "")?.sequences).toEqual([]);
		expect(parseRenderCommand("manim --save_pngs -o $OUTPUT scene.py Sample", "")?.sequences).toEqual([]);
		expect(parseRenderCommand("manim --save_pngs --zero_pad $PADDING scene.py Sample", "")?.sequences).toEqual([]);
		expect(parseRenderCommand("manim --save_pngs --config_file custom.cfg scene.py Sample", "")?.sequences).toEqual([]);
	});

	it.each(["ffmpeg -version", "manim --version", "pdflatex --help", "blender --version"])("does not create a render for information command %s", command => {
		expect(parseRenderCommand(command, "")).toBeNull();
	});
});

describe("embedded eval commands", () => {
	it.each([
		"import subprocess\nsubprocess.run(['ffmpeg', '-i', 'input.mov', '-frames:v', '180', 'out.mp4'], check=True)",
		'await tool.bash({i: "Rendering video", command: "mkdir -p frames && ffmpeg -i input.mov out.mp4"})',
		'const proc = Bun.spawn(["ffmpeg", "-i", "input.mov", "out.mp4"]);',
		'await Bun.$`ffmpeg -i input.mov out.mp4`;',
		'await exec("ffmpeg -i input.mov out.mp4");',
	] as const)("reads a literal subprocess in %s", command => {
		expect(parseRenderCommand(command, "")).toEqual({ tool: "ffmpeg", path: "out.mp4", sequences: [] });
	});

	it("recognizes a replay function's invocation as a shell command", () => {
		const command = "remotion() {\n python3 replay.py\n}\nremotion render Scene progress.mp4";
		expect(parseRenderCommand(command, "")).toEqual({ tool: "remotion", path: "progress.mp4", sequences: [] });
	});

	it.each([
		'print("ffmpeg -i input.mov fake.mp4")',
		'const example = "remotion render Scene fake.mp4";',
		'echo "ffmpeg -i input.mov fake.mp4"',
		"# ffmpeg -i input.mov fake.mp4\nprintf done",
		"cat README.md",
		"subprocess.run(['ffmpeg', '-i', source, target])",
		'await Bun.$`ffmpeg -i ${source} ${target}`',
		"npx remotion studio src/index.ts",
	] as const)("leaves unsupported or nonexecuted text unknown in %s", command => {
		expect(parseRenderCommand(command, "File ready at '/tmp/fake.mp4'\nOutput written on fake.pdf (3 pages, 100 bytes).")).toBeNull();
	});

	it("does not choose between different renderer invocations", () => {
		expect(parseRenderCommand("ffmpeg -i in.mov first.mp4 && ffmpeg -i in.mov second.mp4", "")).toBeNull();
	});
});

describe("recognized FFmpeg invocation options", () => {
	it.each([
		"echo '-frames:v 10'; ffmpeg -i in.mov -frames:v 180 out.mp4",
		"subprocess.run(['ffmpeg', '-i', 'in.mov', '-frames:v', '180', 'out.mp4'])",
		'const unrelated = "-frames:v 10"; await exec("ffmpeg -i in.mov -frames:v 180 out.mp4")',
		'await tool.bash({command: "echo \'-frames:v 10\'; ffmpeg -i in.mov -frames:v 180 out.mp4"})',
	])("retains only the recognized invocation's literal options in %s", command => {
		expect(parseRenderInvocation(command, "")).toEqual({
			render: { tool: "ffmpeg", path: "out.mp4", sequences: [] },
			ffmpegOptions: { input: [], output: ["-frames:v", "180"] },
		});
	});

	it("keeps input and output option scopes separate", () => {
		expect(parseRenderInvocation("ffmpeg -ss 5 -i in.mov -ss 2 -to 12 out.mp4", "")?.ffmpegOptions).toEqual({ input: ["-ss", "5"], output: ["-ss", "2", "-to", "12"] });
	});

	it.each([
		"ffmpeg -i in.mov -frames:v 10 out.mp4; ffmpeg -i in.mov -frames:v 180 out.mp4",
		"ffmpeg -i in.mov -frames:v 180 out.mp4; ffmpeg -i in.mov -frames:v 180 out.mp4",
		"ffmpeg -i first.mov -i second.mov -frames:v 180 out.mp4",
		"ffmpeg -i in.mov -frames:v 180 out.mp4 -frames:v 10 other.mp4",
		"ffmpeg -i in.mov out.mp4 -t 10",
	])("retains the renderer but not ambiguous invocation options in %s", command => {
		expect(parseRenderInvocation(command, "")).toMatchObject({ render: { tool: "ffmpeg" }, ffmpegOptions: null });
	});

	it("preserves the existing refusal to choose between distinct render results", () => {
		expect(parseRenderInvocation("ffmpeg -i in.mov first.mp4; ffmpeg -i in.mov second.mp4", "")).toBeNull();
	});
});
