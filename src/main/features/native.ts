import "@shared/contracts/native";
import { handle } from "../ipc";
import { nativeBridge } from "../omp/native-bridge";
import { readTerminalTheme } from "../omp/terminal-theme";

export function register(): void {
	handle("native:snapshot", hostId => nativeBridge(hostId).snapshot);
	handle("native:setMode", (hostId, request) => nativeBridge(hostId).setMode(request));
	handle("native:terminalTheme", hostId => readTerminalTheme(nativeBridge(hostId).snapshot));
}
