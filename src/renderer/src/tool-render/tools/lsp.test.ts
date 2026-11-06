// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolRenderProps } from "../types";
import { lspRenderer } from "./lsp";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function body(text: string, args: Record<string, unknown> = {}, details?: unknown, isError = false): HTMLElement {
	const container = document.createElement("div");
	container.innerHTML = renderToStaticMarkup(createElement(lspRenderer.Body!, { name: "lsp", args, result: { content: [{ type: "text", text }], details, isError } }));
	return container;
}

const references = [
	"Found 2 reference(s):",
	"  src/cart.ts:12:7",
	"    11: // 2 error(s), 1 warning(s)",
	"    12: const total = calculate(cart);",
	"    13: // ```typescript",
	"  src/checkout.ts:24:3",
	"    24: return calculate(cart);",
].join("\n");

describe("LSP result presentation", () => {
	it("shows highlighted reference previews before any diagnostics or hover heuristics", () => {
		const view = body(references, { action: "references" });
		expect(view.textContent).toContain("2 references");
		expect(view.querySelectorAll(".tv-path")).toHaveLength(2);
		expect(view.querySelectorAll(".tv-pre")).toHaveLength(2);
		expect(view.textContent).toContain("12: const total = calculate(cart);");
		expect(view.querySelector(".font-semibold")?.textContent).toContain("12: const total");
		expect(view.querySelectorAll(".tv-badge--err")).toHaveLength(0);
		expect([...view.querySelectorAll("span")].find(span => span.classList.contains("text-(--syn-keyword)"))?.textContent).toBe("const");
	});

	it.each(["definition", "type definition", "implementation"])("keeps %s source context and literal file targets", noun => {
		const view = body(`Found 1 ${noun}(s):\n  C:\\work\\a.ts:2:4\n    1: // context\n    2: export const name = '<script>';`);
		expect(view.textContent).toContain(`1 ${noun}`);
		expect(view.querySelector("[data-context-path]")?.getAttribute("data-context-path")).toBe("C:\\work\\a.ts");
		expect(view.textContent).toContain("1: // context");
		expect(view.textContent).toContain("<script>");
		expect(view.querySelector("script")).toBeNull();
	});

	it("uses omp's structured request and action when call arguments are absent", () => {
		const props: ToolRenderProps = { name: "lsp", args: {}, result: { content: [{ type: "text", text: references }], details: { action: "references", serverName: "typescript", success: true, request: { file: "src/cart.ts", line: 12 } } } };
		const summary = renderToStaticMarkup(createElement(lspRenderer.Summary, props));
		const detail = renderToStaticMarkup(createElement(lspRenderer.Body!, props));
		expect(summary).toContain("references");
		expect(summary).toContain("src/cart.ts");
		expect(detail).toContain("typescript");
		expect(detail).toContain("2 references");
	});

	it("counts every grouped diagnostic file and keeps full messages", () => {
		const message = "A detailed diagnostic ".repeat(20);
		const view = body([
			"✗ src/a.ts: 1 error(s)", "# src/", "## a.ts", `  2:3 [error] ${message}`,
			"✗ src/nested/b.ts: 1 warning(s)", "# src/nested/", "## b.ts", "  4:5 [warning] Unused value",
			"✓ src/clean.ts: no issues",
		].join("\n"), { action: "diagnostics" });
		expect(view.textContent).toContain("3 files");
		expect(view.textContent).toContain("1 error");
		expect(view.textContent).toContain("1 warning");
		expect(view.textContent).toContain(message.trimEnd());
		expect([...view.querySelectorAll("[data-context-path]")].map(row => row.getAttribute("data-context-path"))).toEqual(["src/a.ts", "src/nested/b.ts"]);
	});

	it("reports failed and unverified servers alongside successful diagnostics", () => {
		const view = body([
			"✗ src/broken.ts: all language servers failed (typescript)",
			"⚠ src/pending.ts: no diagnostics report yet from biome; retry once it finishes analyzing",
			"⚠ src/a.ts: some servers failed (eslint)",
			"src/a.ts:2:3 [warning] Unused value",
		].join("\n"), { action: "diagnostics" });
		expect(view.textContent).toContain("3 files");
		expect(view.textContent).toContain("1 file with server failures");
		expect(view.textContent).toContain("1 unverified file");
		expect(view.textContent).toContain("some servers failed (eslint)");
		expect(view.textContent).toContain("Unused value");
		expect(view.textContent).not.toContain("No issues");
	});

	it("reports details.success false even without isError", () => {
		const view = body("LSP error from typescript on hover: connection closed", {}, { action: "hover", serverName: "typescript", success: false });
		expect(view.textContent).toContain("Request failed");
		expect(view.textContent).toContain("connection closed");
		expect(view.textContent).not.toContain("No issues");
	});

	it("does not present a missing diagnostic server as clean", () => {
		const view = body("[-] src/a.ts: No language server found", { action: "diagnostics" });
		expect(view.textContent).toContain("1 file with server failures");
		expect(view.textContent).toContain("No language server found");
		expect(view.textContent).not.toContain("No issues");
	});

	it("only reports clean diagnostics for understood clean output", () => {
		expect(body("OK", { action: "diagnostics" }).textContent).toContain("No issues");
		expect(body("2 error(s):", { action: "diagnostics" }).textContent).toContain("2 error(s):");
		expect(body("2 error(s):", { action: "diagnostics" }).textContent).not.toContain("No issues");
	});

	it("retains unknown output and additional lines in partially understood results", () => {
		const unknown = "# Unexpected response\nSome future format\n  raw: contents";
		expect(body(unknown, { action: "diagnostics" }).querySelector("pre")?.textContent).toBe(unknown);
		const view = body("src/a.ts:2:3 [error] Bad type\nAdditional server information", { action: "diagnostics" });
		expect(view.textContent).toContain("Bad type");
		expect(view.textContent).toContain("Additional server information");
		const locations = body(`${references}\n  ... 4 additional reference(s) shown without context`, { action: "references" });
		expect(locations.textContent).toContain("4 additional reference(s) shown without context");
	});

	it("leaves arbitrary request and hover responses literal", () => {
		const text = "src/a.ts:2:3 [error] Literal response\n2 error(s)\n```typescript\nconst x = 1;\n```";
		for (const action of ["request", "hover"]) expect(body(text, { action }).querySelector("pre")?.textContent).toBe(text);
	});

	it("accepts older unindented locations and flat diagnostics without details", () => {
		expect(body("src/old.ts:7:8", { action: "definition" }).querySelector(".tv-path")?.textContent).toBe("src/old.ts:7:8");
		expect(body("1 error(s):\nsrc/old.ts:2:3 [error] Old diagnostic").textContent).toContain("Old diagnostic");
	});

	it("retains malformed structured metadata without crashing or claiming success", () => {
		const text = "Unknown server response";
		expect(body(text, {}, { request: [], action: 42, success: "false", serverName: {} }).textContent).toContain(text);
	});

	it("does not mark an absent action as malformed", () => {
		expect(body("Older response without request metadata").textContent).not.toContain("[invalid action]");
		expect(body("Malformed action", { action: 42 }).textContent).toContain("[invalid action]");
	});

	it.each(["references", "diagnostics"])("reveals %s beyond the first page", async action => {
		const text = action === "references"
			? `Found 25 reference(s):\n${Array.from({ length: 25 }, (_, i) => `  src/a.ts:${i + 1}:1\n    ${i + 1}: call${i}();`).join("\n")}`
			: Array.from({ length: 25 }, (_, i) => `src/a.ts:${i + 1}:1 [error] Diagnostic ${i}`).join("\n");
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(createElement(lspRenderer.Body!, { name: "lsp", args: { action }, result: { content: [{ type: "text", text }] } })));
			expect(container.querySelectorAll(".tv-row")).toHaveLength(24);
			const more = [...container.querySelectorAll("button")].find(button => button.textContent === "Show 1 more result")!;
			expect(more).toBeDefined();
			await act(async () => more.click());
			expect(container.querySelectorAll(".tv-row")).toHaveLength(25);
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});
});
