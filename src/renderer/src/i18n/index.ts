/**
 * Translation-ready UI text. Startup namespaces are bundled synchronously; settings, context and
 * projectDetails preload in idle time or load when their screens call `useDeferredTranslation`. Those
 * hooks suspend inside lazyView's boundary until loading settles; a namespace that fails to load
 * throws a `LoadError` to the surface's load boundary instead of showing raw keys. Languages match
 * `i18n/<lang>/*.json`.
 */
import i18n, { type BackendModule } from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import { preloadWhenIdle } from "../registry/idle";
import { LoadError } from "../registry/loadError";

type Messages = Record<string, unknown>;

const files = import.meta.glob<Messages>(["./*/*.json", "!./*/{settings,context,projectDetails,helperFocus,shellVisualization}.json"], { eager: true, import: "default" });
const deferred = import.meta.glob<Messages>("./*/{settings,context,projectDetails,helperFocus,shellVisualization}.json", { import: "default" });
const resources: Record<string, Record<string, Messages>> = {};
for (const [path, messages] of Object.entries(files)) {
	const match = /^\.\/([^/]+)\/([^/]+)\.json$/.exec(path);
	if (!match) continue;
	const [, lang, namespace] = match;
	if (!lang || !namespace) continue;
	resources[lang] ??= {};
	resources[lang][namespace] = messages;
}

/** Each deferred namespace and the startup namespace it shares keys with (`nsMode: "fallback"`). */
const deferredFallbacks = { settings: "manage", context: "extensions", projectDetails: "projects", helperFocus: "panes", shellVisualization: "tools" } as const;
export type DeferredNamespace = keyof typeof deferredFallbacks;

const backend: BackendModule = {
	type: "backend",
	init() {},
	read(language, namespace, callback) {
		const load = deferred[`./${language}/${namespace}.json`];
		if (!load) {
			callback(new Error(`Unknown translation namespace: ${language}/${namespace}`), false);
			return;
		}
		void load().then(messages => callback(null, messages), error => callback(error, false));
	},
};

void i18n.use(backend).use(initReactI18next).init({
	lng: "en",
	fallbackLng: "en",
	resources,
	partialBundledLanguages: true,
	ns: Object.keys(resources.en ?? {}),
	defaultNS: "shell",
	interpolation: { escapeValue: false },
	returnNull: false,
	react: { useSuspense: true },
});

/**
 * `language|namespace` pairs whose last load failed: set when a load fails, cleared when its texts arrive.
 * i18next does not load a failed namespace again, so `retryFailedNamespaces` loads and adds it itself.
 */
const failedLoads = new Set<string>();
i18n.on("failedLoading", (language: string, namespace: string) => failedLoads.add(`${language}|${namespace}`));
i18n.store.on("added", (language: string, namespace: string) => failedLoads.delete(`${language}|${namespace}`));

preloadWhenIdle(() => i18n.loadNamespaces(Object.keys(deferredFallbacks)));

/**
 * Text for a screen that loads with its own namespace: keys come from `namespace`, then from the startup
 * namespace it shares keys with. Suspends until the namespace loads; throws a `LoadError` if it failed.
 */
export function useDeferredTranslation(namespace: DeferredNamespace) {
	const translation = useTranslation([namespace, deferredFallbacks[namespace]], { nsMode: "fallback" });
	for (const failed of failedLoads) {
		if (failed.endsWith(`|${namespace}`)) throw new LoadError(`The ${namespace} texts did not load.`);
	}
	return translation;
}

/** Loads every failed deferred namespace again, for a load boundary's Try again. One that fails again stays failed. */
export async function retryFailedNamespaces(): Promise<void> {
	await Promise.all(
		[...failedLoads].map(async failed => {
			const [language, namespace] = failed.split("|");
			const load = deferred[`./${language}/${namespace}.json`];
			if (!language || !namespace || !load) return;
			try {
				i18n.addResourceBundle(language, namespace, await load(), true, true);
			} catch {
				// Still failed: the boundary shows its failure state again.
			}
		}),
	);
}

export { i18n };
