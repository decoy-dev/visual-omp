import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { z } from "zod";
import { ToolCard } from "../../../chat/transcript/ToolCard";
import { FileRefContext } from "../../../chat/transcript/fileRefScope";
import { SavedToolOutputContext } from "../../../chat/transcript/savedBashOutput";
import { watchSessionFile } from "../../../state/sessionFiles";
import type { SessionHistory } from "../../../state/history";
import { PresentationVisibility } from "../../../state/tsp/presentation-claims";
import { LiveShellProvider } from "../context";
import { MotionProvider } from "../../../ui/motion";
import { TooltipProvider } from "../../../ui/Tooltip";
import { Button } from "../../../ui/Button";
import "../../../i18n";
import "../../../theme/tokens.css";
import "../../../theme/base.css";
import "../../../ui/ui.css";
import "../../../tool-render/tool-render.css";
import "../../../chat/transcript/transcript.css";

const Source = z.object({ mode: z.enum(["saved", "helper", "read-only", "retained"]), file: z.string(), cwd: z.string() });
type Source = z.infer<typeof Source>;
const State = z.object({ sources: z.array(Source), events: z.array(z.object({ channel: z.string(), value: z.unknown(), sequence: z.number() })), snapshot: z.object({ hostId: z.string(), generation: z.number(), epoch: z.number() }) });
const bridge = new URLSearchParams(location.search).get("bridge");
if (!bridge || new URL(bridge).hostname !== "127.0.0.1") throw new Error("Provide the isolated loopback shell fixture bridge.");
const listeners = new Map<string, Set<(value: unknown) => void>>();
let followed: string[] = [];
const identities = new Map<string, number>();
const invokes: { channel: string; args: unknown[]; result?: unknown; error?: string }[] = [];
function emit(channel: string, value: unknown) { for (const listener of listeners.get(channel) ?? []) listener(value); }
async function local(channel: string, args: unknown[]) {
	const response = await fetch(bridge + "/local/invoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: channel, args }) });
	if (!response.ok) throw new Error(await response.text());
	return (await response.json()).result;
}
async function readFollowed() {
	for (const file of followed) {
		const result = z.object({ text: z.string(), identity: z.number() }).parse(await local("sessions:read", [file]));
		if (!followed.includes(file) || identities.get(file) === result.identity) continue;
		identities.set(file, result.identity);
		emit("sessions:tail", { file, text: result.text, reset: true });
		emit("sessions:followState", { file, readable: true, ownership: "elsewhere", error: null });
	}
}
Object.defineProperty(window, "vomp", { configurable: true, value: {
	platform: "darwin",
	on(channel: string, callback: (value: unknown) => void) {
		const set = listeners.get(channel) ?? new Set(); set.add(callback); listeners.set(channel, set);
		return () => set.delete(callback);
	},
	async invoke(channel: string, ...args: unknown[]) {
		const invocation: typeof invokes[number] = { channel, args };
		invokes.push(invocation);
		if (channel === "sessions:follow") {
			followed = z.array(z.string()).parse(args[0]);
			for (const file of identities.keys()) if (!followed.includes(file)) identities.delete(file);
			await readFollowed(); return;
		}
		if (!/^(config:|shell-viz:)/.test(channel)) throw new Error(`Owning-host operation is forbidden: ${channel}`);
		try {
			const result = await local(channel, args);
			invocation.result = result;
			return result;
		} catch (error) {
			invocation.error = String(error);
			throw error;
		}
	},
} });

function RecordedCards({ source }: { source: Source }) {
	const [history, setHistory] = useState<SessionHistory | null>(null);
	useEffect(() => { setHistory(null); return watchSessionFile(source.file, next => setHistory(next)); }, [source.file]);
	if (!history) return <p>Reading the exact saved branch.</p>;
	const results = new Map(history.entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [[entry.message.toolCallId, entry.message] as const] : []));
	const calls = history.entries.flatMap(entry => entry.type === "message" && entry.message.role === "assistant" ? entry.message.content.flatMap(block => block.type === "toolCall" && block.name === "bash" ? [{ id: block.id, name: block.name, args: block.arguments }] : []) : []);
	const identity = source.file;
	return <SavedToolOutputContext.Provider value={{ file: source.file, identity }}><FileRefContext.Provider value={{ chat: "saved-fixture", bases: [source.cwd] }}>
		<div className="space-y-4" data-fixture-source={source.file} data-fixture-identity={identity} data-fixture-cwd={source.cwd}>{calls.slice(-2).map(call => <div key={call.id} data-fixture-call={call.id} data-fixture-result={results.has(call.id) ? "settled" : "absent"}><ToolCard name={call.name} args={call.args} result={results.get(call.id)} running={false} verbose={false} toolCallId={call.id} engageId={call.id} /></div>)}</div>
	</FileRefContext.Provider></SavedToolOutputContext.Provider>;
}
function Harness() {
	const [state, setState] = useState<z.infer<typeof State>>();
	const [mode, setMode] = useState<Source["mode"]>("saved");
	const [hidden, setHidden] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		let active = true;
		let sequence = 0;
		let timer: number;
		const refresh = async () => {
			try {
				const packet = State.parse(await (await fetch(bridge + "/shell/state")).json());
				if (!active) return;
				setState(previous => previous && JSON.stringify(previous.sources) === JSON.stringify(packet.sources) ? previous : packet);
				for (const event of packet.events) if (event.sequence > sequence) { sequence = event.sequence; emit(event.channel, event.value); }
				await readFollowed();
			} catch (failure) { if (active) setError(String(failure)); }
			if (active) timer = window.setTimeout(refresh, 100);
		};
		void refresh();
		return () => { active = false; clearTimeout(timer); };
	}, []);
	const source = state?.sources.find(source => source.mode === mode);
	return <MotionProvider><TooltipProvider><motion.main layoutScroll className="mx-auto h-screen max-w-[760px] space-y-4 overflow-auto bg-sheet p-4 text-fg">
		<h1 className="text-xl font-semibold">Recorded bash visualization</h1><p className="text-sm text-fg-muted">Production saved-file readers and local presentation process. The source host remains running.</p>
		<div className="flex flex-wrap items-center gap-2"><label htmlFor="source-mode">Chat source</label><select id="source-mode" value={mode} onChange={event => setMode(event.currentTarget.value as Source["mode"])}><option value="saved">Saved chat</option><option value="helper" disabled={!state?.sources.some(source => source.mode === "helper")}>Helper result</option><option value="read-only">Externally owned, read-only chat</option>{state?.sources.some(source => source.mode === "retained") && <option value="retained">Retained history</option>}</select><Button onClick={() => setHidden(!hidden)}>Toggle visibility</Button></div>
		{error && <p role="alert">{error}</p>}
		{source && state && <PresentationVisibility visible={!hidden}><LiveShellProvider {...state.snapshot} readOnly={true}><div hidden={hidden}><RecordedCards key={source.file} source={source} /></div></LiveShellProvider></PresentationVisibility>}
	</motion.main></TooltipProvider></MotionProvider>;
}
Object.defineProperty(window, "shellSavedFixture", { value: { invokes: () => invokes } });
createRoot(document.getElementById("root")!).render(<Harness />);
