import { handleWithEvent } from "../ipc";
import { CompletionDiagnosticIngestor } from "../services/diagnostics/completion";
import { writeDiagnostic } from "../services/diagnostics/events";

export function register(): void {
	const ingestor = new CompletionDiagnosticIngestor();
	handleWithEvent("app:completionDiagnostic", (event, payload) => {
		const diagnostic = ingestor.accept(event.sender, payload, performance.now(), Date.now());
		if (diagnostic) writeDiagnostic({ event: "chat-completion", ...diagnostic });
	});
}
