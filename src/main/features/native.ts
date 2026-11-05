import "@shared/contracts/native";
import { handle } from "../ipc";
import { nativeBridge } from "../omp/native-bridge";
import { readTerminalTheme } from "../omp/terminal-theme";

export function register(): void {
	handle("native:snapshot", hostId => nativeBridge(hostId).snapshot);
	handle("native:asyncWork", (hostId, generation) => nativeBridge(hostId).asyncWork(generation));
	handle("native:sessionAccounts", (hostId, generation) => nativeBridge(hostId).sessionAccounts(generation));
	handle("native:setMode", (hostId, request) => nativeBridge(hostId).setMode(request));
	handle("native:terminalTheme", hostId => readTerminalTheme(nativeBridge(hostId).snapshot));
}
