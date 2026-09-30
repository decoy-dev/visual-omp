/**
 * Prompt library: the user's saved prompts (kept on this computer), the project's custom slash
 * commands (`.omp/commands`, `.claude/commands`, `~/.omp/agent/commands`) and omp's skills. Picking an
 * entry puts it into the composer — saved prompts as text, commands as `/name `, skills as
 * `/skill:name ` — without sending.
 */
import { BookBookmark, Command, GraduationCap, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { CustomCommand } from "@shared/contracts/composer";
import type { SkillEntry } from "@shared/contracts/skills";
import {
	Button,
	duration,
	ease,
	Dialog,
	DialogContent,
	EmptyState,
	IconButton,
	Input,
	SearchInput,
	Skeleton,
	spring,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
	Textarea,
} from "../../ui";

export type LibraryTab = "saved" | "commands" | "skills";

export interface SavedPrompt {
	id: string;
	title: string;
	text: string;
}

interface PromptState {
	prompts: SavedPrompt[];
	save(prompt: Omit<SavedPrompt, "id"> & { id?: string }): void;
	remove(id: string): void;
}

export const useSavedPrompts = create<PromptState>()(
	persist(
		set => ({
			prompts: [],
			save({ id, title, text }) {
				set(state =>
					id && state.prompts.some(prompt => prompt.id === id)
						? { prompts: state.prompts.map(prompt => (prompt.id === id ? { id, title, text } : prompt)) }
						: { prompts: [{ id: id ?? crypto.randomUUID(), title, text }, ...state.prompts] },
				);
			},
			remove(id) {
				set(state => ({ prompts: state.prompts.filter(prompt => prompt.id !== id) }));
			},
		}),
		{ name: "vomp.composer.prompts", storage: createJSONStorage(() => localStorage) },
	),
);

interface PromptLibraryProps {
	open: boolean;
	tab: LibraryTab;
	projectPath: string;
	/** Current composer text, offered as "Save current message". */
	draft: string;
	onTabChange(tab: LibraryTab): void;
	onClose(): void;
	/** Put `text` into the composer (replacing the draft when `replace`). */
	onPick(text: string, replace: boolean): void;
}

function matches(query: string, ...fields: Array<string | null>): boolean {
	const needle = query.trim().toLowerCase();
	return !needle || fields.some(field => field?.toLowerCase().includes(needle));
}

/** Arrow keys move between rows of a list (roving focus over its buttons). */
function onListKey(event: KeyboardEvent<HTMLUListElement>) {
	if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
	const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-row]")];
	const index = rows.indexOf(document.activeElement as HTMLElement);
	const next = rows[event.key === "ArrowDown" ? Math.min(rows.length - 1, index + 1) : Math.max(0, index - 1)];
	if (next) {
		event.preventDefault();
		next.focus();
	}
}

/** One pickable entry. Rows enter, leave and reflow as the filter or the saved list changes. */
function Row({ title, detail, onPick, actions }: { title: ReactNode; detail: ReactNode; onPick(): void; actions?: ReactNode }) {
	return (
		<motion.li
			layout="position"
			initial={{ opacity: 0, y: 4 }}
			animate={{ opacity: 1, y: 0 }}
			exit={{ opacity: 0, transition: { duration: duration.fast, ease: "easeIn" } }}
			transition={{ layout: spring.gentle, y: spring.gentle, opacity: { duration: duration.base, ease: ease.outQuart } }}
			className="group flex items-center gap-1 rounded-md pr-1 transition-colors duration-(--dur-fast) hover:bg-hover focus-within:bg-hover"
		>
			<button
				type="button"
				data-row
				onClick={onPick}
				className="flex min-w-0 flex-1 flex-col rounded-md px-2.5 py-2 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
			>
				<span className="truncate text-md font-medium text-fg">{title}</span>
				<span className="line-clamp-2 text-sm text-fg-muted">{detail}</span>
			</button>
			{actions}
		</motion.li>
	);
}

function SavedTab({ query, draft, onPick }: { query: string; draft: string; onPick(text: string, replace: boolean): void }) {
	const { t } = useTranslation("composer");
	const { prompts, save, remove } = useSavedPrompts();
	const [editing, setEditing] = useState<{ id?: string; title: string; text: string } | null>(null);
	const visible = prompts.filter(prompt => matches(query, prompt.title, prompt.text));

	if (editing) {
		const valid = editing.title.trim() && editing.text.trim();
		return (
			<form
				className="flex flex-col gap-3 pt-3"
				onSubmit={event => {
					event.preventDefault();
					if (!valid) return;
					save({ id: editing.id, title: editing.title.trim(), text: editing.text.trim() });
					setEditing(null);
				}}
			>
				<Input
					label={t("library.titleLabel")}
					value={editing.title}
					// biome-ignore lint/a11y/noAutofocus: the form opens on explicit user action.
					autoFocus
					onChange={event => setEditing({ ...editing, title: event.target.value })}
				/>
				<Textarea
					label={t("library.textLabel")}
					value={editing.text}
					minRows={4}
					maxRows={12}
					onChange={event => setEditing({ ...editing, text: event.target.value })}
				/>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={() => setEditing(null)}>
						{t("library.cancel")}
					</Button>
					<Button variant="primary" type="submit" disabled={!valid}>
						{t("library.save")}
					</Button>
				</div>
			</form>
		);
	}

	return (
		<div className="flex flex-col gap-2 pt-3">
			<div className="flex gap-2">
				<Button size="sm" icon={<Plus />} onClick={() => setEditing({ title: "", text: "" })}>
					{t("library.new")}
				</Button>
				{draft.trim() && (
					<Button size="sm" variant="ghost" onClick={() => setEditing({ title: draft.trim().slice(0, 48), text: draft.trim() })}>
						{t("library.saveDraft")}
					</Button>
				)}
			</div>
			{visible.length === 0 ? (
				<EmptyState
					icon={<BookBookmark />}
					title={prompts.length === 0 ? t("library.savedEmptyTitle") : t("library.noMatch")}
					body={prompts.length === 0 ? t("library.savedEmptyBody") : undefined}
				/>
			) : (
				<ul className="flex flex-col" onKeyDown={onListKey}>
					<AnimatePresence initial={false}>
						{visible.map(prompt => (
							<Row
								key={prompt.id}
								title={prompt.title}
								detail={prompt.text}
								onPick={() => onPick(prompt.text, true)}
								actions={
									<span className="flex opacity-0 transition-opacity duration-(--dur-fast) group-hover:opacity-100 group-focus-within:opacity-100">
										<IconButton size="sm" label={t("library.edit")} icon={<PencilSimple />} onClick={() => setEditing(prompt)} />
										<IconButton
											size="sm"
											variant="danger-ghost"
											label={t("library.delete")}
											icon={<Trash />}
											onClick={() => remove(prompt.id)}
										/>
									</span>
								}
							/>
						))}
					</AnimatePresence>
				</ul>
			)}
		</div>
	);
}

function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): { data: T | null; error: string | null } {
	const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
	// biome-ignore lint/correctness/useExhaustiveDependencies: callers pass the inputs of `load` as deps.
	useEffect(() => {
		let cancelled = false;
		setState({ data: null, error: null });
		load().then(
			data => !cancelled && setState({ data, error: null }),
			(error: unknown) => !cancelled && setState({ data: null, error: error instanceof Error ? error.message : String(error) }),
		);
		return () => {
			cancelled = true;
		};
	}, deps);
	return state;
}

function LoadingRows() {
	return (
		<div className="flex flex-col gap-2 pt-3">
			<Skeleton height={40} />
			<Skeleton height={40} />
			<Skeleton height={40} />
		</div>
	);
}

function CommandsTab({ query, projectPath, onPick }: { query: string; projectPath: string; onPick(text: string, replace: boolean): void }) {
	const { t } = useTranslation("composer");
	const { data, error } = useLoad(() => window.vomp.invoke("composer:commands", projectPath), [projectPath]);
	if (error) return <EmptyState icon={<Command />} title={t("library.loadFailed")} body={error} />;
	if (!data) return <LoadingRows />;
	const visible = data.filter((command: CustomCommand) => matches(query, command.name, command.description));
	if (visible.length === 0) {
		return (
			<EmptyState
				icon={<Command />}
				title={data.length === 0 ? t("library.commandsEmptyTitle") : t("library.noMatch")}
				body={data.length === 0 ? t("library.commandsEmptyBody") : undefined}
			/>
		);
	}
	return (
		<ul className="flex flex-col pt-3" onKeyDown={onListKey}>
			<AnimatePresence initial={false}>
				{visible.map(command => (
					<Row
						key={command.filePath}
						title={
							<>
								<span className="font-mono">/{command.name}</span>
								{command.argumentHint && <span className="ml-2 font-mono text-sm text-fg-faint">{command.argumentHint}</span>}
							</>
						}
						detail={`${command.description || t("library.noDescription")} · ${t(`library.scope.${command.scope}`)}`}
						onPick={() => onPick(`/${command.name} `, false)}
					/>
				))}
			</AnimatePresence>
		</ul>
	);
}

function SkillsTab({ query, projectPath, onPick }: { query: string; projectPath: string; onPick(text: string, replace: boolean): void }) {
	const { t } = useTranslation("composer");
	const { data, error } = useLoad(() => window.vomp.invoke("skills:list", projectPath), [projectPath]);
	if (error) return <EmptyState icon={<GraduationCap />} title={t("library.loadFailed")} body={error} />;
	if (!data) return <LoadingRows />;
	const loaded = data.skills.filter((skill: SkillEntry) => skill.enabled);
	const visible = loaded.filter(skill => matches(query, skill.name, skill.description));
	if (visible.length === 0) {
		return (
			<EmptyState
				icon={<GraduationCap />}
				title={loaded.length === 0 ? t("library.skillsEmptyTitle") : t("library.noMatch")}
				body={loaded.length === 0 ? t("library.skillsEmptyBody") : undefined}
			/>
		);
	}
	return (
		<ul className="flex flex-col pt-3" onKeyDown={onListKey}>
			<AnimatePresence initial={false}>
				{visible.map(skill => (
					<Row
						key={skill.filePath}
						title={skill.name}
						detail={skill.description || t("library.noDescription")}
						onPick={() => onPick(`/skill:${skill.name} `, false)}
					/>
				))}
			</AnimatePresence>
		</ul>
	);
}

export function PromptLibrary({ open, tab, projectPath, draft, onTabChange, onClose, onPick }: PromptLibraryProps) {
	const { t } = useTranslation("composer");
	const [query, setQuery] = useState("");
	const pick = (text: string, replace: boolean) => {
		onPick(text, replace);
		onClose();
	};
	return (
		<Dialog open={open} onOpenChange={next => !next && onClose()}>
			<DialogContent size="lg" title={t("library.title")} description={t("library.description")}>
				<Tabs value={tab} onValueChange={value => onTabChange(value === "commands" || value === "skills" ? value : "saved")}>
					<div className="flex items-center gap-3">
						<TabsList className="flex-1">
							<TabsTrigger value="saved" icon={<BookBookmark />}>
								{t("library.tabs.saved")}
							</TabsTrigger>
							<TabsTrigger value="commands" icon={<Command />}>
								{t("library.tabs.commands")}
							</TabsTrigger>
							<TabsTrigger value="skills" icon={<GraduationCap />}>
								{t("library.tabs.skills")}
							</TabsTrigger>
						</TabsList>
						<SearchInput size="sm" className="w-44" value={query} onValueChange={setQuery} placeholder={t("library.search")} />
					</div>
					<div className="h-[360px] overflow-y-auto">
						<TabsContent value="saved">
							<SavedTab query={query} draft={draft} onPick={pick} />
						</TabsContent>
						<TabsContent value="commands">
							<CommandsTab query={query} projectPath={projectPath} onPick={pick} />
						</TabsContent>
						<TabsContent value="skills">
							<SkillsTab query={query} projectPath={projectPath} onPick={pick} />
						</TabsContent>
					</div>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}
