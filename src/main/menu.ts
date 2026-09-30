import { app, Menu, type MenuItemConstructorOptions, shell } from "electron";
import { broadcast } from "./ipc";

function command(label: string, id: string, accelerator?: string): MenuItemConstructorOptions {
	return { label, accelerator, click: () => broadcast("app:command", { id }) };
}

export function buildMenu(): void {
	const isMac = process.platform === "darwin";
	const template: MenuItemConstructorOptions[] = [
		...(isMac
			? [
					{
						label: app.name,
						submenu: [
							{ role: "about" },
							{ type: "separator" },
							command("Settings…", "app.settings", "CmdOrCtrl+,"),
							{ type: "separator" },
							{ role: "hide" },
							{ role: "hideOthers" },
							{ role: "unhide" },
							{ type: "separator" },
							{ role: "quit" },
						],
					} satisfies MenuItemConstructorOptions,
				]
			: []),
		{
			label: "File",
			submenu: [
				command("New Chat", "chat.new", "CmdOrCtrl+N"),
				command("New Project…", "project.new", "CmdOrCtrl+Shift+N"),
				command("Open Folder…", "project.open", "CmdOrCtrl+O"),
				{ type: "separator" },
				command("Close Chat", "chat.close", "CmdOrCtrl+W"),
				...(isMac ? [] : [{ type: "separator" } as const, command("Settings…", "app.settings", "Ctrl+,"), { role: "quit" } as const]),
			],
		},
		{ role: "editMenu" },
		{
			label: "View",
			submenu: [
				command("Command Palette…", "app.palette", "CmdOrCtrl+K"),
				command("Toggle Sidebar", "view.sidebar", "CmdOrCtrl+B"),
				command("Toggle Side Panel", "view.panel", "CmdOrCtrl+Alt+B"),
				command("Show omp Terminal", "view.terminal", "CmdOrCtrl+J"),
				{ type: "separator" },
				command("Toggle Light / Dark", "view.theme", "CmdOrCtrl+Shift+L"),
				command("Bigger Text", "view.zoomIn", "CmdOrCtrl+="),
				command("Smaller Text", "view.zoomOut", "CmdOrCtrl+-"),
				command("Default Text Size", "view.zoomReset", "CmdOrCtrl+0"),
				{ type: "separator" },
				{ role: "toggleDevTools" },
				{ role: "togglefullscreen" },
			],
		},
		{
			label: "Chat",
			submenu: [
				command("Stop", "chat.stop", "CmdOrCtrl+."),
				command("Restart omp", "chat.restart", "CmdOrCtrl+Shift+R"),
				command("Compact Conversation", "chat.compact"),
				command("Plan Mode", "chat.plan", "CmdOrCtrl+Shift+P"),
				{ type: "separator" },
				command("Choose Model…", "chat.model", "CmdOrCtrl+Shift+M"),
				command("Model Roles…", "manage.roles"),
				command("Agents…", "manage.agents"),
			],
		},
		{ role: "windowMenu" },
		{
			role: "help",
			submenu: [
				command("visual-omp Help", "app.help", "F1"),
				command("Take the Tour", "app.tour"),
				{ type: "separator" },
				{ label: "omp Documentation", click: () => void shell.openExternal("https://omp.sh") },
				{ label: "Report an Issue", click: () => void shell.openExternal("https://github.com/decoy-dev/visual-omp/issues") },
			],
		},
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
