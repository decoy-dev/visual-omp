import { writeDiagnostic } from "./events";

export interface DiagnosticTestOptions {
	packaged: boolean;
	explicitTest: boolean;
	dsn: string | undefined;
	enabled: boolean;
	crashRenderer(): void;
}

/** Developer-only, explicit opt-in. Ordinary renderer content can never trigger a test crash. */
export function runDiagnosticTest(kind: "event" | "renderer-crash", options: DiagnosticTestOptions): void {
	if (options.packaged || !options.explicitTest || !options.dsn || !options.enabled) {
		throw new Error("Diagnostics testing requires a development build with reporting and explicit test flags enabled.");
	}
	if (kind === "event") writeDiagnostic({ event: "diagnostics-test", kind: "event" });
	else if (kind === "renderer-crash") options.crashRenderer();
	else throw new Error("Unknown diagnostics test.");
}
