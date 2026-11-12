// @vitest-environment happy-dom
import { act, createElement, Suspense, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "./index";

// Idle preloading would load the deferred namespaces before these tests read them cold.
vi.mock("../registry/idle", () => ({ preloadWhenIdle: () => {} }));

type Messages = { [key: string]: string | Messages };
const files = import.meta.glob<Messages>("./*/*.json", { eager: true, import: "default" });
const pairs = [
	["settings", "manage", "general.description", "settings.title"],
	["context", "extensions", "mcp.subtitle", "mcp.title"],
	["projectDetails", "projects", "instructions.subtitle", "instructions.title"],
	["helperFocus", "panes", "tasks.focus.placeholder", "tasks.send"],
	["shellVisualization", "tools", "pseudoExplanation", "bash.savedOutput.load"],
] as const;

function leaves(messages: Messages, prefix = ""): string[] {
	return Object.entries(messages).flatMap(([key, value]) => {
		const path = prefix ? `${prefix}.${key}` : key;
		return typeof value === "string" ? [path] : leaves(value, path);
	});
}

function message(namespace: string, path: string): string {
	let value: string | Messages = files[`./en/${namespace}.json`]!;
	for (const key of path.split(".")) value = (value as Messages)[key]!;
	return value as string;
}

describe("translation loading", () => {
	it("keeps startup namespaces initialized synchronously and defers screen messages", () => {
		expect(i18n.isInitialized).toBe(true);
		for (const namespace of ["advisor", "chat", "composer", "extensions", "git", "home", "manage", "onboarding", "palette", "panes", "projects", "session", "shell", "tools"]) {
			expect(i18n.hasResourceBundle("en", namespace), namespace).toBe(true);
		}
		for (const [namespace, fallback, , key] of pairs) {
			expect(i18n.hasLoadedNamespace(namespace), namespace).toBe(false);
			expect(i18n.t(`${fallback}:${key}`)).toBe(message(fallback, key));
		}
		expect(i18n.hasLoadedNamespace(i18n.options.defaultNS as string)).toBe(true);
	});

	it("keeps deferred keys disjoint from every namespace they fall back to", () => {
		for (const [path, messages] of Object.entries(files)) {
			const language = path.split("/")[1];
			for (const [namespace, fallback] of pairs) {
				if (path !== `./${language}/${namespace}.json`) continue;
				const eagerKeys = new Set(leaves(files[`./${language}/${fallback}.json`]!));
				expect(leaves(messages).filter(key => eagerKeys.has(key)), `${language}/${namespace} and ${fallback}`).toEqual([]);
			}
		}
	});

	it("suspends each screen until its namespace is ready and commits only translated text", async () => {
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
		for (const [namespace, fallback, key, sharedKey] of pairs) {
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			const committed: string[] = [];
			function Screen() {
				const { t } = useTranslation([namespace, fallback], { nsMode: "fallback" });
				const text = `${t(key)} | ${t(sharedKey)}`;
				useLayoutEffect(() => { committed.push(text); }, [text]);
				return createElement("p", null, text);
			}
			try {
				act(() => flushSync(() => root.render(createElement(Suspense, { fallback: "Loading" }, createElement(Screen)))));
				expect(container.textContent).toBe("Loading");
				expect(committed).toEqual([]);
				await act(async () => { await i18n.loadNamespaces(namespace); });
				const expected = `${message(namespace, key)} | ${message(fallback, sharedKey)}`;
				expect(container.textContent).toBe(expected);
				expect(committed.length).toBeGreaterThan(0);
				expect(committed.every(text => text === expected)).toBe(true);
				expect(i18n.hasResourceBundle("en", namespace)).toBe(true);
			} finally {
				act(() => root.unmount());
				container.remove();
			}
		}
	});
});
