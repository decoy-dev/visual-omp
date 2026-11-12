import type { ShellFrame, ShellInvalidation, ShellOpenRequest, ShellResult, ShellSnapshotOpenRequest, ShellSnapshotUpdateRequest } from "../shell-visualization";

declare module "../ipc" {
	interface IpcInvokeMap {
		"shell-viz:open": { args: [request: ShellOpenRequest]; result: ShellResult };
		"shell-viz:openSnapshot": { args: [request: ShellSnapshotOpenRequest]; result: ShellResult };
		"shell-viz:updateSnapshot": { args: [request: ShellSnapshotUpdateRequest]; result: ShellResult };
		"shell-viz:action": { args: [handle: string, value: string]; result: ShellResult };
		"shell-viz:release": { args: [handle: string]; result: void };
		"shell-viz:cancel": { args: [requestId: string]; result: void };
	}
	interface IpcEventMap {
		"shell-viz:frame": ShellFrame;
		"shell-viz:invalidated": ShellInvalidation;
	}
}
