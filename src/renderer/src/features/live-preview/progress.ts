import { parseRenderInvocation, type RenderInvocation } from "./render-command";

export interface LiveProgress {
	tool: "ffmpeg" | "remotion" | "manim" | "latex";
	done: number;
	total: number | null;
	unit: "frame" | "second" | "animation" | "page";
	percent: number | null;
}

function seconds(value: string | undefined): number | null {
	if (!value || !/^\d+(?::\d+){0,2}(?:\.\d+)?$/.test(value)) return null;
	const parts = value.split(":").map(Number);
	let total = 0;
	for (const part of parts) total = total * 60 + part;
	return Number.isFinite(total) ? total : null;
}

function progress(tool: LiveProgress["tool"], done: number, total: number | null, unit: LiveProgress["unit"]): LiveProgress | null {
	if (!Number.isFinite(done) || done < 0 || (total !== null && (!Number.isFinite(total) || total <= 0))) return null;
	return { tool, done, total, unit, percent: total === null ? null : Math.min(100, done / total * 100) };
}

function ffmpegTotals(options: RenderInvocation["ffmpegOptions"], text: string): { frames: number | null; duration: number | null } {
	const unknown = { frames: null, duration: null };
	if (!options) return unknown;
	const read = (args: readonly string[]) => {
		const values = new Map<string, string[]>();
		for (let index = 0; index < args.length; index++) {
			const [name, ...inline] = args[index].split("=");
			if (!["-frames:v", "-vframes", "-t", "-to", "-ss"].includes(name)) continue;
			const key = name === "-vframes" ? "-frames:v" : name;
			const value = inline.length ? inline.join("=") : args[++index];
			values.set(key, [...(values.get(key) ?? []), value ?? ""]);
		}
		return values;
	};
	const input = read(options.input);
	const output = read(options.output);
	// Input limits, repeated limits and competing limit types do not identify one output total.
	if ([...input].some(([name, values]) => name !== "-ss" || values.length !== 1) || [...output.values()].some(values => values.length !== 1)) return unknown;
	const inputStart = seconds(input.get("-ss")?.[0]) ?? (input.has("-ss") ? null : 0);
	const outputStart = seconds(output.get("-ss")?.[0]) ?? (output.has("-ss") ? null : 0);
	if (inputStart === null || outputStart === null) return unknown;
	const frame = output.get("-frames:v")?.[0];
	const duration = output.get("-t")?.[0];
	const end = output.get("-to")?.[0];
	if (Number(frame !== undefined) + Number(duration !== undefined) + Number(end !== undefined) > 1) return unknown;
	if (frame !== undefined) {
		const frames = /^\d+$/.test(frame) ? Number(frame) : 0;
		return Number.isSafeInteger(frames) && frames > 0 ? { frames, duration: null } : unknown;
	}
	const logged = [...text.matchAll(/\bDuration:\s*(\d+:\d+:\d+(?:\.\d+)?)/g)];
	// Input seeking changes the available source duration; output -to uses the output's own origin.
	const total = duration !== undefined ? seconds(duration)
		: end !== undefined ? (seconds(end) ?? Number.NaN) - outputStart
			: logged.length === 1 ? (seconds(logged[0][1]) ?? Number.NaN) - inputStart - outputStart : null;
	return { frames: null, duration: total !== null && Number.isFinite(total) && total > 0 ? total : null };
}

/** Output can be a truncated tail. Missing totals remain unknown. */
export function parseProgress(command: string, output: string): LiveProgress | null {
	const invocation = parseRenderInvocation(command, output);
	if (!invocation || invocation.render.tool === "blender") return null;
	const render = invocation.render;
	const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
	if (render.tool === "ffmpeg") {
		const totals = ffmpegTotals(invocation.ffmpegOptions, text);
		const frames = [...text.matchAll(/(?:^|[\s\r])frame=\s*(\d+)\b/g)].at(-1);
		if (frames && totals.frames !== null) return progress("ffmpeg", Number(frames[1]), totals.frames, "frame");
		const times = [...text.matchAll(/(?:\btime=|^out_time=)\s*(\d+:\d+:\d+(?:\.\d+)?)/gm)];
		const micros = [...text.matchAll(/^out_time_(?:us|ms)=(\d+)\s*$/gm)];
		const time = times.at(-1);
		const micro = micros.at(-1);
		// FFmpeg's legacy out_time_ms key is also measured in microseconds.
		const done = micro && (!time || (micro.index ?? 0) > (time.index ?? 0)) ? Number(micro[1]) / 1_000_000 : seconds(time?.[1]);
		if (done !== null && totals.duration !== null) return progress("ffmpeg", done, totals.duration, "second");
		if (frames) return progress("ffmpeg", Number(frames[1]), null, "frame");
		return done !== null ? progress("ffmpeg", done, null, "second") : null;
	}
	if (render.tool === "remotion") {
		const match = [...text.matchAll(/(?:^|[\r\n])(?:Rendered|Encoded)\s+(\d+)\s*\/\s*(\d+)\b/g)].at(-1);
		return match ? progress("remotion", Number(match[1]), Number(match[2]), "frame") : null;
	}
	if (render.tool === "manim") {
		const complete = [...text.matchAll(/\bPlayed (\d+) animations?\b/g)].at(-1);
		if (complete) return progress("manim", Number(complete[1]), Number(complete[1]), "animation");
		const match = [...text.matchAll(/Animation (\d+):[^\r\n]*?\b(\d{1,3})%\|/g)].at(-1);
		if (!match || Number(match[2]) > 100) return null;
		// The percentage belongs to this animation, not to the entire scene.
		return { tool: "manim", done: Number(match[1]) + Number(match[2]) / 100, total: null, unit: "animation", percent: Number(match[2]) };
	}
	const match = [...text.matchAll(/Output written on .+? \((\d+) pages?\b/g)].at(-1);
	return match ? progress("latex", Number(match[1]), Number(match[1]), "page") : null;
}
