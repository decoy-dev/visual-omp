import { BrowserWindow, ipcMain } from "electron";
import type { EventChannel, InvokeChannel, IpcEventMap, IpcInvokeMap } from "@shared/ipc";

type Handler<C extends InvokeChannel> = (
	...args: IpcInvokeMap[C]["args"]
) => IpcInvokeMap[C]["result"] | Promise<IpcInvokeMap[C]["result"]>;

/** Register a typed `ipcMain.handle` for a channel in {@link IpcInvokeMap}. */
export function handle<C extends InvokeChannel>(channel: C, handler: Handler<C>): void {
	ipcMain.handle(channel, (_event, ...args) => handler(...(args as IpcInvokeMap[C]["args"])));
}

/** Push an event to every renderer window. */
export function broadcast<C extends EventChannel>(channel: C, payload: IpcEventMap[C]): void {
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) win.webContents.send(channel, payload);
	}
}
