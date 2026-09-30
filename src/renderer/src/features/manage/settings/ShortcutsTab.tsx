import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useCommands } from "@/registry/commands";
import { EmptyState, Kbd, SearchInput } from "@/ui";

/** Splits "⌘⇧R" / "Ctrl+Shift+R" into keycaps. */
function keycaps(shortcut: string): string[] {
	if (shortcut.includes("+") && shortcut.length > 1) return shortcut.split("+").filter(Boolean);
	return [...shortcut];
}

export function ShortcutsTab() {
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
		<div>
			<p className="text-md text-fg-muted">{t("shortcuts.description")}</p>
			<SearchInput
				className="mt-4"
				value={query}
				onValueChange={setQuery}
				placeholder={t("shortcuts.search")}
				aria-label={t("shortcuts.search")}
			/>
			{rows.length === 0 ? (
				<EmptyState title={t("shortcuts.empty")} />
			) : (
				<table className="mt-4 w-full text-md">
					<caption className="sr-only">{t("shortcuts.caption")}</caption>
					<thead>
						<tr className="text-left text-xs text-fg-faint">
							<th scope="col" className="pb-2 font-medium">
								{t("shortcuts.action")}
							</th>
							<th scope="col" className="pb-2 text-right font-medium">
								{t("shortcuts.keys")}
							</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-border border-y border-border">
						{rows.map(row => (
							<tr key={row.id}>
								<td className="py-2 text-fg">{row.title}</td>
								<td className="py-2 text-right">
									<span className="sr-only">{row.shortcut}</span>
									<span className="inline-flex gap-1" aria-hidden>
										{keycaps(row.shortcut).map((key, index) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: keycaps may repeat.
											<Kbd key={index}>{key}</Kbd>
										))}
									</span>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	);
}
