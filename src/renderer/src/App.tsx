import { useEffect, useState, useSyncExternalStore } from "react";
import type { HostState, OmpStatus } from "@shared/ipc";
import { GuestClient } from "./collab/lib/client";

/** Engine probe: starts one omp session and shows the mirrored live state. Replaced by the app shell. */
export function App() {
	const [status, setStatus] = useState<OmpStatus | null>(null);
	const [host, setHost] = useState<HostState | null>(null);
	const [client, setClient] = useState<GuestClient | null>(null);

	useEffect(() => {
		void window.vomp.invoke("omp:status").then(setStatus);
		return window.vomp.on("host:state", setHost);
	}, []);

	useEffect(() => {
		if (!host?.link) return;
		const guest = new GuestClient(host.link, "visual-omp");
		guest.connect();
		setClient(guest);
		return () => guest.close();
	}, [host?.link]);

	const start = async () => {
		const cwd = new URLSearchParams(location.search).get("cwd") ?? (await window.vomp.invoke("app:info")).homeDir;
		setHost(await window.vomp.invoke("host:start", { cwd }));
	};

	return (
		<main style={{ fontFamily: "system-ui", padding: 24 }}>
			<h1>visual-omp engine probe</h1>
			<pre data-testid="omp-status">{JSON.stringify(status, null, 2)}</pre>
			<button type="button" onClick={() => void start()}>
				Start omp
			</button>
			<pre data-testid="host-state">{JSON.stringify(host, null, 2)}</pre>
			{client && <GuestView client={client} hostId={host?.hostId ?? ""} />}
		</main>
	);
}

function GuestView({ client, hostId }: { client: GuestClient; hostId: string }) {
	const snapshot = useSyncExternalStore(
		listener => client.subscribe(listener),
		() => client.getSnapshot(),
	);
	const [text, setText] = useState("");
	return (
		<section>
			<pre data-testid="guest">
				{JSON.stringify(
					{
						phase: snapshot.phase,
						entries: snapshot.entries.length,
						working: snapshot.working,
						model: snapshot.state?.model?.id,
						context: snapshot.state?.contextUsage,
						stream: snapshot.stream?.content?.length ?? 0,
						tools: [...snapshot.activeTools.keys()],
						uiRequest: snapshot.uiRequest,
					},
					null,
					2,
				)}
			</pre>
			<input value={text} onChange={event => setText(event.target.value)} aria-label="Message" />
			<button type="button" onClick={() => void window.vomp.invoke("host:submit", hostId, text)}>
				Send
			</button>
		</section>
	);
}
