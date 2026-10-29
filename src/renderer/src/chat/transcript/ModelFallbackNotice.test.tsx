import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ModelFallbackNotice } from "./ModelFallbackNotice";
import chat from "../../i18n/en/chat.json";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string, values: Record<string, string> = {}) => {
		const text = chat.modelFallback[key.split(".")[1] as keyof typeof chat.modelFallback];
		return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => values[name] ?? "");
	} }),
}));

describe("fallback notice presentation", () => {
	it("uses the shared warning treatment and names both recorded models", () => {
		const html = renderToStaticMarkup(<ModelFallbackNotice fallback={{ from: "Claude", to: "GPT", source: "retry" }} />);
		expect(html).toContain('role="note"');
		expect(html).toContain("bg-warn-bg");
		expect(html).toContain("omp switched from Claude to GPT as a fallback.");
		expect(html).not.toContain("usage limit");
	});

	it("does not invent a missing original model or reset", () => {
		const html = renderToStaticMarkup(<ModelFallbackNotice fallback={{ to: "GPT", source: "retry" }} />);
		expect(html).toContain("omp switched to GPT as a fallback.");
		expect(html).not.toContain("undefined");
		expect(html).not.toContain("reset");
	});

	it("quotes recorded error and reset text safely as historical information", () => {
		const html = renderToStaticMarkup(<ModelFallbackNotice fallback={{ from: "Claude", to: "GPT", source: "retry", reason: "Usage limit. Reset at 18:00. <script>bad()</script>" }} />);
		expect(html).toContain("At the switch, omp reported: Usage limit. Reset at 18:00.");
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
	});

	it("distinguishes provider fallback within a reply", () => {
		const html = renderToStaticMarkup(<ModelFallbackNotice fallback={{ from: "Fable", to: "Opus", source: "provider" }} />);
		expect(html).toContain("The provider switched this reply from Fable to Opus as a fallback.");
	});
});
