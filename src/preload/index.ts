import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { EventChannel, InvokeChannel, IpcEventMap, Platform, VompBridge } from "@shared/ipc";

/** Only `<area>:<action>` channels from the shared contract may cross the bridge. */
const CHANNEL_RE = /^[a-z]+:[a-zA-Z:.-]+$/;

const bridge: VompBridge = {
	invoke(channel: InvokeChannel, ...args: unknown[]) {
		if (!CHANNEL_RE.test(channel)) return Promise.reject(new Error(`blocked channel ${channel}`));
		return ipcRenderer.invoke(channel, ...args);
	},
	on<C extends EventChannel>(channel: C, listener: (payload: IpcEventMap[C]) => void) {
		if (!CHANNEL_RE.test(channel)) throw new Error(`blocked channel ${channel}`);
		const wrapped = (_event: Electron.IpcRendererEvent, payload: IpcEventMap[C]) => listener(payload);
		ipcRenderer.on(channel, wrapped);
		return () => {
			ipcRenderer.off(channel, wrapped);
		};
	},
	pathForFile(file: File) {
		return webUtils.getPathForFile(file);
	},
	platform: process.platform as Platform,
};

contextBridge.exposeInMainWorld("vomp", bridge);
