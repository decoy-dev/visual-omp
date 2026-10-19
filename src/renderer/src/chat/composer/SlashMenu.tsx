/**
 * The slash menu: while the message starts with `/` and the caret is in the command name, a listbox
 * above the text box lists the commands omp accepts in this project (builtins, skills, custom,
 * extension, MCP prompt and file commands). After `/name ` it lists that command's subcommands and
 * its argument hint. Same combobox pattern as the `@` picker: focus stays in the text box, arrows
 * move, Tab completes the highlighted entry, Esc closes. Enter completes a partial name and sends
 * once the text already holds a complete command (Composer.tsx); picking never sends by itself.
 */
import type { SlashCommandInfo, SlashCommandSource } from "@shared/contracts/composer";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { slashCommands } from "../../features/session-tools/slash";
import { cn } from "../../ui";
import { menuContent, menuItem, menuItemActive, menuLabel } from "../../ui/styles";

/** Where the caret is in a slash command: in its name, or in the first argument after it. */
export type SlashContext =
	| { kind: "name"; query: string; from: number; to: number }
	| { kind: "args"; name: string; token: string; from: number; to: number };

/** The slash token around the caret, or null when the menu has nothing to offer there. */
export function slashAtCaret(text: string, caret: number): SlashContext | null {
	if (!text.startsWith("/")) return null;
	const before = text.slice(0, caret);
	// `to` covers the rest of the token after the caret, plus one separating space if there is one.
	const tokenEnd = (from: number) => {
		const rest = text.slice(from).search(/\s/);
		const end = rest === -1 ? text.length : from + rest;
		return text[end] === " " ? end + 1 : end;
	};
	const name = /^\/(\S*)$/.exec(before);
	if (name) return { kind: "name", query: name[1] ?? "", from: 0, to: tokenEnd(0) };
	const args = /^\/(\S+)[ \t]+(\S*)$/.exec(before);
	if (!args) return null;
	const token = args[2] ?? "";
	const from = caret - token.length;
	return { kind: "args", name: args[1] ?? "", token, from, to: tokenEnd(from) };
}

export interface SlashItem {
	key: string;
	/** `/name` or the subcommand. */
	label: string;
	/** A subcommand's argument syntax, shown under its name. */
	usage: string | null;
	aliases: string[];
	description: string | null;
	/** Non-builtin commands name where omp got them. */
	source: Exclude<SlashCommandSource, "builtin"> | null;
	/** Text that replaces `[from, to)` of the draft. */
	insert: string;
	/** The draft already holds exactly this item, so Enter sends instead of completing. */
	typed: boolean;
}

export interface SlashOptions {
	items: SlashItem[];
	/** Subcommand stage: the command they belong to and its argument hint. */
	command: SlashCommandInfo | null;
}

/** Name-stage ranking: exact name or alias, name prefix, alias prefix, name contains. */
function rankCommand(command: SlashCommandInfo, query: string): number | null {
	const name = command.name.toLowerCase();
	const aliases = command.aliases.map(alias => alias.toLowerCase());
	if (name === query || aliases.includes(query)) return 0;
	if (name.startsWith(query)) return 1;
	if (aliases.some(alias => alias.startsWith(query))) return 2;
	if (name.includes(query)) return 3;
	return null;
}

export function slashOptions(commands: readonly SlashCommandInfo[], context: SlashContext): SlashOptions {
	if (context.kind === "name") {
		const query = context.query.toLowerCase();
		const ranked = commands.flatMap((command, index) => {
			const rank = rankCommand(command, query);
			return rank === null ? [] : [{ command, rank, index }];
		});
		ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
		return {
			command: null,
			items: ranked.map(({ command }) => ({
				key: `${command.source}:${command.name}`,
				label: `/${command.name}`,
				usage: null,
				aliases: command.aliases.map(alias => `/${alias}`),
				description: command.description,
				source: command.source === "builtin" ? null : command.source,
				insert: `/${command.name} `,
				typed: command.name === context.query || command.aliases.includes(context.query),
			})),
		};
	}
	const command = commands.find(entry => entry.name === context.name || entry.aliases.includes(context.name)) ?? null;
	if (!command) return { command: null, items: [] };
	const token = context.token.toLowerCase();
	return {
		command,
		items: command.subcommands
			.filter(sub => sub.name.toLowerCase().startsWith(token))
			.map(sub => ({
				key: sub.name,
				label: sub.name,
				usage: sub.usage,
				aliases: [],
				description: sub.description,
				source: null,
				insert: `${sub.name} `,
				typed: sub.name === context.token,
			})),
	};
}

/**
 * The project's slash commands, asked for each time the menu opens (`enabled`). null until the first
 * answer; a reopened menu shows the previous list until the new one arrives. When omp can't be asked
 * the list holds only the builtins, and main keeps nothing, so the next open asks again.
 */
export function useSlashCommands(projectPath: string, enabled: boolean): SlashCommandInfo[] | null {
	const [loaded, setLoaded] = useState<{ projectPath: string; commands: SlashCommandInfo[] } | null>(null);
	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		void slashCommands(projectPath)
			.then(listing => listing.commands)
			.catch(() => [])
			.then(commands => {
				if (!cancelled) setLoaded({ projectPath, commands });
			});
		return () => {
			cancelled = true;
		};
	}, [projectPath, enabled]);
	return loaded?.projectPath === projectPath ? loaded.commands : null;
}

interface SlashMenuProps {
	id: string;
	/** null while the command list loads. */
	options: SlashOptions | null;
	active: number;
	onActive(index: number): void;
	onPick(item: SlashItem): void;
}

export function SlashMenu({ id, options, active, onActive, onPick }: SlashMenuProps) {
	const { t } = useTranslation("composer");
	const list = useRef<HTMLUListElement>(null);
	useEffect(() => {
		list.current?.querySelector(`#${CSS.escape(`${id}-${active}`)}`)?.scrollIntoView({ block: "nearest" });
	}, [id, active]);
	const command = options?.command ?? null;
	return (
		<div className={cn(menuContent, "absolute inset-x-2 bottom-full mb-1.5")}>
			<p className={menuLabel}>{command ? t("slash.subcommands", { name: command.name }) : t("slash.header")}</p>
			{options === null ? (
				<p className="px-row py-3 text-sm text-fg-muted">{t("slash.loading")}</p>
			) : options.items.length === 0 && !command ? (
				<p className="px-row py-3 text-sm text-fg-muted">{t("slash.empty")}</p>
			) : (
				options.items.length > 0 && (
					<ul ref={list} id={id} role="listbox" aria-label={t("slash.label")} className="max-h-64 overflow-y-auto">
						{options.items.map((item, index) => (
							<li
								key={item.key}
								id={`${id}-${index}`}
								role="option"
								aria-selected={index === active}
								title={item.description ?? undefined}
								onMouseMove={() => index !== active && onActive(index)}
								onMouseDown={event => {
									// Keep focus (and the caret) in the textarea.
									event.preventDefault();
									onPick(item);
								}}
								className={cn(menuItem, "items-start py-1.5", index === active && menuItemActive)}
							>
								{/* The name column gives way first, so descriptions stay readable at split widths. */}
								<span className="flex min-w-0 max-w-[45%] shrink-0 flex-col">
									<span className="truncate font-mono text-sm text-fg">
										{item.label}
										{item.aliases.length > 0 && (
											<span className="font-sans text-xs text-fg-faint"> {t("slash.aliases", { list: item.aliases.join(", ") })}</span>
										)}
									</span>
									{item.usage && <span className="break-words font-mono text-xs text-fg-faint">{item.usage}</span>}
								</span>
								{item.description && <span className="line-clamp-2 min-w-0 flex-1 text-sm text-fg-muted">{item.description}</span>}
								{item.source && <span className="ml-auto shrink-0 pl-2 text-xs text-fg-faint">{t(`slash.source.${item.source}`)}</span>}
							</li>
						))}
					</ul>
				)
			)}
			{command?.hint && (
				<p className="break-words px-row pb-1.5 pt-1 font-mono text-xs text-fg-faint">{t("slash.usage", { name: command.name, hint: command.hint })}</p>
			)}
		</div>
	);
}
