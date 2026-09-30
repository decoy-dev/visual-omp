/**
 * Project instructions editor: the context file omp reads when a chat starts in this folder
 * (AGENTS.md, CLAUDE.md, …) with a markdown preview, plus the project's rules (`.omp/rules`).
 */
import type { InstructionFile, ProjectInstructions, ProjectRule, RuleDraft } from "@shared/contracts/project";
import { Info, PencilSimple, Plus, Trash, WarningCircle } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SheetProps } from "@/registry/slots";
import { useApp } from "@/state/app";
import { Markdown } from "@/transcript/Markdown";
import {
	Button,
	Chip,
	Dialog,
	DialogContent,
	EmptyState,
	IconButton,
	Input,
	PresenceSwap,
	Segmented,
	Select,
	SelectItem,
	SheetContent,
	Sheet,
	Skeleton,
	spring,
	Switch,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
	Textarea,
	toast,
} from "@/ui";
import { errorText } from "./actions";
import { folderName, formatBytes } from "./format";

export interface InstructionsSheetProps {
	projectPath?: string | null;
	tab?: "instructions" | "rules";
}

type Mode = "write" | "preview";

export function InstructionsSheet({ props, close }: SheetProps<InstructionsSheetProps | undefined>): ReactNode {
	const { t } = useTranslation("projects");
	const active = useApp(state => state.activeProject);
	const projectPath = props?.projectPath ?? active;
	const [tab, setTab] = useState<string>(props?.tab ?? "instructions");
	const [dirty, setDirty] = useState(false);
	const [confirmClose, setConfirmClose] = useState(false);
	const requestClose = () => (dirty ? setConfirmClose(true) : close());

	return (
		<Sheet open onOpenChange={open => !open && requestClose()}>
			<SheetContent
				width={760}
				title={t("instructions.title")}
				description={projectPath ? t("instructions.subtitle", { name: folderName(projectPath) }) : undefined}
				bodyClassName="flex flex-col p-0"
			>
				{!projectPath ? (
					<EmptyState title={t("instructions.noProject")} />
				) : (
					<Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
						<TabsList className="px-4">
							<TabsTrigger value="instructions">{t("instructions.tabInstructions")}</TabsTrigger>
							<TabsTrigger value="rules">{t("instructions.tabRules")}</TabsTrigger>
						</TabsList>
						<TabsContent value="instructions" className="flex min-h-0 flex-1 flex-col">
							<InstructionsEditor projectPath={projectPath} onDirty={setDirty} />
						</TabsContent>
						<TabsContent value="rules" className="min-h-0 flex-1 overflow-y-auto">
							<RulesPanel projectPath={projectPath} />
						</TabsContent>
					</Tabs>
				)}
			</SheetContent>
			<Dialog open={confirmClose} onOpenChange={setConfirmClose}>
				<DialogContent
					size="sm"
					destructive
					title={t("instructions.discard.title")}
					description={t("instructions.discard.body")}
					footer={
						<>
							<Button onClick={() => setConfirmClose(false)}>{t("instructions.discard.keep")}</Button>
							<Button variant="danger" onClick={close}>
								{t("instructions.discard.confirm")}
							</Button>
						</>
					}
				/>
			</Dialog>
		</Sheet>
	);
}

function InstructionsEditor({ projectPath, onDirty }: { projectPath: string; onDirty(dirty: boolean): void }): ReactNode {
	const { t } = useTranslation("projects");
	const [data, setData] = useState<ProjectInstructions | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [relPath, setRelPath] = useState<string | null>(null);
	const [text, setText] = useState("");
	const [saved, setSaved] = useState("");
	const [mode, setMode] = useState<Mode>("write");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		let live = true;
		window.vomp.invoke("project:instructions", projectPath).then(
			next => {
				if (!live) return;
				setData(next);
				const file = next.files.find(entry => entry.relPath === next.primaryRelPath);
				setRelPath(next.primaryRelPath);
				setText(file?.content ?? "");
				setSaved(file?.content ?? "");
			},
			failure => live && setError(errorText(failure)),
		);
		return () => {
			live = false;
		};
	}, [projectPath]);

	const dirty = text !== saved;
	useEffect(() => onDirty(dirty), [dirty, onDirty]);

	if (error) return <p className="m-4 text-sm text-err">{error}</p>;
	if (!data || relPath === null) {
		return (
			<div className="flex flex-col gap-3 p-4" aria-busy>
				<Skeleton height={32} />
				<Skeleton height={240} />
			</div>
		);
	}

	const file = data.files.find(entry => entry.relPath === relPath) ?? null;
	const activeFile = data.files.find(entry => entry.relPath === data.activeRelPath) ?? null;
	const contextFiles = data.files.filter(entry => entry.kind === "context");
	const sticky = data.files.filter(entry => entry.kind === "sticky");

	const choose = (next: string) => {
		const entry = data.files.find(candidate => candidate.relPath === next);
		setRelPath(next);
		setText(entry?.content ?? "");
		setSaved(entry?.content ?? "");
	};

	const save = async () => {
		setSaving(true);
		try {
			const next = await window.vomp.invoke("project:instructions:write", projectPath, relPath, text);
			setData(next);
			setSaved(text);
			toast({ tone: "ok", message: t("instructions.saved"), description: t("instructions.appliesNext") });
		} catch (failure) {
			toast({ tone: "err", message: t("instructions.saveFailed"), description: errorText(failure) });
		} finally {
			setSaving(false);
		}
	};

	const option = (entry: InstructionFile) => (
		<SelectItem key={entry.relPath} value={entry.relPath} hint={entry.active ? t("instructions.inUse") : entry.exists ? undefined : t("instructions.new")}>
			{entry.relPath}
		</SelectItem>
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
			<div className="flex flex-wrap items-center gap-2">
				<Select value={relPath} onValueChange={choose} aria-label={t("instructions.file")} className="w-64">
					{contextFiles.map(option)}
					{sticky.map(option)}
				</Select>
				{file?.exists && <span className="text-sm text-fg-faint">{formatBytes(new TextEncoder().encode(saved).length)}</span>}
				<Segmented<Mode>
					className="ml-auto"
					aria-label={t("instructions.view")}
					value={mode}
					onValueChange={setMode}
					options={[
						{ value: "write", label: t("instructions.write") },
						{ value: "preview", label: t("instructions.preview") },
					]}
				/>
			</div>

			<PresenceSwap swapKey={file?.kind === "sticky" ? "sticky" : activeFile && activeFile.relPath !== relPath ? "shadowed" : "explainer"}>
			{file?.kind === "sticky" ? (
				<Notice icon={<Info />}>{t("instructions.stickyNote")}</Notice>
			) : activeFile && activeFile.relPath !== relPath ? (
				<Notice icon={<WarningCircle />} tone="warn">
					{t("instructions.shadowed", { active: activeFile.relPath })}
				</Notice>
			) : (
				<Notice icon={<Info />}>{t("instructions.explainer")}</Notice>
			)}
			</PresenceSwap>

			<PresenceSwap swapKey={mode} className="flex min-h-0 flex-1 flex-col">
			{mode === "write" ? (
				<textarea
					aria-label={t("instructions.editorLabel", { file: relPath })}
					value={text}
					onChange={event => setText(event.currentTarget.value)}
					onKeyDown={event => {
						if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							if (dirty) void save();
						}
					}}
					spellCheck
					placeholder={t("instructions.placeholder")}
					className="min-h-0 flex-1 resize-none rounded-md border border-border-strong bg-panel p-3 font-mono text-sm leading-6 text-fg outline-none placeholder:text-fg-faint focus:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
				/>
			) : (
				<div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-panel p-4" tabIndex={0} aria-label={t("instructions.preview")}>
					{text.trim() ? <Markdown text={text} /> : <p className="text-md text-fg-muted">{t("instructions.previewEmpty")}</p>}
				</div>
			)}
			</PresenceSwap>

			<div className="flex items-center gap-2">
				<span className="flex-1 text-sm text-fg-muted">{dirty ? t("instructions.unsaved") : t("instructions.appliesNext")}</span>
				<Button variant="secondary" disabled={!dirty || saving} onClick={() => setText(saved)}>
					{t("instructions.revert")}
				</Button>
				<Button variant="primary" disabled={!dirty} loading={saving} onClick={() => void save()}>
					{t("instructions.save")}
				</Button>
			</div>
		</div>
	);
}

function Notice({ icon, tone, children }: { icon: ReactNode; tone?: "warn"; children: ReactNode }): ReactNode {
	return (
		<p className={`flex items-start gap-2 rounded-md px-3 py-2 text-sm ${tone === "warn" ? "bg-warn-bg text-fg" : "bg-inset text-fg-muted"}`}>
			<span className={`mt-px inline-flex shrink-0 [&>svg]:size-4 ${tone === "warn" ? "text-warn" : "text-fg-faint"}`} aria-hidden>
				{icon}
			</span>
			<span>{children}</span>
		</p>
	);
}

interface RuleForm {
	/** Original name when editing; null for a new rule. */
	original: string | null;
	name: string;
	description: string;
	globs: string;
	alwaysApply: boolean;
	enabled: boolean;
	body: string;
}

const EMPTY_FORM: RuleForm = { original: null, name: "", description: "", globs: "", alwaysApply: false, enabled: true, body: "" };
const RULE_NAME_RE = /^[A-Za-z0-9._-]+$/;

function RulesPanel({ projectPath }: { projectPath: string }): ReactNode {
	const { t } = useTranslation("projects");
	const [rules, setRules] = useState<ProjectRule[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [form, setForm] = useState<RuleForm | null>(null);
	const [deleting, setDeleting] = useState<ProjectRule | null>(null);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		let live = true;
		window.vomp.invoke("project:rules", projectPath).then(
			next => live && setRules(next),
			failure => live && setError(errorText(failure)),
		);
		return () => {
			live = false;
		};
	}, [projectPath]);

	const save = async (draft: RuleDraft) => {
		setSaving(true);
		try {
			setRules(await window.vomp.invoke("project:rules:write", projectPath, draft));
			setForm(null);
			toast({ tone: "ok", message: t("rules.saved"), description: t("instructions.appliesNext") });
		} catch (failure) {
			toast({ tone: "err", message: t("rules.saveFailed"), description: errorText(failure) });
		} finally {
			setSaving(false);
		}
	};

	const remove = async (rule: ProjectRule) => {
		setDeleting(null);
		try {
			setRules(await window.vomp.invoke("project:rules:delete", projectPath, rule.name));
			toast({ tone: "ok", message: t("rules.deleted", { name: rule.name }) });
		} catch (failure) {
			toast({ tone: "err", message: t("rules.deleteFailed"), description: errorText(failure) });
		}
	};

	if (error) return <p className="m-4 text-sm text-err">{error}</p>;
	if (!rules) {
		return (
			<div className="flex flex-col gap-3 p-4" aria-busy>
				{[0, 1, 2].map(row => (
					<Skeleton key={row} height={56} />
				))}
			</div>
		);
	}
	// The list and the rule editor slide past each other: opening a rule moves forward, closing it moves back.
	if (form) {
		return (
			<PresenceSwap swapKey="editor" variant="slide" direction={1}>
				<RuleEditor form={form} taken={rules} saving={saving} onCancel={() => setForm(null)} onSave={draft => void save(draft)} />
			</PresenceSwap>
		);
	}

	return (
		<PresenceSwap swapKey="list" variant="slide" direction={-1}>
		<div className="flex flex-col gap-3 p-4">
			<div className="flex items-center gap-3">
				<p className="flex-1 text-sm text-fg-muted">{t("rules.explainer")}</p>
				<Button variant="primary" size="sm" icon={<Plus />} onClick={() => setForm(EMPTY_FORM)}>
					{t("rules.new")}
				</Button>
			</div>
			{rules.length === 0 ? (
				<EmptyState title={t("rules.emptyTitle")} body={t("rules.emptyBody")} />
			) : (
				<ul className="relative flex flex-col divide-y divide-border border-y border-border">
					<AnimatePresence initial={false} mode="popLayout">
					{rules.map(rule => (
						<motion.li
							key={rule.path}
							layout="position"
							initial={{ opacity: 0, y: -4 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0 }}
							transition={spring.snappy}
							className="flex items-start gap-3 py-3"
						>
							<div className="min-w-0 flex-1">
								<div className="flex flex-wrap items-center gap-2">
									<span className="font-mono text-md font-semibold text-fg">{rule.name}</span>
									{rule.source !== "omp" && <Chip>{t(`rules.source.${rule.source}`)}</Chip>}
									{rule.alwaysApply && <Chip tone="accent">{t("rules.always")}</Chip>}
									{!rule.enabled && <Chip tone="warn">{t("rules.off")}</Chip>}
								</div>
								{rule.description && <p className="mt-1 text-sm text-fg-muted">{rule.description}</p>}
								{rule.globs.length > 0 && (
									<p className="mt-1 truncate font-mono text-xs text-fg-faint">{t("rules.appliesTo", { globs: rule.globs.join(", ") })}</p>
								)}
								{rule.frontmatterError && <p className="mt-1 text-xs text-warn">{t("rules.frontmatterError", { error: rule.frontmatterError })}</p>}
							</div>
							{rule.editable ? (
								<div className="flex shrink-0 items-center gap-1">
									<Switch
										aria-label={t("rules.toggle", { name: rule.name })}
										checked={rule.enabled}
										onCheckedChange={enabled => void save({ name: rule.name, enabled, body: rule.body })}
									/>
									<IconButton
										label={t("rules.edit", { name: rule.name })}
										icon={<PencilSimple />}
										onClick={() =>
											setForm({
												original: rule.name,
												name: rule.name,
												description: rule.description ?? "",
												globs: rule.globs.join(", "),
												alwaysApply: rule.alwaysApply,
												enabled: rule.enabled,
												body: rule.body,
											})
										}
									/>
									<IconButton label={t("rules.delete", { name: rule.name })} icon={<Trash />} variant="danger-ghost" onClick={() => setDeleting(rule)} />
								</div>
							) : (
								<span className="shrink-0 text-xs text-fg-faint" title={rule.path}>
									{t("rules.readOnly")}
								</span>
							)}
						</motion.li>
					))}
					</AnimatePresence>
				</ul>
			)}
			<Dialog open={deleting !== null} onOpenChange={open => !open && setDeleting(null)}>
				<DialogContent
					size="sm"
					destructive
					title={t("rules.deleteTitle", { name: deleting?.name ?? "" })}
					description={t("rules.deleteBody")}
					footer={
						<>
							<Button onClick={() => setDeleting(null)}>{t("rules.keep")}</Button>
							<Button variant="danger" onClick={() => deleting && void remove(deleting)}>
								{t("rules.deleteConfirm")}
							</Button>
						</>
					}
				/>
			</Dialog>
		</div>
		</PresenceSwap>
	);
}

function RuleEditor({
	form: initial,
	taken,
	saving,
	onCancel,
	onSave,
}: {
	form: RuleForm;
	taken: ProjectRule[];
	saving: boolean;
	onCancel(): void;
	onSave(draft: RuleDraft): void;
}): ReactNode {
	const { t } = useTranslation("projects");
	const [form, setForm] = useState(initial);
	const [preview, setPreview] = useState(false);
	const name = form.name.trim().replace(/\.mdc?$/, "");
	const nameProblem = !name
		? t("rules.nameRequired")
		: !RULE_NAME_RE.test(name)
			? t("rules.nameInvalid")
			: name !== initial.original && taken.some(rule => rule.source === "omp" && rule.name === name)
				? t("rules.nameTaken")
				: null;
	const patch = (next: Partial<RuleForm>) => setForm(current => ({ ...current, ...next }));
	const submit = () => {
		if (nameProblem) return;
		onSave({
			name,
			description: form.description.trim() || null,
			globs: form.globs
				.split(",")
				.map(glob => glob.trim())
				.filter(Boolean),
			alwaysApply: form.alwaysApply,
			enabled: form.enabled,
			body: form.body,
		});
	};
	return (
		<form
			className="flex flex-col gap-4 p-4"
			onSubmit={event => {
				event.preventDefault();
				submit();
			}}
		>
			<h3 className="text-base font-semibold text-fg">{initial.original ? t("rules.editTitle", { name: initial.original }) : t("rules.newTitle")}</h3>
			<Input
				autoFocus={!initial.original}
				label={t("rules.name")}
				description={t("rules.nameHint")}
				value={form.name}
				disabled={initial.original !== null}
				onChange={event => patch({ name: event.currentTarget.value })}
				error={form.name ? (nameProblem ?? undefined) : undefined}
			/>
			<Input
				label={t("rules.description")}
				description={t("rules.descriptionHint")}
				value={form.description}
				onChange={event => patch({ description: event.currentTarget.value })}
			/>
			<Input
				label={t("rules.globs")}
				description={t("rules.globsHint")}
				placeholder="src/**/*.ts, *.css"
				value={form.globs}
				spellCheck={false}
				onChange={event => patch({ globs: event.currentTarget.value })}
			/>
			<Switch label={t("rules.alwaysLabel")} description={t("rules.alwaysHint")} checked={form.alwaysApply} onCheckedChange={alwaysApply => patch({ alwaysApply })} />
			<Switch label={t("rules.enabledLabel")} checked={form.enabled} onCheckedChange={enabled => patch({ enabled })} />
			<div className="flex flex-col gap-1.5">
				<div className="flex items-center justify-between">
					<span className="text-md font-medium text-fg">{t("rules.body")}</span>
					<Segmented<Mode>
						size="sm"
						aria-label={t("instructions.view")}
						value={preview ? "preview" : "write"}
						onValueChange={value => setPreview(value === "preview")}
						options={[
							{ value: "write", label: t("instructions.write") },
							{ value: "preview", label: t("instructions.preview") },
						]}
					/>
				</div>
				{preview ? (
					<div className="min-h-40 rounded-md border border-border bg-panel p-3">
						{form.body.trim() ? <Markdown text={form.body} /> : <p className="text-md text-fg-muted">{t("instructions.previewEmpty")}</p>}
					</div>
				) : (
					<Textarea
						aria-label={t("rules.body")}
						value={form.body}
						placeholder={t("rules.bodyPlaceholder")}
						minRows={8}
						maxRows={20}
						className="font-mono"
						onChange={event => patch({ body: event.currentTarget.value })}
					/>
				)}
			</div>
			<div className="flex justify-end gap-2">
				<Button onClick={onCancel}>{t("rules.cancel")}</Button>
				<Button type="submit" variant="primary" disabled={nameProblem !== null} loading={saving}>
					{t("rules.save")}
				</Button>
			</div>
		</form>
	);
}
