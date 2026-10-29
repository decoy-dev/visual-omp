import { BrowserWindow, dialog } from "electron";
import type { McpScope, McpServerConfig } from "@shared/contracts/mcp";

/** Authorizes one server invocation only, before substitutions, project settings or process startup. */
export async function confirmServerExecution(name: string, config: McpServerConfig, cwd: string, scope: McpScope, action: "check" | "sign-in"): Promise<void> {
	const destination = config.url ?? [config.command, ...(config.args ?? [])].filter(Boolean).join(" ");
	const options: Electron.MessageBoxOptions = {
		type: "warning",
		title: action === "check" ? "Allow this server connection?" : "Allow this server sign-in?",
		message: `${name} (${scope === "project" ? "This project" : "All projects"})`,
		detail: `Folder: ${cwd}\nDestination: ${destination || "Not configured"}\n\nThis action can run configured commands and file or environment substitutions, then send their results to this server. Allow it only if you trust this server's configuration. This permission applies to this invocation only.`,
		buttons: ["Cancel", "Allow this server"],
		defaultId: 0,
		cancelId: 0,
		noLink: true,
	};
	const win = BrowserWindow.getFocusedWindow();
	const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
	if (result.response !== 1) throw new Error("Server connection cancelled. No server commands were run.");
}
