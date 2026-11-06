import type { ComposerAssist, ComposerAssistRequest, ComposerKeyword, ComposerModelItem } from "@shared/contracts/composer";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../ui";
import { menuContent, menuItem, menuItemActive, menuLabel } from "../../ui/styles";
import { mentionRanges } from "./fuzzy";

/** Same whitespace-delimited trigger as omp's model-mention autocomplete. */
export function modelTagAtCaret(text: string, caret: number): { start: number; query: string } | null {
	if (caret < 0) return null;
	const token = /(?:^|\s)(\^[^\s]*)$/.exec(text.slice(0, caret))?.[1];
	return token ? { start: caret - token.length, query: token.slice(1) } : null;
}

const EMPTY: ComposerAssist = { items: null, keywords: [] };

/** Keep each read scoped independently and cancel even dispatched bridge work on cleanup. */
function useAssistQuery(hostId: string | null, generation: number, key: string, request: ComposerAssistRequest | null) {
	const [loaded, setLoaded] = useState<{ key: string; result: ComposerAssist } | null>(null);
	useEffect(() => {
		if (!hostId || !request) return;
		let current = true;
		let dispatched = false;
		const id = crypto.randomUUID();
		const timer = setTimeout(() => {
			dispatched = true;
			void window.vomp.invoke("composer:assist", hostId, generation, { ...request, id }).then(result => {
				if (current) setLoaded({ key, result });
			}).catch(() => { if (current) setLoaded({ key, result: EMPTY }); });
		}, 100);
		return () => {
			current = false;
			clearTimeout(timer);
			if (dispatched) void window.vomp.invoke("composer:cancelAssist", hostId, generation, id).catch(() => {});
		};
		// The key contains every request field. New object identity must not restart a caret-independent read.
	}, [hostId, generation, key]);
	return loaded?.key === key ? loaded.result : null;
}

/** Decorations depend on text and settings; only model completion depends on the caret. */
export function useComposerAssist(hostId: string | null, generation: number, text: string, cursor: number, complete: boolean, enabled: boolean) {
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		if (!hostId || !enabled) return;
		return window.vomp.on("config:changed", () => setRevision(value => value + 1));
	}, [hostId, enabled]);
	const decorationKey = JSON.stringify([hostId, generation, text, enabled, revision]);
	const completionKey = JSON.stringify([decorationKey, cursor, complete]);
	const readable = !!hostId && enabled && !!text;
	const decorations = useAssistQuery(hostId, generation, decorationKey, readable ? { text, cursor: 0, complete: false, keywords: true } : null);
	const completion = useAssistQuery(hostId, generation, completionKey, readable && complete ? { text, cursor, complete: true, keywords: false } : null);
	return { keywords: decorations?.keywords ?? EMPTY.keywords, items: completion?.items ?? null, pending: readable && complete && completion === null };
}

/** Preserve text metrics while marking enabled prose with the existing teal token. */
export function ComposerMirror({ text, keywords }: { text: string; keywords: ComposerKeyword[] }): ReactNode {
	const parts: ReactNode[] = [];
	const ranges = [
		...mentionRanges(text).map(range => ({ ...range, keyword: null as ComposerKeyword | null })),
		...keywords.map(keyword => ({ ...keyword, keyword })),
	].sort((a, b) => a.start - b.start || b.end - a.end);
	let at = 0;
	for (const { start, end, keyword } of ranges) {
		if (start < at || end > text.length) continue;
		if (start > at) parts.push(text.slice(at, start));
		const word = text.slice(start, end);
		parts.push(keyword ? <span key={start} data-composer-keyword={start} className="text-accent">{word}</span>
			: <span key={start} className="rounded-sm bg-accent-muted text-accent shadow-[0_0_0_2px_var(--accent-muted)]">{word}</span>);
		at = end;
	}
	parts.push(text.slice(at));
	return <>{parts}{text.endsWith("\n") ? " " : null}</>;
}

/** Read mirror glyph rectangles rather than adding pointer targets above the editable text. */
export function keywordAtPoint(mirror: HTMLElement | null, keywords: ComposerKeyword[], x: number, y: number): ComposerKeyword | null {
	for (const node of mirror?.querySelectorAll<HTMLElement>("[data-composer-keyword]") ?? []) {
		const range = document.createRange();
		range.selectNodeContents(node);
		if ([...range.getClientRects()].some(rect => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)) {
			return keywords.find(keyword => keyword.start === Number(node.dataset.composerKeyword)) ?? null;
		}
	}
	return null;
}

export function ModelTagMenu({ id, items, active, onActive, onPick }: {
	id: string; items: ComposerModelItem[] | null; active: number; onActive(index: number): void; onPick(item: ComposerModelItem): void;
}) {
	const { t } = useTranslation("composer");
	useEffect(() => { document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" }); }, [id, active]);
	return <div className={cn(menuContent, "absolute inset-x-2 bottom-full mb-1.5")}>
		<p className={menuLabel}>{t("modelTags.header")}</p>
		{items === null ? <p className="px-row py-3 text-sm text-fg-muted">{t("modelTags.loading")}</p>
			: items.length === 0 ? <p className="px-row py-3 text-sm text-fg-muted">{t("modelTags.empty")}</p>
			: <ul id={id} role="listbox" aria-label={t("modelTags.label")} className="max-h-64 overflow-y-auto">
				{items.map((item, index) => <li key={item.value} id={`${id}-${index}`} role="option" aria-selected={index === active}
					onMouseMove={() => index !== active && onActive(index)}
					onMouseDown={event => { event.preventDefault(); onPick(item); }}
					className={cn(menuItem, "flex-col items-start gap-0.5 py-1.5", index === active && menuItemActive)}>
					<span className="w-full break-all font-mono text-sm text-fg">^{item.value}</span>
					{item.description && <span className="text-sm text-fg-muted">{item.description}</span>}
				</li>)}
			</ul>}
	</div>;
}
