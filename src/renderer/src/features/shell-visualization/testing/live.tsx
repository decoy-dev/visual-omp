import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { z } from "zod";
import { TSP_KINDS, type TspNode } from "@shared/tsp";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { tspHostPatch, type TspHostPatch } from "@shared/tsp/patch";
import { ToolCard } from "../../../chat/transcript/ToolCard";
import { LiveShellProvider } from "../context";
import { PresentationVisibility } from "../../../state/tsp/presentation-claims";
import { MotionProvider } from "../../../ui/motion";
import { TooltipProvider } from "../../../ui/Tooltip";
import { Button } from "../../../ui/Button";
import "../../../i18n";
import "../../../theme/tokens.css";
import "../../../theme/base.css";
import "../../../ui/ui.css";
import "../../../tool-render/tool-render.css";
import "../../../chat/transcript/transcript.css";

type WireNode = { id: string; k: typeof TSP_KINDS[number]; p?: Record<string, unknown>; c?: WireNode[] };
const Node: z.ZodType<WireNode> = z.lazy(() => z.object({ id: z.string(), k: z.enum(TSP_KINDS), p: z.record(z.string(), z.unknown()).optional(), c: z.array(Node).optional() }));
const Snapshot = z.object({
	hostId: z.string(), generation: z.number().int(), epoch: z.number().int(), revision: z.number().int(), negotiated: z.boolean(),
	lifecycle: z.enum(["live", "transitioning", "failed", "exited"]), documentGeneration: z.number().int().nullable(), failure: z.string().nullable(),
	availability: z.object({ available: z.boolean(), reason: z.string().nullable() }),
	surfaces: z.array(z.object({ open: z.object({ id: z.string(), mode: z.enum(["inline", "screen"]), role: z.string().optional() }).loose(), sequence: z.number(), closed: z.boolean(), suspended: z.boolean(), document: Node, focus: z.string().nullable(), settled: z.array(z.string()), documentGeneration: z.number().int().nullable() })),
});
const Result = z.object({ content: z.array(z.object({ type: z.string() }).loose()), details: z.unknown().optional(), isError: z.boolean().optional() });
const Response = z.object({ snapshot: Snapshot, tools: z.array(z.object({ id: z.string(), name: z.string(), args: z.record(z.string(), z.unknown()), result: Result.optional(), running: z.boolean(), partialResult: z.unknown().optional() })), actions: z.array(z.unknown()) });
type Packet = z.infer<typeof Response>;
const bridge = new URLSearchParams(location.search).get("bridge");
if (!bridge || new URL(bridge).hostname !== "127.0.0.1") throw new Error("Provide the isolated loopback shell fixture bridge.");
const listeners = new Set<(patch: TspHostPatch) => void>();
let current: TspHostSnapshot | null = null;
let actions: unknown[] = [];

function materialize(snapshot: Packet["snapshot"]): TspHostSnapshot {
	// The schema validates the generic wire tree; kind-specific shell props are validated by production consumers.
	return { ...snapshot, surfaces: snapshot.surfaces.map(surface => ({ ...surface, document: surface.document as TspNode })) };
}
async function post(path: string, data?: unknown) {
	const response = await fetch(bridge + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data ?? {}) });
	if (!response.ok) throw new Error(await response.text());
}
Object.defineProperty(window, "vomp", { configurable: true, value: {
	platform: "darwin",
	on(channel: string, callback: (patch: TspHostPatch) => void) {
		if (channel !== "host:tsp-patch") return () => {};
		listeners.add(callback); return () => listeners.delete(callback);
	},
	async invoke(channel: string, ...args: unknown[]) {
		if (channel === "host:tsp-snapshot") return current;
		if (channel === "host:tsp-event") {
			const [hostId, generation, event, epoch] = z.tuple([z.string(), z.number(), z.object({ sf: z.string(), id: z.string(), act: z.literal("shell-viz"), value: z.string() }), z.number()]).parse(args);
			await post("/shell/action", { hostId, generation, epoch, ...event });
		}
		return undefined;
	},
} });

function Harness() {
	const [packet, setPacket] = useState<Packet | null>(null);
	const [error, setError] = useState("");
	const [dark, setDark] = useState(false);
	const [large, setLarge] = useState(false);
	const [hidden, setHidden] = useState(false);
	useEffect(() => {
		let active = true;
		let timer: ReturnType<typeof setTimeout>;
		let lastTools = "";
		const refresh = async () => {
			try {
				const next = Response.parse(await (await fetch(bridge + "/shell/state")).json());
				if (!active) return;
				const snapshot = materialize(next.snapshot);
				const toolKey = JSON.stringify(next.tools.map(tool => [tool.id, tool.running, !!tool.result]));
				if (snapshot.revision !== current?.revision || toolKey !== lastTools) {
					const changed = snapshot.revision !== current?.revision;
					current = snapshot; lastTools = toolKey; actions = next.actions;
					if (changed) for (const listener of listeners) listener(tspHostPatch(null, snapshot));
					setPacket(next);
				}
			} catch (failure) { if (active) setError(String(failure)); }
			if (active) timer = setTimeout(refresh, 100);
		};
		void refresh();
		return () => { active = false; clearTimeout(timer); };
	}, []);
	useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; }, [dark]);
	useEffect(() => { document.documentElement.style.fontSize = large ? "130%" : "100%"; }, [large]);
	return <MotionProvider><TooltipProvider><motion.main layoutScroll className="mx-auto h-screen max-w-[760px] space-y-4 overflow-auto bg-sheet p-4 text-fg">
		<h1 className="text-xl font-semibold">Live bash visualization</h1>
		<p className="text-sm text-fg-muted">Production tool cards connected to an isolated omp fixture.</p>
		<div className="flex flex-wrap gap-2"><Button onClick={() => void post("/shell/run").catch(failure => setError(String(failure)))}>Run again</Button><Button onClick={() => setDark(!dark)}>Toggle theme</Button><Button onClick={() => setLarge(!large)}>Toggle larger text</Button><Button onClick={() => setHidden(!hidden)}>Toggle visibility</Button></div>
		{error && <p role="alert">{error}</p>}
		{packet && <PresentationVisibility visible={!hidden}><LiveShellProvider hostId={packet.snapshot.hostId} generation={packet.snapshot.generation} epoch={packet.snapshot.epoch} readOnly={false}>
			<div hidden={hidden} className="space-y-4">{packet.tools.slice(-2).map(tool => <div key={tool.id} data-fixture-call={tool.id}><ToolCard name={tool.name} args={tool.args} result={tool.result} partialResult={tool.partialResult} running={tool.running} verbose={false} toolCallId={tool.id} engageId={tool.id} /></div>)}</div>
		</LiveShellProvider></PresentationVisibility>}
	</motion.main></TooltipProvider></MotionProvider>;
}
Object.defineProperty(window, "shellFixture", { value: { actions: () => actions, snapshot: () => current } });
createRoot(document.getElementById("root")!).render(<Harness />);
