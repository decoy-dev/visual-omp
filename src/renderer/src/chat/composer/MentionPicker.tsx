/**
 * The `@` file picker: a listbox above the composer's text box, driven from the textarea (combobox
 * pattern — focus never leaves the text; arrows move, Enter/Tab picks, Esc closes).
 */
import { FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../ui";
import type { FuzzyMatch } from "./fuzzy";

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; files: Promise<string[]> }>();

/** Project files for mentions (git-aware listing from main), cached briefly per project. */
export function useProjectFiles(projectPath: string, enabled: boolean): string[] | null {
	const [files, setFiles] = useState<string[] | null>(null);
	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		let entry = cache.get(projectPath);
		if (!entry || Date.now() - entry.at > CACHE_MS) {
			entry = { at: Date.now(), files: window.vomp.invoke("fs:files", projectPath).catch(() => []) };
			cache.set(projectPath, entry);
		}
		void entry.files.then(list => {
			if (!cancelled) setFiles(list);
		});
		return () => {
			cancelled = true;
		};
	}, [projectPath, enabled]);
	return files;
}

function Highlighted({ match }: { match: FuzzyMatch }) {
	const slash = match.path.lastIndexOf("/");
	const hits = new Set(match.positions);
	const render = (from: number, to: number) =>
		[...match.path.slice(from, to)].map((char, offset) => {
			const index = from + offset;
			return hits.has(index) ? (
				<mark key={index} className="bg-transparent font-semibold text-accent-2">
					{char}
				</mark>
			) : (
				char
			);
		});
	return (
		<>
			<span className="truncate text-fg">{render(slash + 1, match.path.length)}</span>
			{slash > 0 && <span className="min-w-0 truncate text-sm text-fg-faint">{render(0, slash)}</span>}
		</>
	);
}

interface MentionPickerProps {
	id: string;
	matches: FuzzyMatch[] | null;
	active: number;
	onActive(index: number): void;
	onPick(path: string): void;
}

export function MentionPicker({ id, matches, active, onActive, onPick }: MentionPickerProps) {
	const { t } = useTranslation("composer");
	const list = useRef<HTMLUListElement>(null);
	useEffect(() => {
		list.current?.querySelector(`#${CSS.escape(`${id}-${active}`)}`)?.scrollIntoView({ block: "nearest" });
	}, [id, active]);
	return (
		<div className="vo-pop absolute inset-x-2 bottom-full z-10 mb-2 overflow-hidden rounded-lg border border-border bg-raised shadow-(--shadow-pop)">
			<p className="border-b border-border px-3 py-1.5 text-xs text-fg-faint">{t("mention.header")}</p>
			{matches === null ? (
				<p className="px-3 py-3 text-sm text-fg-muted">{t("mention.loading")}</p>
			) : matches.length === 0 ? (
				<p className="px-3 py-3 text-sm text-fg-muted">{t("mention.empty")}</p>
			) : (
				<ul ref={list} id={id} role="listbox" aria-label={t("mention.label")} className="max-h-64 overflow-y-auto p-1">
					{matches.map((match, index) => (
						<li
							key={match.path}
							id={`${id}-${index}`}
							role="option"
							aria-selected={index === active}
							onMouseMove={() => index !== active && onActive(index)}
							onMouseDown={event => {
								// Keep focus (and the caret) in the textarea.
								event.preventDefault();
								onPick(match.path);
							}}
							className={cn(
								"flex h-8 cursor-default items-center gap-2 rounded-sm px-2 text-md",
								index === active && "bg-selected",
							)}
						>
							<FileText className="size-4 shrink-0 text-fg-faint" aria-hidden />
							<Highlighted match={match} />
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
