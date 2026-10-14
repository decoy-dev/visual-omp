import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useCommands } from "@/registry/commands";
import { Cell, EmptyState, HeaderCell, Kbd, PageHeader, SearchInput, Table, TableHead, TableRow } from "@/ui";

/** Splits "⌘⇧R" / "Ctrl+Shift+R" into keycaps. */
function keycaps(shortcut: string): string[] {
	if (shortcut.includes("+") && shortcut.length > 1) return shortcut.split("+").filter(Boolean);
	return [...shortcut];
}

export function ShortcutsSection() {
	const { t } = useTranslation("manage");
	const { t: tAny } = useTranslation();
	const commands = useCommands();
	const [query, setQuery] = useState("");
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const rows = commands
		.filter(command => command.shortcut)
		.map(command => ({ id: command.id, title: tAny(command.title), shortcut: command.shortcut ?? "" }))
		.filter(row => words.every(word => `${row.title} ${row.shortcut}`.toLowerCase().includes(word)))
		.sort((a, b) => a.title.localeCompare(b.title));

	return (
		<>
			<PageHeader title={t("settings.sections.shortcuts")} description={t("shortcuts.description")} />
			<SearchInput value={query} onValueChange={setQuery} placeholder={t("shortcuts.search")} aria-label={t("shortcuts.search")} />
			{rows.length === 0 ? (
				<EmptyState title={t("shortcuts.empty")} />
			) : (
				<Table className="mt-4">
					<caption className="sr-only">{t("shortcuts.caption")}</caption>
					<TableHead>
						<tr>
							<HeaderCell>{t("shortcuts.action")}</HeaderCell>
							<HeaderCell align="right">{t("shortcuts.keys")}</HeaderCell>
						</tr>
					</TableHead>
					<tbody>
						{rows.map(row => (
							<TableRow key={row.id}>
								<Cell>{row.title}</Cell>
								<Cell align="right">
									<span className="sr-only">{row.shortcut}</span>
									<span className="inline-flex gap-1" aria-hidden>
										{keycaps(row.shortcut).map((key, index) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: keycaps may repeat.
											<Kbd key={index}>{key}</Kbd>
										))}
									</span>
								</Cell>
							</TableRow>
						))}
					</tbody>
				</Table>
			)}
		</>
	);
}
