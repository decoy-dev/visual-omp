import type { CompactionEntry } from "@oh-my-pi/pi-wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import "../../i18n";
import { TooltipProvider } from "../../ui";
import { CompactionRow } from "./CompactionRow";

// The real renderer reads its HTML from an external store that static rendering does not support.
vi.mock("../../transcript/Markdown", () => ({ Markdown: ({ text }: { text: string }) => text }));

const entry = (method?: string): CompactionEntry => ({
	type: "compaction", id: "c", parentId: null, timestamp: "2026-11-09T16:34:08.077Z", summary: "## Goal\nContinue the checks.", firstKeptEntryId: "k", tokensBefore: 0, ...(method ? { method } : {}),
});
const html = (method: string | undefined, arrived: boolean) => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(CompactionRow, { entry: entry(method), arrived })));

describe("CompactionRow", () => {
	it("names a handoff and opens it when it arrives in an open chat", () => {
		const shown = html("handoff", true);
		expect(shown).toContain("Handed off");
		expect(shown).toContain('aria-expanded="true"');
		expect(shown).toContain("Continue the checks.");
		expect(shown).toContain("Copy handoff");
	});
	it("keeps a handoff from saved history closed", () => {
		const shown = html("handoff", false);
		expect(shown).toContain('aria-expanded="false"');
		expect(shown).not.toContain("Continue the checks.");
	});
	it("names other compaction methods and keeps them closed on arrival", () => {
		for (const method of [undefined, "soft", "snapcompact"]) {
			const shown = html(method, true);
			expect(shown).toContain("Context summarized");
			expect(shown).toContain('aria-expanded="false"');
		}
	});
});
