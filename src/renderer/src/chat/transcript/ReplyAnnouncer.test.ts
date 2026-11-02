import type { AssistantMessage } from "@oh-my-pi/pi-wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import { plainText, replyAnnouncement } from "./ReplyAnnouncer";
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

it("includes a write reply's Markdown without exposing the internal path", () => {
	vi.stubGlobal("document", { createElement: () => ({ innerHTML: "", content: { textContent: "Spoken reply" } }) });
	const message: AssistantMessage = {
		role: "assistant", model: "m", timestamp: 1000, stopReason: "toolUse",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
		content: [{ type: "toolCall", id: "out", name: "write", arguments: { path: "out://report", content: "The **report**." } }],
	};
	expect(plainText(message)).toBe("Spoken reply");
	expect(renderMarkdown).toHaveBeenCalledWith("The **report**.");
});

describe("stop announcements", () => {
	const t = i18n.getFixedT("en", "chat");
	const reply = (stopReason: AssistantMessage["stopReason"], errorMessage: string | undefined, text: string): AssistantMessage => ({
		role: "assistant", model: "m", timestamp: 1000, stopReason, errorMessage,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
		content: text ? [{ type: "text", text }] : [],
	});

	it("announces a plan proposal's silent stop as an ordinary reply, and says nothing for an empty one", () => {
		vi.stubGlobal("document", { createElement: () => ({ innerHTML: "", content: { textContent: "Plan written." } }) });
		const spoken = replyAnnouncement(reply("aborted", "__omp.silent_abort__", "Plan written."), t);
		expect(spoken).toBe(t("replied", { text: "Plan written." }));
		expect(spoken).not.toContain(t("stopped.aborted"));
		expect(replyAnnouncement(reply("aborted", "__omp.silent_abort__", ""), t)).toBe("");
	});

	it("still announces real stops and errors", () => {
		expect(replyAnnouncement(reply("aborted", undefined, "Partial"), t)).toBe(t("stopped.aborted"));
		expect(replyAnnouncement(reply("error", "429 rate limited", ""), t)).toBe(`${t("stopped.error")}. 429 rate limited`);
	});
});
