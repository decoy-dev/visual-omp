import type { VompBridge } from "../shared/ipc";

declare global {
	interface Window {
		vomp: VompBridge;
	}
}
