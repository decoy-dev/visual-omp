import type { AssistantMessage } from "@oh-my-pi/pi-wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { plainText } from "./ReplyAnnouncer";
import { renderMarkdown } from "../../transcript/render";

vi.mock("../../transcript/render", () => ({ renderMarkdown: vi.fn(() => "<p>Spoken reply</p>") }));
afterEach(() => vi.unstubAllGlobals());

describe("reply announcement text", () => {
	it("includes narration in reply order and excludes ordinary thinking", () => {
		vi.stubGlobal("document", { createElement: () => ({ innerHTML: "", content: { textContent: "Spoken reply" } }) });
		const message = {
			content: [
				{ type: "text", text: "First reply" },
				{ type: "thinking", thinking: "Hidden reasoning" },
				{ type: "thinking", thinking: "Narrated **reply**", narration: true },
				{ type: "text", text: "Last reply" },
			],
		} as AssistantMessage;
		expect(plainText(message)).toBe("Spoken reply");
		expect(renderMarkdown).toHaveBeenCalledWith("First reply\n\nNarrated **reply**\n\nLast reply");
	});
});
