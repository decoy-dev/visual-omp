import { BrowserWindow, ipcMain } from "electron";
import type { EventChannel, InvokeChannel, IpcEventMap, IpcInvokeMap } from "@shared/ipc";

type Handler<C extends InvokeChannel> = (
	...args: IpcInvokeMap[C]["args"]
) => IpcInvokeMap[C]["result"] | Promise<IpcInvokeMap[C]["result"]>;

/** Register a typed `ipcMain.handle` for a channel in {@link IpcInvokeMap}. */
export function handle<C extends InvokeChannel>(channel: C, handler: Handler<C>): void {
	ipcMain.handle(channel, (_event, ...args) => handler(...(args as IpcInvokeMap[C]["args"])));
}

const mainListeners = new Map<EventChannel, Set<(payload: never) => void>>();

/** Run `listener` in the main process whenever `channel` is broadcast (e.g. to drop a cache). */
export function onBroadcast<C extends EventChannel>(channel: C, listener: (payload: IpcEventMap[C]) => void): void {
	const listeners = mainListeners.get(channel) ?? new Set();
	listeners.add(listener as (payload: never) => void);
	mainListeners.set(channel, listeners);
}

/** Push an event to every renderer window and to main-process listeners. */
export function broadcast<C extends EventChannel>(channel: C, payload: IpcEventMap[C]): void {
	for (const listener of mainListeners.get(channel) ?? []) (listener as (payload: IpcEventMap[C]) => void)(payload);
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) win.webContents.send(channel, payload);
	}
}
