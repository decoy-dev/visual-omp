import { BrowserWindow, dialog } from "electron";
import type { McpScope, McpServerConfig } from "@shared/contracts/mcp";

function collectFileRefs(value: unknown, out: Set<string>): void {
	if (typeof value === "string") {
		for (const match of value.matchAll(/\{file:([^}]+)\}/g)) {
			if (match[1]) out.add(match[1]);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectFileRefs(item, out);
		return;
	}
	if (value && typeof value === "object") {
		for (const entry of Object.values(value)) collectFileRefs(entry, out);
	}
}

function collectCommandValues(record: Record<string, string> | undefined, out: Set<string>): void {
	if (!record) return;
	for (const value of Object.values(record)) {
		if (value.startsWith("!")) out.add(value.slice(1).trim());
	}
}

/** Authorizes one server invocation only, before substitutions, project settings or process startup. */
export async function confirmServerExecution(name: string, config: McpServerConfig, cwd: string, scope: McpScope, action: "check" | "sign-in"): Promise<void> {
	const destination = config.url ?? [config.command, ...(config.args ?? [])].filter(Boolean).join(" ");
	const lines = [
		`Folder: ${cwd}`,
		...(config.cwd && config.cwd !== cwd ? [`Working folder: ${config.cwd}`] : []),
		`Destination: ${destination || "Not configured"}`,
	];
	const headerKeys = Object.keys(config.headers ?? {});
	if (headerKeys.length > 0) lines.push(`Headers: ${headerKeys.join(", ")}`);
	const envKeys = Object.keys(config.env ?? {});
	if (envKeys.length > 0) lines.push(`Environment: ${envKeys.join(", ")}`);
	const valueCommands = new Set<string>();
	collectCommandValues(config.env, valueCommands);
	collectCommandValues(config.headers, valueCommands);
	if (valueCommands.size > 0) lines.push(`Value commands: ${[...valueCommands].join(", ")}`);
	const fileRefs = new Set<string>();
	collectFileRefs(config, fileRefs);
	if (fileRefs.size > 0) lines.push(`Files read: ${[...fileRefs].join(", ")}`);
	const options: Electron.MessageBoxOptions = {
		type: "warning",
		title: action === "check" ? "Allow this server connection?" : "Allow this server sign-in?",
		message: `${name} (${scope === "project" ? "This project" : "All projects"})`,
		detail: `${lines.join("\n")}\n\nThis action can run configured commands and file or environment substitutions, then send their results to this server. Allow it only if you trust this server's configuration. This permission applies to this invocation only.`,
		buttons: ["Cancel", "Allow this server"],
		defaultId: 0,
		cancelId: 0,
		noLink: true,
	};
	const win = BrowserWindow.getFocusedWindow();
	const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
	if (result.response !== 1) throw new Error("Server connection cancelled. No server commands were run.");
}
