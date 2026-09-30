/** Add / edit flow of the MCP manager: preset gallery → form → Test connection → Save. */
import { ArrowLeft, CheckCircle, Eye, EyeSlash, FolderOpen, Plus, Trash, XCircle } from "@phosphor-icons/react";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	McpListResult,
	McpPreset,
	McpPresetField,
	McpScope,
	McpServerConfig,
	McpServerEntry,
	McpTarget,
	McpTestResult,
} from "@shared/contracts/mcp";
import { Button, Checkbox, Chip, IconButton, Input, Segmented, Skeleton, Spinner, toast } from "@/ui";
import { errorText } from "../format";
import { ExtensionSheetFrame, Notice, useLoad } from "../shared";
import { configFromForm, emptyForm, formFromConfig, type KeyValueRow, type McpForm, type McpFormErrors, validateForm } from "./form";

export type EditorMode =
	| { kind: "gallery" }
	| { kind: "preset"; preset: McpPreset }
	| { kind: "custom" }
	| { kind: "edit"; entry: McpServerEntry };

interface ServerEditorProps {
	mode: EditorMode;
	close(): void;
	projectPath: string | null;
	list: McpListResult | null;
	onBack(): void;
	/** Called after a successful save with the scope saved to. */
	onSaved(scope: McpScope | null): void;
}

const CATEGORY_ORDER: McpPreset["category"][] = ["developer", "productivity", "web", "knowledge", "reference"];

export function ServerEditor(props: ServerEditorProps) {
	const [mode, setMode] = useState<EditorMode>(props.mode);
	if (mode.kind === "gallery") return <PresetGallery {...props} onPick={setMode} />;
	return <ServerForm key={mode.kind === "preset" ? mode.preset.id : mode.kind} {...props} mode={mode} onBack={props.mode.kind === "gallery" ? () => setMode({ kind: "gallery" }) : props.onBack} />;
}

function PresetGallery({ close, onBack, onPick }: ServerEditorProps & { onPick(mode: EditorMode): void }) {
	const { t } = useTranslation("extensions");
	const presets = useLoad(() => window.vomp.invoke("mcp:presets"), []);
	const groups = useMemo(
		() =>
			CATEGORY_ORDER.map(category => ({ category, items: (presets.data ?? []).filter(p => p.category === category) })).filter(
				group => group.items.length > 0,
			),
		[presets.data],
	);
	return (
		<ExtensionSheetFrame
			close={close}
			width={880}
			title={t("mcp.gallery.title")}
			description={t("mcp.gallery.subtitle")}
			bodyClassName="flex flex-col gap-6"
			footer={
				<Button variant="ghost" icon={<ArrowLeft />} className="mr-auto" onClick={onBack}>
					{t("common.back")}
				</Button>
			}
		>
			<div className="flex items-center gap-4 border-b border-border pb-4">
				<div className="min-w-0 flex-1">
					<p className="text-md font-medium text-fg">{t("mcp.gallery.customTitle")}</p>
					<p className="text-sm text-fg-muted">{t("mcp.gallery.customBody")}</p>
				</div>
				<Button icon={<Plus />} onClick={() => onPick({ kind: "custom" })}>
					{t("mcp.gallery.customAction")}
				</Button>
			</div>
			{presets.error && <Notice tone="err">{presets.error}</Notice>}
			{!presets.data && presets.loading && (
				<div className="flex flex-col gap-2">
					{[0, 1, 2, 3, 4, 5].map(i => (
						<Skeleton key={i} height={48} />
					))}
				</div>
			)}
			{groups.map(({ category, items }) => (
				<section key={category} aria-labelledby={`mcp-cat-${category}`} className="flex flex-col">
					<h3 id={`mcp-cat-${category}`} className="mb-1 text-sm font-medium text-fg-muted">
						{t(`mcp.category.${category}`)}
					</h3>
					<ul className="divide-y divide-border">
						{items.map(preset => (
							<li key={preset.id} className="flex items-center gap-4 py-2.5">
								<div className="min-w-0 flex-1">
									<p className="truncate text-md font-medium text-fg">{preset.label}</p>
									<p className="line-clamp-2 text-sm text-fg-muted">{preset.description}</p>
								</div>
								<div className="flex shrink-0 items-center gap-1.5">
									{preset.oauth && <Chip tone="neutral">{t("mcp.gallery.signIn")}</Chip>}
									{preset.requires.map(bin => (
										<Chip key={bin} tone="neutral">
											{t("mcp.gallery.needs", { bin })}
										</Chip>
									))}
									<Button size="sm" onClick={() => onPick({ kind: "preset", preset })} aria-label={t("mcp.gallery.addNamed", { name: preset.label })}>
										{t("mcp.gallery.addAction")}
									</Button>
								</div>
							</li>
						))}
					</ul>
				</section>
			))}
		</ExtensionSheetFrame>
	);
}

type Check = { state: "idle" } | { state: "running" } | { state: "done"; result: McpTestResult } | { state: "error"; message: string };

type FormMode = Exclude<EditorMode, { kind: "gallery" }>;

function ServerForm({ mode, close, projectPath, list, onBack, onSaved }: ServerEditorProps & { mode: FormMode }) {
	const { t } = useTranslation("extensions");
	const editing = mode.kind === "edit" ? mode.entry : null;
	const preset = mode.kind === "preset" ? mode.preset : null;
	const defaultScope: McpScope = editing?.level ?? (projectPath ? "project" : "user");
	const [form, setForm] = useState<McpForm>(() =>
		editing
			? formFromConfig(editing.name, editing.config, editing.level)
			: { ...emptyForm(defaultScope), name: preset?.suggestedName ?? "" },
	);
	const [values, setValues] = useState<Record<string, string | string[]>>(() =>
		Object.fromEntries((preset?.fields ?? []).map(field => [field.id, field.kind === "paths" ? [] : ""])),
	);
	const [showErrors, setShowErrors] = useState(false);
	const [check, setCheck] = useState<Check>({ state: "idle" });
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	const scopePath = form.scope === "user" ? list?.userPath : list?.projectPath;
	const takenNames = (list?.servers ?? [])
		.filter(entry => entry.editable && entry.path === scopePath)
		.map(entry => entry.name)
		.filter(name => !(editing && editing.level === form.scope && name === editing.name));
	const formErrors = validateForm(form, takenNames);
	// Preset templates supply the command/URL; only the name comes from the form.
	const errors: McpFormErrors = preset ? { name: formErrors.name } : formErrors;
	const missingFields = (preset?.fields ?? []).filter(field => field.required && isBlank(values[field.id]));
	const valid = !errors.name && !errors.command && !errors.url && missingFields.length === 0;
	const update = (patch: Partial<McpForm>) => {
		setForm(prev => ({ ...prev, ...patch }));
		setCheck({ state: "idle" });
	};

	const buildConfig = async (): Promise<McpServerConfig> => {
		if (!preset) return configFromForm(form, editing?.config);
		const filled = Object.fromEntries(
			Object.entries(values).map(([id, value]) => [id, Array.isArray(value) ? value.map(v => v.trim()).filter(Boolean) : value.trim()]),
		);
		return window.vomp.invoke("mcp:preset:build", preset.id, filled);
	};

	const test = async () => {
		setShowErrors(true);
		if (!valid) return;
		setCheck({ state: "running" });
		try {
			const config = await buildConfig();
			const result = await window.vomp.invoke("mcp:test", config, projectPath ? { cwd: projectPath } : undefined);
			setCheck({ state: "done", result });
		} catch (err) {
			setCheck({ state: "error", message: errorText(err) });
		}
	};

	const save = async () => {
		setShowErrors(true);
		if (!valid) return;
		const target: McpTarget | null =
			form.scope === "user" ? { scope: "user" } : projectPath ? { scope: "project", cwd: projectPath } : null;
		if (!target) return;
		const name = form.name.trim();
		setSaving(true);
		setSaveError(null);
		try {
			const config = await buildConfig();
			if (editing && editing.level === form.scope) {
				await window.vomp.invoke("mcp:update", target, editing.name, config, name !== editing.name ? name : undefined);
			} else {
				await window.vomp.invoke("mcp:add", target, name, config);
				if (editing) {
					const previous: McpTarget = editing.level === "user" ? { scope: "user" } : { scope: "project", cwd: projectPath ?? "" };
					await window.vomp.invoke("mcp:remove", previous, editing.name);
				}
			}
			toast({ tone: "ok", message: t("mcp.toast.saved", { name }) });
			if (preset?.oauth) toast({ tone: "info", sticky: true, message: t("mcp.toast.signInTitle", { name }), description: t("mcp.toast.signInBody", { name }) });
			onSaved(form.scope);
		} catch (err) {
			setSaveError(errorText(err));
		} finally {
			setSaving(false);
		}
	};

	const title = editing ? t("mcp.form.editTitle", { name: editing.name }) : preset ? t("mcp.form.presetTitle", { name: preset.label }) : t("mcp.form.customTitle");
	return (
		<ExtensionSheetFrame
			close={close}
			width={880}
			title={title}
			description={preset?.description ?? t("mcp.subtitle")}
			bodyClassName="flex flex-col gap-5"
			footer={
				<>
					<Button variant="ghost" icon={<ArrowLeft />} className="mr-auto" onClick={onBack}>
						{t("common.back")}
					</Button>
					<Button onClick={() => void test()} loading={check.state === "running"}>
						{t("mcp.test.action")}
					</Button>
					<Button variant="primary" onClick={() => void save()} loading={saving}>
						{t("mcp.form.save")}
					</Button>
				</>
			}
		>
			<div className="mx-auto flex w-full max-w-[600px] flex-col gap-5">
				{preset?.note && <Notice tone="info">{preset.note}</Notice>}
				{preset && preset.requires.length > 0 && <Notice tone="info">{t("mcp.form.requires", { bins: preset.requires.join(", ") })}</Notice>}
				<Input
					label={t("mcp.form.name")}
					description={t("mcp.form.nameHint")}
					value={form.name}
					onChange={event => update({ name: event.currentTarget.value })}
					error={showErrors && errors.name ? t(`mcp.form.errors.${errors.name}`) : undefined}
					autoFocus={!editing}
					spellCheck={false}
				/>

				{preset ? (
					preset.fields.map(field => (
						<PresetFieldInput
							key={field.id}
							field={field}
							value={values[field.id] ?? ""}
							invalid={showErrors && missingFields.includes(field)}
							onChange={value => {
								setValues(prev => ({ ...prev, [field.id]: value }));
								setCheck({ state: "idle" });
							}}
						/>
					))
				) : (
					<CustomFields form={form} update={update} errors={showErrors ? errors : {}} />
				)}

				<FieldGroup label={t("mcp.form.scope")} hint={t("mcp.form.scopeHint")}>
					<Segmented<McpScope>
						aria-label={t("mcp.form.scope")}
						value={form.scope}
						onValueChange={scope => update({ scope })}
						options={[
							{ value: "user", label: t("scope.user") },
							{ value: "project", label: t("scope.project"), disabled: !projectPath },
						]}
					/>
				</FieldGroup>

				<TestPanel check={check} name={form.name.trim()} />
				{saveError && <Notice tone="err">{saveError}</Notice>}
			</div>
		</ExtensionSheetFrame>
	);
}

function isBlank(value: string | string[] | undefined): boolean {
	return Array.isArray(value) ? value.every(v => !v.trim()) : !value?.trim();
}

function FieldGroup({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
	return (
		<div role="group" aria-label={label} className="flex flex-col gap-1.5">
			<span className="text-md font-medium text-fg">{label}</span>
			{children}
			{hint && <p className="text-sm text-fg-muted">{hint}</p>}
		</div>
	);
}

function CustomFields({ form, update, errors }: { form: McpForm; update(patch: Partial<McpForm>): void; errors: McpFormErrors }) {
	const { t } = useTranslation("extensions");
	const remote = form.transport !== "stdio";
	return (
		<>
			<FieldGroup label={t("mcp.form.transport")}>
				<Segmented<"local" | "remote">
					aria-label={t("mcp.form.transport")}
					value={remote ? "remote" : "local"}
					onValueChange={next => update({ transport: next === "local" ? "stdio" : "http" })}
					options={[
						{ value: "local", label: t("mcp.form.local") },
						{ value: "remote", label: t("mcp.form.remote") },
					]}
				/>
			</FieldGroup>
			{remote ? (
				<>
					<Input
						label={t("mcp.form.url")}
						placeholder="https://mcp.example.com/mcp"
						value={form.url}
						onChange={event => update({ url: event.currentTarget.value })}
						error={errors.url ? t(`mcp.form.errors.${errors.url}`) : undefined}
						boxClassName="font-mono"
						spellCheck={false}
					/>
					<Checkbox
						label={t("mcp.form.sse")}
						description={t("mcp.form.sseHint")}
						checked={form.transport === "sse"}
						onCheckedChange={checked => update({ transport: checked ? "sse" : "http" })}
					/>
					<KeyValueEditor
						label={t("mcp.form.headers")}
						hint={t("mcp.form.headersHint")}
						addLabel={t("mcp.form.addHeader")}
						keyPlaceholder="Authorization"
						valuePlaceholder="Bearer ${API_TOKEN}"
						rows={form.headers}
						onChange={headers => update({ headers })}
					/>
				</>
			) : (
				<>
					<Input
						label={t("mcp.form.command")}
						description={t("mcp.form.commandHint")}
						placeholder="npx -y @modelcontextprotocol/server-memory"
						value={form.commandLine}
						onChange={event => update({ commandLine: event.currentTarget.value })}
						error={errors.command ? t(`mcp.form.errors.${errors.command}`) : undefined}
						boxClassName="font-mono"
						spellCheck={false}
					/>
					<KeyValueEditor
						label={t("mcp.form.env")}
						hint={t("mcp.form.envHint")}
						addLabel={t("mcp.form.addEnv")}
						keyPlaceholder="API_KEY"
						valuePlaceholder="${MY_API_KEY}"
						rows={form.env}
						onChange={env => update({ env })}
					/>
				</>
			)}
		</>
	);
}

interface KeyValueEditorProps {
	label: string;
	hint: string;
	addLabel: string;
	keyPlaceholder: string;
	valuePlaceholder: string;
	rows: KeyValueRow[];
	onChange(rows: KeyValueRow[]): void;
}

function KeyValueEditor({ label, hint, addLabel, keyPlaceholder, valuePlaceholder, rows, onChange }: KeyValueEditorProps) {
	const { t } = useTranslation("extensions");
	const set = (index: number, patch: Partial<KeyValueRow>) => onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
	return (
		<FieldGroup label={label} hint={hint}>
			{rows.map((row, index) => (
				<div key={index} className="flex items-center gap-2">
					<Input
						size="sm"
						className="w-[200px]"
						boxClassName="font-mono"
						aria-label={t("mcp.form.keyLabel", { index: index + 1 })}
						placeholder={keyPlaceholder}
						value={row.key}
						spellCheck={false}
						onChange={event => set(index, { key: event.currentTarget.value })}
					/>
					<Input
						size="sm"
						className="flex-1"
						boxClassName="font-mono"
						aria-label={t("mcp.form.valueLabel", { index: index + 1 })}
						placeholder={valuePlaceholder}
						value={row.value}
						spellCheck={false}
						onChange={event => set(index, { value: event.currentTarget.value })}
					/>
					<IconButton size="sm" label={t("mcp.form.removeRow")} icon={<Trash />} onClick={() => onChange(rows.filter((_, i) => i !== index))} />
				</div>
			))}
			<div>
				<Button size="sm" variant="ghost" icon={<Plus />} onClick={() => onChange([...rows, { key: "", value: "" }])}>
					{addLabel}
				</Button>
			</div>
		</FieldGroup>
	);
}

function PresetFieldInput({
	field,
	value,
	invalid,
	onChange,
}: {
	field: McpPresetField;
	value: string | string[];
	invalid: boolean;
	onChange(value: string | string[]): void;
}) {
	const { t } = useTranslation("extensions");
	const [reveal, setReveal] = useState(false);
	const label = field.required ? field.label : t("mcp.form.optional", { label: field.label });
	const error = invalid ? t("mcp.form.errors.fieldRequired") : undefined;
	const choose = async (apply: (dir: string) => void) => {
		const dir = await window.vomp.invoke("app:pickFolder", field.label);
		if (dir) apply(dir);
	};
	if (field.kind === "paths") {
		const list = Array.isArray(value) ? value : [];
		return (
			<FieldGroup label={label} hint={field.description}>
				{list.map((dir, index) => (
					<div key={index} className="flex items-center gap-2">
						<Input
							size="sm"
							className="flex-1"
							boxClassName="font-mono"
							aria-label={t("mcp.form.folderLabel", { index: index + 1 })}
							value={dir}
							onChange={event => onChange(list.map((d, i) => (i === index ? event.currentTarget.value : d)))}
						/>
						<IconButton size="sm" label={t("mcp.form.removeRow")} icon={<Trash />} onClick={() => onChange(list.filter((_, i) => i !== index))} />
					</div>
				))}
				<div>
					<Button size="sm" variant="ghost" icon={<FolderOpen />} onClick={() => void choose(dir => onChange([...list, dir]))}>
						{t("mcp.form.addFolder")}
					</Button>
				</div>
				{error && <p className="text-sm text-err">{error}</p>}
			</FieldGroup>
		);
	}
	const text = typeof value === "string" ? value : "";
	const secret = field.kind === "secret";
	return (
		<Input
			label={label}
			description={field.description}
			placeholder={field.placeholder ?? undefined}
			type={secret && !reveal ? "password" : "text"}
			value={text}
			error={error}
			boxClassName={field.kind === "text" ? undefined : "font-mono"}
			spellCheck={false}
			autoComplete="off"
			onChange={event => onChange(event.currentTarget.value)}
			trailing={
				secret ? (
					<IconButton
						size="sm"
						label={t(reveal ? "mcp.form.hide" : "mcp.form.show")}
						icon={reveal ? <EyeSlash /> : <Eye />}
						onClick={() => setReveal(r => !r)}
					/>
				) : field.kind === "path" ? (
					<Button size="sm" variant="ghost" onClick={() => void choose(onChange)}>
						{t("mcp.form.choose")}
					</Button>
				) : undefined
			}
		/>
	);
}

function TestPanel({ check, name }: { check: Check; name: string }) {
	const { t } = useTranslation("extensions");
	if (check.state === "idle") return null;
	if (check.state === "running") {
		return (
			<div role="status" className="flex items-center gap-2 rounded-md border border-border bg-inset px-3 py-2.5 text-sm text-fg-muted">
				<Spinner /> {t("mcp.test.running")}
			</div>
		);
	}
	if (check.state === "error") return <Notice tone="err">{check.message}</Notice>;
	const { result } = check;
	if (result.ok) {
		return (
			<div role="status" className="flex flex-col gap-1 rounded-md border border-border bg-ok-bg px-3 py-2.5 text-sm text-fg">
				<span className="flex items-center gap-2 font-medium">
					<CheckCircle aria-hidden className="size-4 text-ok" />
					{result.tools.length > 0 ? t("mcp.test.found", { count: result.tools.length }) : t("mcp.noTools")}
				</span>
				{result.serverInfo && (
					<span className="pl-6 text-fg-muted">
						{t("mcp.test.server", { name: result.serverInfo.title ?? result.serverInfo.name, version: result.serverInfo.version, seconds: (result.durationMs / 1000).toFixed(1) })}
					</span>
				)}
			</div>
		);
	}
	return (
		<div role="alert" className="flex flex-col gap-2 rounded-md border border-border bg-err-bg px-3 py-2.5 text-sm text-fg">
			<span className="flex items-start gap-2 font-medium">
				<XCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-err" />
				<span className="break-words">{result.authRequired ? t("mcp.test.authRequired", { name: name || "server" }) : result.error}</span>
			</span>
			{result.unresolvedVars.length > 0 && <span className="pl-6 text-fg-muted">{t("mcp.test.unresolved", { vars: result.unresolvedVars.join(", ") })}</span>}
			{result.stderr.trim() && (
				<details className="pl-6">
					<summary className="cursor-pointer text-fg-muted">{t("mcp.test.output")}</summary>
					<pre className="mt-1.5 max-h-40 overflow-auto rounded-sm bg-inset p-2 font-mono text-xs whitespace-pre-wrap text-fg-muted">{result.stderr.trim()}</pre>
				</details>
			)}
		</div>
	);
}
