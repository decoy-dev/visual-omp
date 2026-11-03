// @vitest-environment happy-dom
import { act, createElement, type PropsWithChildren } from "react";
import { createRoot } from "react-dom/client";
import type * as MotionModule from "motion/react";
import { expect, it, vi } from "vitest";
import type { SessionController } from "../../state/session";
import { TooltipProvider } from "../../ui";
import { QueueTray } from "./QueueTray";
import "../../i18n";

vi.hoisted(() => { Object.assign(window, { vomp: { platform: "darwin" } }); });
vi.mock("motion/react", async importOriginal => {
	const actual = await importOriginal<typeof MotionModule>();
	// The hoisted factory runs before static React imports initialize.
	const { createElement } = await import("react");
	const tag = (name: string) => ({ children, initial, animate, exit, transition, layout, layoutId, variants, custom, ...props }: PropsWithChildren<Record<string, unknown>>) => createElement(name, props, children);
	return { ...actual, AnimatePresence: ({ children }: PropsWithChildren) => children, motion: { ...actual.motion, div: tag("div"), li: tag("li") }, useReducedMotionConfig: () => true };
});

it("shows omp's image rejection on the retained message without a stranded-image restart hint", async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	const container = document.createElement("div"); document.body.append(container);
	const root = createRoot(container);
	const error = "Failed to read pasted image path <live-check.png>";
	try {
		await act(async () => root.render(createElement(TooltipProvider, null, createElement(QueueTray, {
			session: {} as SessionController,
			queue: [{ id: "failed", text: "Describe this image", images: [{ path: "/workspace/live-check.png", name: "live-check.png" }], error }],
			questionId: null, strandedImages: false,
		}))));
		expect(container.querySelector('[role="status"]')?.textContent).toBe(error);
		expect(container.textContent).toContain("Describe this image");
		expect(container.textContent).toContain("1 image");
		expect(container.textContent).toContain("Send message now");
		expect(container.textContent).not.toContain("Restart omp");
		expect(container.querySelector('[role="status"]')?.childElementCount).toBe(0);
		expect(container.textContent).toContain("Review the failed message, then send it again.");
	} finally { await act(async () => root.unmount()); container.remove(); }
});
