import { DiagnosticsLog, type DiagnosticEvent } from "./log";
import { settleWithin } from "./deadline";

let log: DiagnosticsLog | null = null;
let reporter: ((event: DiagnosticEvent) => void) | null = null;
export function setDiagnosticReporter(listener: (event: DiagnosticEvent) => void): void {
	reporter = listener;
}
export function initializeDiagnosticsLog(file: string): DiagnosticsLog {
	return log ??= new DiagnosticsLog(file);
}
export function writeDiagnostic(event: DiagnosticEvent): void {
	log?.write(event);
	reporter?.(event);
}
export async function flushDiagnostics(): Promise<void> {
	if (log) await settleWithin(log.flush(), 1500);
}
