import type * as Ui from "@/ui";
import type { AgentEntry } from "@shared/contracts/agents";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import "../../../i18n";
import { AgentEditor } from "./AgentEditor";

// The sheet portal requires a browser. Render its content in place to exercise the editor form.
vi.mock("@/ui", async () => {
	const actual = await vi.importActual<typeof Ui>("@/ui");
	return {
		...actual,
		Sheet: ({ children }: { children: ReactNode }) => children,
		SheetContent: ({ children }: { children: ReactNode }) => children,
	};
});

const entry: AgentEntry = {
	id: "helper", name: "helper", description: "Helps", systemPrompt: "Help with the task.",
	scope: "user", filePath: "/fixture/agents/helper.md", enabled: true, modelOverride: null,
	active: true, shadowedBy: null, overrides: [], warnings: [], tools: [],
};

function render(existing: boolean): string {
	return renderToStaticMarkup(createElement(AgentEditor, {
		target: existing ? { kind: "edit", entry } : { kind: "create" },
		cwd: "/tmp",
		dirs: { user: "/fixture/agents", project: null, projectDefault: null },
		models: [],
		takenNames: new Set<string>(),
		initialScope: "user",
		onClose: () => {},
		onSaved: () => {},
		onTest: () => {},
	}));
}

describe("helper editor tool access", () => {
	it("retains an explicit empty allowlist when editing a helper", () => {
		expect(render(true)).toContain('data-state="unchecked"');
	});

	it("uses omp defaults for a new helper", () => {
		expect(render(false)).toContain('data-state="checked"');
	});
});
