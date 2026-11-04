// @vitest-environment happy-dom
import type { BackendModule } from "i18next";
import { act, createElement, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n, useDeferredTranslation } from "../i18n";
import { lazySection } from "./lazy";

// Idle preloading would load the chunks and deferred texts before these tests read them cold.
vi.mock("./idle", () => ({ preloadWhenIdle: () => {} }));

type Messages = { [key: string]: string | Messages };
const files = import.meta.glob<Messages>("../i18n/en/{settings,manage,context,extensions,shell}.json", { eager: true, import: "default" });
function message(namespace: string, path: string): string {
	let value: string | Messages = files[`../i18n/en/${namespace}.json`]!;
	for (const key of path.split(".")) value = (value as Messages)[key]!;
	return value as string;
}

const sectionProps = { projectPath: null, scope: "global" as const, setScope() {}, props: undefined };
let container: HTMLDivElement;
let root: Root;
let crashes: unknown[];

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	container = document.createElement("div");
	document.body.append(container);
	crashes = [];
	root = createRoot(container, { onUncaughtError: error => crashes.push(error) });
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.restoreAllMocks();
});

/** The window around a section: a control that must keep working while the section fails. */
function Shell({ children }: { children: ReactNode }): ReactNode {
	const [actions, setActions] = useState(0);
	return createElement("main", null, createElement("button", { onClick: () => setActions(count => count + 1) }, `Shell actions: ${actions}`), children);
}

function button(label: string): HTMLButtonElement | undefined {
	return [...container.querySelectorAll("button")].find(candidate => candidate.textContent === label);
}

it("shows Try again instead of raw keys when a section's texts do not load, then the section once they load", async () => {
	const backend = i18n.services.backendConnector.backend as BackendModule;
	const read = vi.spyOn(backend, "read").mockImplementation((_language, _namespace, callback) => callback(new Error("Namespace chunk unavailable"), false));
	function Screen(): ReactNode {
		const { t } = useDeferredTranslation("settings");
		return createElement("output", null, `${t("general.description")} | ${t("settings.title")}`);
	}
	const Section = lazySection(async () => Screen);
	await act(async () => root.render(createElement(Shell, null, createElement(Section, sectionProps))));
	await act(async () => {
		await Section.preload();
	});
	expect(container.textContent).toContain(message("shell", "load.failedTitle"));
	expect(container.querySelector("output")).toBeNull();
	await act(async () => button("Shell actions: 0")!.click());
	expect(button("Shell actions: 1")).toBeDefined();

	read.mockRestore();
	await act(async () => {
		button(message("shell", "load.retry"))!.click();
		// Try again loads the texts through the app's own loader; await the same module.
		await import("../i18n/en/settings.json");
	});
	expect(container.querySelector("output")!.textContent).toBe(`${message("settings", "general.description")} | ${message("manage", "settings.title")}`);
	expect(crashes).toEqual([]);
});

it("shows Try again for a section whose texts failed to load before it opened, then the section once they load", async () => {
	// Like a failed idle preload: i18next counts the failed namespace as loaded, so the section does not suspend.
	const backend = i18n.services.backendConnector.backend as BackendModule;
	const read = vi.spyOn(backend, "read").mockImplementation((_language, _namespace, callback) => callback(new Error("Namespace chunk unavailable"), false));
	await i18n.loadNamespaces("context");
	read.mockRestore();
	function Screen(): ReactNode {
		const { t } = useDeferredTranslation("context");
		return createElement("output", null, `${t("mcp.subtitle")} | ${t("mcp.title")}`);
	}
	const Section = lazySection(async () => Screen);
	await act(async () => root.render(createElement(Shell, null, createElement(Section, sectionProps))));
	await act(async () => {
		await Section.preload();
	});
	expect(container.textContent).toContain(message("shell", "load.failedTitle"));
	expect(container.querySelector("output")).toBeNull();
	await act(async () => button("Shell actions: 0")!.click());
	expect(button("Shell actions: 1")).toBeDefined();

	await act(async () => {
		button(message("shell", "load.retry"))!.click();
		// Try again loads the texts through the app's own loader; await the same module.
		await import("../i18n/en/context.json");
	});
	expect(container.querySelector("output")!.textContent).toBe(`${message("context", "mcp.subtitle")} | ${message("extensions", "mcp.title")}`);
	expect(crashes).toEqual([]);
});

it("shows Try again when a section's code does not load, then the section once it loads", async () => {
	let available = false;
	const Section = lazySection(async () => {
		if (!available) throw new Error("Chunk unavailable");
		return () => createElement("output", null, "Section content");
	});
	await act(async () => root.render(createElement(Shell, null, createElement(Section, sectionProps))));
	await act(async () => {
		await Section.preload().catch(() => {});
	});
	expect(container.textContent).toContain(message("shell", "load.failedTitle"));
	await act(async () => button("Shell actions: 0")!.click());
	expect(button("Shell actions: 1")).toBeDefined();

	available = true;
	await act(async () => {
		button(message("shell", "load.retry"))!.click();
		await Section.preload();
	});
	expect(container.querySelector("output")!.textContent).toBe("Section content");
	expect(crashes).toEqual([]);
});

it("lets an error that is not a load failure reach the root instead of the retry state", async () => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	const Section = lazySection(async () => () => {
		throw new Error("A rendering bug");
	});
	// Under act, React rethrows an uncaught render error from act as well as reporting it to the root.
	let thrown: unknown;
	try {
		await act(async () => {
			root.render(createElement(Shell, null, createElement(Section, sectionProps)));
			await Section.preload();
		});
	} catch (error) {
		thrown = error;
	}
	const reported = [...(thrown instanceof AggregateError ? thrown.errors : [thrown]), ...crashes];
	expect(reported).toContainEqual(expect.objectContaining({ message: "A rendering bug" }));
	expect(container.textContent).not.toContain(message("shell", "load.failedTitle"));
});
