// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { chatSlots } from "../../registry/slots";
import type { SessionController, SessionView } from "../../state/session";
import { TooltipProvider } from "../../ui/Tooltip";
import "../../i18n";

const prefetch = vi.hoisted(() => vi.fn());
vi.mock("../../features/compaction/settingsCache", () => ({ prefetchCompactionSettings: prefetch }));
// The popover's lazy compaction section reads omp through IPC; ChatCompaction.test.ts covers it.
vi.mock("../../features/compaction/ChatCompaction", () => ({ ChatCompaction: () => null }));
import "./tools";

it("keeps Compact available while working and sends /compact through the app queue", async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	const send = vi.fn().mockResolvedValue(undefined);
	const command = vi.fn();
	const view = { working: true, readOnly: false, guest: { state: { contextUsage: { percent: 70, tokens: 7000, contextWindow: 10000 } } } } as unknown as SessionView;
	const session = { projectPath: "/project", subscribe: () => () => {}, getSnapshot: () => view, send, command } as unknown as SessionController;
	const container = document.createElement("div"); document.body.append(container);
	const root = createRoot(container);
	try {
		const component = chatSlots.get("composer.context")!.component;
		await act(async () => root.render(createElement(TooltipProvider, null, createElement(component, { session }))));
		// The ring starts reading omp's settings before the popover opens, so the popover's preview is ready.
		expect(prefetch).toHaveBeenCalledExactlyOnceWith("/project");
		const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Context used: 70%"]')!;
		await act(async () => trigger.click());
		const compact = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Queue compaction");
		expect(compact).toBeDefined();
		expect(compact!.disabled).toBe(false);
		expect(document.body.textContent).toContain("Queues /compact for when omp finishes the current reply.");
		await act(async () => compact!.click());
		expect(send).toHaveBeenCalledExactlyOnceWith("/compact");
		expect(command).not.toHaveBeenCalled();
	} finally {
		await act(async () => root.unmount()); container.remove();
	}
});
