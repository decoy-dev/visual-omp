/**
 * Translation-ready UI text. Startup namespaces are bundled synchronously; settings, context and
 * projectDetails preload in idle time or load when their screens call useTranslation. Those hooks
 * suspend inside lazyView's boundary until loading settles. Languages match `i18n/<lang>/*.json`.
 */
import i18n, { type BackendModule } from "i18next";
import { initReactI18next } from "react-i18next";
import { preloadWhenIdle } from "../registry/idle";

type Messages = Record<string, unknown>;

const files = import.meta.glob<Messages>(["./*/*.json", "!./*/{settings,context,projectDetails}.json"], { eager: true, import: "default" });
const deferred = import.meta.glob<Messages>("./*/{settings,context,projectDetails}.json", { import: "default" });
const resources: Record<string, Record<string, Messages>> = {};
for (const [path, messages] of Object.entries(files)) {
	const match = /^\.\/([^/]+)\/([^/]+)\.json$/.exec(path);
	if (!match) continue;
	const [, lang, namespace] = match;
	if (!lang || !namespace) continue;
	resources[lang] ??= {};
	resources[lang][namespace] = messages;
}

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

preloadWhenIdle(() => i18n.loadNamespaces(["settings", "context", "projectDetails"]));

export { i18n };
