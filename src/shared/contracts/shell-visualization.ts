import type { ShellFrame, ShellInvalidation, ShellOpenRequest, ShellResult, ShellSnapshotOpenRequest, ShellSnapshotUpdateRequest } from "../shell-visualization";

declare module "../ipc" {
	interface IpcInvokeMap {
		"shellviz:open": { args: [request: ShellOpenRequest]; result: ShellResult };
		"shellviz:openSnapshot": { args: [request: ShellSnapshotOpenRequest]; result: ShellResult };
		"shellviz:updateSnapshot": { args: [request: ShellSnapshotUpdateRequest]; result: ShellResult };
		"shellviz:action": { args: [handle: string, value: string]; result: ShellResult };
		"shellviz:release": { args: [handle: string]; result: void };
		"shellviz:cancel": { args: [requestId: string]; result: void };
	}
	interface IpcEventMap {
		"shellviz:frame": ShellFrame;
		"shellviz:invalidated": ShellInvalidation;
	}
}
