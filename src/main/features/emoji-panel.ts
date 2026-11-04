import { app } from "electron";
import { handle } from "../ipc";

export function register(): void {
	handle("app:emojiPanelSupported", () => app.isEmojiPanelSupported());
	handle("app:showEmojiPanel", () => {
		if (app.isEmojiPanelSupported()) app.showEmojiPanel();
	});
}
