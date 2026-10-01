import { ChatCenteredText, DotsThree } from "@phosphor-icons/react";
import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { type CommandSpec, useCommands } from "../registry/commands";
import { chatSlots } from "../registry/slots";
import { chatTitle } from "../shell/hooks";
import { useApp } from "../state/app";
import type { SessionController, SessionView } from "../state/session";
import {
	Button,
	IconButton,
	Menu,
	MenuContent,
	MenuItem,
	MenuLabel,
	MenuRadioGroup,
	MenuRadioItem,
	MenuSeparator,
	MenuTrigger,
	PresenceSwap,
	Tooltip,
} from "../ui";
import type { TranscriptMode } from "./transcript/Transcript";

const MAX_HEADER_BUTTONS = 5;
const OVERFLOW_GROUPS: ReadonlySet<CommandSpec["group"]> = new Set(["chat", "modes"]);
const TRANSCRIPT_MODES: readonly TranscriptMode[] = ["normal", "thinking", "verbose"];

/**
 * 48px chat header (DESIGN §3.4): title, chips from features, up to 5 command buttons, overflow ⋯. The header
 * is a size container, so a narrow chat (an open dock, a split) shows the buttons as icons with tooltips.
 */
export function SessionHeader({ session, view, fallbackTitle }: { session: SessionController; view: SessionView; fallbackTitle: string | null }): ReactNode {
	const { t } = useTranslation(["chat", "shell"]);
	const commands = useCommands();
	const chips = chatSlots.use().filter(slot => slot.placement === "headerChips");
	const transcriptMode = useApp(state => state.prefs?.transcriptMode ?? "normal");
	const ctx = { session, projectPath: session.projectPath };
	const available = commands.filter(command => command.when?.(ctx) ?? true);
	const buttons = available
		.filter(command => command.header !== undefined)
		.sort((a, b) => (a.header ?? 0) - (b.header ?? 0))
		.slice(0, MAX_HEADER_BUTTONS);
	const shown = new Set(buttons.map(command => command.id));
	const overflow = available.filter(command => OVERFLOW_GROUPS.has(command.group) && !shown.has(command.id));
	const title = chatTitle(view, fallbackTitle) ?? t("shell:tabs.newChatTitle");

	return (
		<div className="@container/header flex h-(--header-h) shrink-0 items-center gap-3 border-b border-border bg-panel px-4">
			<ChatCenteredText className="size-4 shrink-0 text-fg-muted" aria-hidden />
			<PresenceSwap swapKey={title} variant="rise" className="min-w-0">
				<h1 className="truncate text-[15px] font-semibold text-fg" title={title}>
					{title}
				</h1>
			</PresenceSwap>
			<div className="flex shrink-0 items-center gap-1.5">
				{chips.map(chip => (
					<chip.component key={chip.id} session={session} />
				))}
			</div>
			<div className="flex-1" />
			<div className="flex items-center gap-0.5">
				{buttons.map(command => {
					const Icon = command.icon;
					const label = t(command.title);
					const run = () => void command.run(ctx);
					const labelled = (
						<Tooltip content={t(command.hint ?? command.title)} shortcut={command.shortcut}>
							<Button variant="ghost" size="sm" icon={Icon ? <Icon /> : undefined} onClick={run}>
								{label}
							</Button>
						</Tooltip>
					);
					if (!Icon) return <Fragment key={command.id}>{labelled}</Fragment>;
					// The wrappers own the display switch, so the buttons' own display classes cannot override it.
					return (
						<Fragment key={command.id}>
							<span className="hidden @min-[66rem]/header:contents">{labelled}</span>
							<span className="contents @min-[66rem]/header:hidden">
								<IconButton label={label} shortcut={command.shortcut} icon={<Icon />} size="md" onClick={run} />
							</span>
						</Fragment>
					);
				})}
				<Menu>
					<MenuTrigger asChild>
						<IconButton label={t("chat:header.more")} icon={<DotsThree weight="bold" />} size="md" />
					</MenuTrigger>
					<MenuContent align="end" className="max-h-[70vh] min-w-[240px] overflow-y-auto">
						<MenuLabel>{t("chat:header.view")}</MenuLabel>
						<MenuRadioGroup
							value={transcriptMode}
							onValueChange={value => {
								const mode = TRANSCRIPT_MODES.find(entry => entry === value);
								if (mode) void useApp.getState().setPrefs({ transcriptMode: mode });
							}}
						>
							{TRANSCRIPT_MODES.map(mode => (
								<MenuRadioItem key={mode} value={mode} shortcut={mode === "normal" ? "⌘O" : undefined}>
									{t(`chat:header.views.${mode}`)}
								</MenuRadioItem>
							))}
						</MenuRadioGroup>
						{overflow.length > 0 && <MenuSeparator />}
						{overflow.map(command => {
							const Icon = command.icon;
							return (
								<MenuItem key={command.id} icon={Icon ? <Icon /> : undefined} shortcut={command.shortcut} danger={command.danger} onSelect={() => void command.run(ctx)}>
									{t(command.title)}
								</MenuItem>
							);
						})}
					</MenuContent>
				</Menu>
			</div>
		</div>
	);
}
