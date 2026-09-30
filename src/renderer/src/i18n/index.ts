/**
 * Translation-ready UI text. Every feature owns a namespace file `i18n/en/<namespace>.json` and
 * reads it with `useTranslation("<namespace>")`; files are discovered automatically. Adding a
 * language = adding `i18n/<lang>/*.json` with the same keys.
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

type Messages = Record<string, unknown>;

const files = import.meta.glob<Messages>("./*/*.json", { eager: true, import: "default" });
const resources: Record<string, Record<string, Messages>> = {};
for (const [path, messages] of Object.entries(files)) {
	const match = /^\.\/([^/]+)\/([^/]+)\.json$/.exec(path);
	if (!match) continue;
	const [, lang, namespace] = match;
	if (!lang || !namespace) continue;
	resources[lang] ??= {};
	resources[lang][namespace] = messages;
}

void i18n.use(initReactI18next).init({
	lng: "en",
	fallbackLng: "en",
	resources,
	ns: Object.keys(resources.en ?? {}),
	defaultNS: "common",
	interpolation: { escapeValue: false },
	returnNull: false,
});

export { i18n };
