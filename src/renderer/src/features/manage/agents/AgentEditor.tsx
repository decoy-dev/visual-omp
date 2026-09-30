/** Helper editor drawer (DESIGN §4.14): structured form for agent files, raw markdown for broken ones. */
import {
	AGENT_BUILTIN_TOOLS,
	AGENT_RESERVED_NAMES,
	AGENT_THINKING_LEVELS,
	type AgentDirs,
	type AgentDraft,
	type AgentEntry,
	type AgentThinkingLevel,
	type AgentValidation,
	type AgentWritableScope,
} from "@shared/contracts/agents";
import type { ModelInfo } from "@shared/contracts/config";
import { MessageSquarePlus, Save, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/transcript/Markdown";
import { Button, Checkbox, Input, Segmented, Select, SelectItem, Sheet, SheetContent, Skeleton, Switch, Textarea, toast } from "@/ui";
import { ModelSelect } from "../roles/ModelSelect";
import { folderName, ipcErrorMessage } from "../shared";

export type EditorTarget =
	| { kind: "create" }
	| { kind: "edit"; entry: AgentEntry }
	| { kind: "raw"; filePath: string; name: string | null };

const INHERIT = "__inherit__";
const CHAT_KINDS = ["chat"] as const;

interface FormState {
	name: string;
	description: string;
	systemPrompt: string;
	/** null = every tool. */
	tools: string[] | null;
	thinkingLevel: AgentThinkingLevel | null;
	modelOverride: string | null;
}

function formFrom(entry: AgentEntry | null): FormState {
	return {
		name: entry?.name ?? "",
		description: entry?.description ?? "",
		systemPrompt: entry?.systemPrompt ?? "",
		tools: entry?.tools ? entry.tools.filter(tool => tool !== "yield") : null,
		thinkingLevel: entry?.thinkingLevel ?? null,
		modelOverride: entry?.modelOverride?.[0] ?? null,
	};
}

function sameTools(a: string[] | null, b: string[] | null): boolean {
	if (a === null || b === null) return a === b;
	return a.length === b.length && a.every(tool => b.includes(tool));
}

export interface AgentEditorProps {
	target: EditorTarget;
	cwd: string | null;
	dirs: AgentDirs | null;
	models: readonly ModelInfo[] | null;
	/** Names already used, for the create/rename check. */
	takenNames: ReadonlySet<string>;
	onClose(): void;
	onSaved(): void;
	/** Opens a new chat with "Use the <name> agent to " in the composer. */
	onTest(name: string): void;
}

export function AgentEditor(props: AgentEditorProps) {
	const { t } = useTranslation("manage");
	const title =
		props.target.kind === "create"
			? t("agents.editor.newTitle")
			: props.target.kind === "edit"
				? t("agents.editor.editTitle", { name: props.target.entry.name })
				: t("agents.editor.fixTitle", { name: props.target.name ?? folderName(props.target.filePath) });
	return (
		<Sheet open onOpenChange={open => !open && props.onClose()}>
			<SheetContent
				width={400}
				// The helpers sheet already dims the app; a second scrim would sit underneath it.
				noScrim
				title={title}
				description={props.target.kind === "raw" ? t("agents.editor.fixDescription") : undefined}
				bodyClassName="p-0"
			>
				{props.target.kind === "raw" ? <RawEditor {...props} filePath={props.target.filePath} /> : <FormEditor {...props} />}
			</SheetContent>
		</Sheet>
	);
}

function FormEditor({ target, cwd, dirs, models, takenNames, onSaved, onTest, onClose }: AgentEditorProps) {
	const { t } = useTranslation("manage");
	const entry = target.kind === "edit" ? target.entry : null;
	const initial = useMemo(() => formFrom(entry), [entry]);
	const [form, setForm] = useState(initial);
	const [scope, setScope] = useState<AgentWritableScope>("user");
	const [preview, setPreview] = useState<"write" | "preview">("write");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const update = (patch: Partial<FormState>) => {
		setForm(current => ({ ...current, ...patch }));
		setError(null);
	};

	const name = form.name.trim();
	const nameError = !name
		? null
		: (AGENT_RESERVED_NAMES as readonly string[]).includes(name)
			? t("agents.editor.nameReserved", { name })
			: name !== entry?.name && takenNames.has(name)
				? t("agents.editor.nameTaken")
				: /\s/.test(name)
					? t("agents.editor.nameSpaces")
					: null;
	const complete = name !== "" && form.description.trim() !== "" && form.systemPrompt.trim() !== "" && !nameError;
	const dirty =
		form.name !== initial.name ||
		form.description !== initial.description ||
		form.systemPrompt !== initial.systemPrompt ||
		!sameTools(form.tools, initial.tools) ||
		form.thinkingLevel !== initial.thinkingLevel ||
		form.modelOverride !== initial.modelOverride;

	const extraTools = (entry?.tools ?? []).filter(
		tool => tool !== "yield" && !(AGENT_BUILTIN_TOOLS as readonly string[]).includes(tool),
	);
	const toolOptions = [...AGENT_BUILTIN_TOOLS, ...extraTools];

	const save = async () => {
		if (!complete) return;
		setSaving(true);
		try {
			const tools = form.tools;
			if (!entry) {
				await window.vomp.invoke(
					"agents:create",
					{
						name,
						description: form.description.trim(),
						systemPrompt: form.systemPrompt,
						tools: tools ?? undefined,
						thinkingLevel: form.thinkingLevel ?? undefined,
					},
					scope,
					cwd,
				);
				if (form.modelOverride) await window.vomp.invoke("agents:setModelOverride", name, [form.modelOverride], cwd);
			} else if (entry.filePath) {
				const draft: AgentDraft = {};
				if (name !== entry.name) draft.name = name;
				if (form.description !== initial.description) draft.description = form.description.trim();
				if (form.systemPrompt !== initial.systemPrompt) draft.systemPrompt = form.systemPrompt;
				if (!sameTools(form.tools, initial.tools)) draft.tools = tools;
				if (form.thinkingLevel !== initial.thinkingLevel) draft.thinkingLevel = form.thinkingLevel;
				if (Object.keys(draft).length > 0) await window.vomp.invoke("agents:update", entry.filePath, draft);
				// Overrides are keyed by name: a rename carries the override along.
				if (name !== entry.name && entry.modelOverride) {
					await window.vomp.invoke("agents:setModelOverride", entry.name, null, cwd);
					await window.vomp.invoke("agents:setModelOverride", name, form.modelOverride ? [form.modelOverride] : null, cwd);
				} else if (form.modelOverride !== initial.modelOverride) {
					await window.vomp.invoke("agents:setModelOverride", name, form.modelOverride ? [form.modelOverride] : null, cwd);
				}
			}
			toast({ tone: "ok", message: t("agents.editor.saved", { name }) });
			onSaved();
			onClose();
		} catch (err) {
			setError(ipcErrorMessage(err));
		} finally {
			setSaving(false);
		}
	};

	const toggleTool = (tool: string, on: boolean) => {
		const current = form.tools ?? [];
		update({ tools: on ? [...current, tool] : current.filter(entryTool => entryTool !== tool) });
	};

	return (
		<form
			className="flex h-full flex-col"
			onSubmit={event => {
				event.preventDefault();
				void save();
			}}
		>
			<div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
				{target.kind === "create" && cwd && (
					<div>
						<span className="mb-1.5 block text-md font-medium text-fg">{t("agents.editor.scope")}</span>
						<Segmented
							aria-label={t("agents.editor.scope")}
							value={scope}
							onValueChange={setScope}
							options={[
								{ value: "user", label: t("agents.scope.user") },
								{ value: "project", label: t("agents.scope.project") },
							]}
						/>
						<p className="mt-1 text-sm text-fg-muted">
							{t(`agents.editor.scopeHelp.${scope}`, {
								dir: scope === "user" ? dirs?.user : (dirs?.project ?? dirs?.projectDefault),
							})}
						</p>
					</div>
				)}
				<Input
					label={t("agents.editor.name")}
					description={t("agents.editor.nameHelp")}
					value={form.name}
					onChange={event => update({ name: event.currentTarget.value })}
					error={nameError ?? undefined}
					boxClassName="font-mono"
					spellCheck={false}
					autoFocus={target.kind === "create"}
					required
				/>
				<Textarea
					label={t("agents.editor.description")}
					description={t("agents.editor.descriptionHelp")}
					value={form.description}
					onChange={event => update({ description: event.currentTarget.value })}
					minRows={2}
					maxRows={4}
					required
				/>
				<div>
					<span className="mb-1.5 block text-md font-medium text-fg">{t("agents.editor.model")}</span>
					<ModelSelect
						className="w-full"
						aria-label={t("agents.editor.model")}
						models={models ?? []}
						accepts={CHAT_KINDS}
						value={form.modelOverride}
						onChange={modelOverride => update({ modelOverride })}
						autoLabel={
							entry?.model?.length ? t("agents.editor.modelOwn", { model: entry.model.join(", ") }) : t("agents.editor.modelDefault")
						}
						disabled={!models}
					/>
					<p className="mt-1 text-sm text-fg-muted">{t("agents.editor.modelHelp")}</p>
				</div>
				<div>
					<span className="mb-1.5 block text-md font-medium text-fg">{t("agents.editor.thinking")}</span>
					<Select
						className="w-full"
						aria-label={t("agents.editor.thinking")}
						value={form.thinkingLevel ?? INHERIT}
						onValueChange={value => update({ thinkingLevel: AGENT_THINKING_LEVELS.find(level => level === value) ?? null })}
					>
						<SelectItem value={INHERIT}>{t("agents.editor.thinkingDefault")}</SelectItem>
						{AGENT_THINKING_LEVELS.map(level => (
							<SelectItem key={level} value={level}>
								{t(`thinking.${level}`)}
							</SelectItem>
						))}
					</Select>
				</div>
				<fieldset className="m-0 min-w-0 border-0 p-0">
					<legend className="mb-1.5 p-0 text-md font-medium text-fg">{t("agents.editor.tools")}</legend>
					<Switch
						label={t("agents.editor.allTools")}
						description={t("agents.editor.allToolsHelp")}
						checked={form.tools === null}
						onCheckedChange={all => update({ tools: all ? null : ["read", "grep", "glob", "find"] })}
					/>
					{form.tools !== null && (
						<div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 rounded-md border border-border bg-inset p-3">
							{toolOptions.map(tool => (
								<Checkbox
									key={tool}
									label={t(`agents.tools.${tool}`, { defaultValue: tool })}
									title={tool}
									checked={form.tools?.includes(tool) ?? false}
									onCheckedChange={on => toggleTool(tool, on)}
								/>
							))}
						</div>
					)}
				</fieldset>
				<div>
					<div className="mb-1.5 flex items-center justify-between">
						<span className="text-md font-medium text-fg" id="manage-agent-instructions">
							{t("agents.editor.instructions")}
						</span>
						<Segmented
							size="sm"
							aria-label={t("agents.editor.instructionsView")}
							value={preview}
							onValueChange={setPreview}
							options={[
								{ value: "write", label: t("agents.editor.write") },
								{ value: "preview", label: t("agents.editor.preview") },
							]}
						/>
					</div>
					{preview === "write" ? (
						<Textarea
							aria-labelledby="manage-agent-instructions"
							value={form.systemPrompt}
							onChange={event => update({ systemPrompt: event.currentTarget.value })}
							minRows={10}
							maxRows={24}
							className="[&_textarea]:font-mono [&_textarea]:text-sm"
							placeholder={t("agents.editor.instructionsPlaceholder")}
							spellCheck={false}
							required
						/>
					) : (
						<div className="min-h-40 rounded-md border border-border bg-panel p-3 text-md">
							{form.systemPrompt.trim() ? <Markdown text={form.systemPrompt} /> : <p className="text-fg-faint">{t("agents.editor.previewEmpty")}</p>}
						</div>
					)}
				</div>
				{error && (
					<p role="alert" className="flex items-start gap-2 rounded-md bg-err-bg px-3 py-2 text-md text-err">
						<TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
						{t("agents.editor.saveFailed", { reason: error })}
					</p>
				)}
			</div>
			<footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
				{entry && (
					<Button variant="ghost" icon={<MessageSquarePlus />} disabled={dirty} title={dirty ? t("agents.editor.testSaveFirst") : undefined} onClick={() => onTest(entry.name)}>
						{t("agents.editor.test")}
					</Button>
				)}
				<Button type="submit" variant="primary" icon={<Save />} loading={saving} disabled={!complete || (entry !== null && !dirty)}>
					{target.kind === "create" ? t("agents.editor.create") : t("agents.editor.save")}
				</Button>
			</footer>
		</form>
	);
}

function RawEditor({ filePath, onSaved, onClose }: AgentEditorProps & { filePath: string }) {
	const { t } = useTranslation("manage");
	const [content, setContent] = useState<string | null>(null);
	const [validation, setValidation] = useState<AgentValidation | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		window.vomp
			.invoke("agents:read", filePath)
			.then(file => {
				setContent(file.content);
				setValidation(file.validation);
			})
			.catch((err: unknown) => setError(ipcErrorMessage(err)));
	}, [filePath]);

	// Validate as the user types, a beat after they pause.
	useEffect(() => {
		if (content === null) return;
		const timer = window.setTimeout(() => {
			void window.vomp.invoke("agents:validate", content).then(setValidation);
		}, 300);
		return () => window.clearTimeout(timer);
	}, [content]);

	const save = async () => {
		if (content === null) return;
		setSaving(true);
		try {
			const file = await window.vomp.invoke("agents:writeRaw", filePath, content);
			if (file.validation.ok) {
				toast({ tone: "ok", message: t("agents.editor.fixed") });
				onSaved();
				onClose();
			} else {
				setValidation(file.validation);
				onSaved();
			}
		} catch (err) {
			setError(ipcErrorMessage(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="flex h-full flex-col">
			<div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
				<p className="break-all font-mono text-xs text-fg-faint">{filePath}</p>
				{validation && (
					<p
						role="status"
						className={validation.ok ? "rounded-md bg-ok-bg px-3 py-2 text-md text-ok" : "rounded-md bg-warn-bg px-3 py-2 text-md text-warn"}
					>
						{validation.ok ? t("agents.editor.valid") : t("agents.editor.invalid", { reason: validation.error })}
					</p>
				)}
				{error && (
					<p role="alert" className="rounded-md bg-err-bg px-3 py-2 text-md text-err">
						{error}
					</p>
				)}
				{content === null ? (
					!error && <Skeleton height={240} />
				) : (
					<Textarea
						aria-label={t("agents.editor.rawLabel")}
						value={content}
						onChange={event => setContent(event.currentTarget.value)}
						minRows={16}
						maxRows={40}
						className="[&_textarea]:font-mono [&_textarea]:text-sm"
						spellCheck={false}
					/>
				)}
			</div>
			<footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
				<Button variant="primary" icon={<Save />} loading={saving} disabled={content === null} onClick={() => void save()}>
					{t("agents.editor.save")}
				</Button>
			</footer>
		</div>
	);
}
