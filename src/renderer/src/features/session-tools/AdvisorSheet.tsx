import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ArrowSquareOut, Plus, Trash } from "@phosphor-icons/react";
import type { AdvisorDoc, AdvisorEntry, AdvisorFile, AdvisorScope } from "@shared/contracts/advisor";
import { AGENT_BUILTIN_TOOLS } from "@shared/contracts/agents";
import { Button, Checkbox, Dialog, DialogContent, EmptyState, Input, Popover, PopoverContent, PopoverTrigger, Select, SelectItem, Sheet, SheetContent, Spinner, Switch, Textarea, toast } from "@/ui";
import type { SheetProps } from "../../registry/slots";
import { controllerFor } from "../../state/app";
import type { SessionController } from "../../state/session";
import { ModelList } from "./pickers";
import { applyAdvisorConfig } from "./advisorApply";
import { reportFailure, runAndReport } from "./drive";
import { useSessionView } from "./status";
import { advisorApplication } from "./advisorState";

export function AdvisorSheet({ props, close }: SheetProps<{ tabId: string }>) {
	const session = controllerFor(props.tabId);
	return session ? <AdvisorEditor session={session} close={close} /> : null;
}

export function AdvisorEditor({ session, close }: { session: SessionController; close(): void }) {
	const { t } = useTranslation("advisor");
	const view = useSessionView(session);
	const [scope, setScope] = useState<AdvisorScope>("project");
	const [file, setFile] = useState<AdvisorFile | null>(null);
	const [doc, setDoc] = useState<AdvisorDoc | null>(null);
	const [selected, setSelected] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [reload, setReload] = useState(0);
	const [discardAction, setDiscardAction] = useState<"close" | "reload" | null>(null);
	const [modelOpen, setModelOpen] = useState(false);
	const application = advisorApplication(session);
	const needsApply = useSyncExternalStore(application.subscribe, application.getSnapshot).has(scope);
	const setNeedsApply = (pending: boolean) => application.set(scope, pending);
	const dirty = doc !== null && file !== null && JSON.stringify(doc) !== JSON.stringify(file.doc);
	const live = view.mode === "live" && !view.working && !view.readOnly;

	useEffect(() => {
		let disposed = false;
		setFile(null); setDoc(null); setError(null); setSelected(0);
		void window.vomp.invoke("advisor:read", session.projectPath, scope).then(value => {
			if (!disposed) { setFile(value); setDoc(value.error ? null : value.doc); setError(value.error ?? null); }
		}).catch(reason => { if (!disposed) setError(String(reason)); });
		return () => { disposed = true; };
	}, [session.projectPath, scope, reload]);

	const update = (patch: Partial<AdvisorEntry>) => setDoc(current => current ? { ...current, advisors: current.advisors.map((entry, index) => index === selected ? { ...entry, ...patch } : entry) } : current);
	const requestClose = () => { if (!busy) { if (dirty) setDiscardAction("close"); else close(); } };
	const requestReload = () => { if (!busy) { if (dirty) setDiscardAction("reload"); else setReload(value => value + 1); } };
	const apply = async () => {
		setBusy(true);
		try {
			const refreshed = await applyAdvisorConfig(session, scope);
			setFile(refreshed); setDoc(refreshed.doc); setNeedsApply(false);
			toast({ tone: "ok", message: t("saved") });
		}
		catch (reason) { setNeedsApply(true); reportFailure(reason); }
		finally { setBusy(false); }
	};
	const save = async () => {
		if (!file || !doc) return;
		const names = doc.advisors.map(entry => entry.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "advisor");
		if (doc.advisors.some(entry => !entry.name.trim()) || new Set(names).size !== names.length) { toast({ tone: "warn", message: t("invalidName") }); return; }
		if (doc.advisors.some(entry => !Number.isSafeInteger(entry.reviewInterval ?? 1) || (entry.reviewInterval ?? 1) < 1 || !Number.isSafeInteger(entry.maxNotesPerUpdate ?? 1) || (entry.maxNotesPerUpdate ?? 1) < 1) || !Number.isSafeInteger(doc.maxNotesPerUpdate ?? 1) || (doc.maxNotesPerUpdate ?? 1) < 1) { toast({ tone: "warn", message: t("invalidNumber") }); return; }
		setBusy(true);
		try {
			const saved = await window.vomp.invoke("advisor:save", session.projectPath, scope, file.content, doc);
			setFile(saved); setDoc(saved.doc);
			if (live) {
				try {
					const refreshed = await applyAdvisorConfig(session, scope);
					setFile(refreshed); setDoc(refreshed.doc); setNeedsApply(false);
					toast({ tone: "ok", message: t("saved") });
				}
				catch (reason) { setNeedsApply(true); toast({ tone: "warn", message: t("savedNotApplied"), description: String(reason) }); }
			} else { setNeedsApply(true); toast({ tone: "ok", message: t("saved") }); }
		} catch (reason) { reportFailure(reason); }
		finally { setBusy(false); }
	};
	const advisor = doc?.advisors[selected];
	const tools = [...new Set([...AGENT_BUILTIN_TOOLS, ...(advisor?.tools ?? [])])].sort();
	const selectField = (label: string, value: string, options: readonly [string, string][], onChange: (value: string) => void) => <div className="space-y-2"><p className="text-md font-medium">{label}</p><Select aria-label={label} value={value} onValueChange={onChange} className="w-full">{options.map(([key, title]) => <SelectItem key={key} value={key}>{title}</SelectItem>)}</Select></div>;

	return <>
		<Sheet open onOpenChange={open => { if (!open) requestClose(); }}>
			<SheetContent width={600} title={t("title")} description={t("description")} bodyClassName="space-y-6" footer={<><Button variant="ghost" disabled={busy} onClick={requestClose}>{t("cancel")}</Button><Button variant="primary" loading={busy} disabled={!doc || !dirty || view.readOnly} onClick={() => void save()}>{t(live ? "save" : "saveOnly")}</Button></>}>
				<div className="space-y-3">
				{selectField(t("scope"), scope, [["project", t("project")], ["user", t("user")]], value => { if (dirty) toast({ message: t("dirtyScope") }); else if (!busy) setScope(value as AdvisorScope); })}
				<p className="text-sm text-fg-muted">{t("scopeHint")}</p>
				<div className="flex flex-wrap items-center gap-2"><Button variant="secondary" disabled={!live || busy} onClick={() => void runAndReport(session, "/advisor on")}>{t("turnOn")}</Button><Button variant="secondary" disabled={!live || busy} onClick={() => void runAndReport(session, "/advisor off")}>{t("turnOff")}</Button></div>
				{file && <div className="space-y-2"><p className="break-all font-mono text-sm text-fg-muted">{file.file}</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" icon={<ArrowSquareOut />} disabled={!file.exists || busy} onClick={() => void window.vomp.invoke("app:openFile", file.file)}>{t("openFile")}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={requestReload}>{t("reload")}</Button></div></div>}
				</div>
				{error ? <div role="alert" className="space-y-3"><p className="font-medium text-err">{t("error")}</p><p className="break-words text-sm text-fg-muted">{error}</p><Button variant="secondary" onClick={requestReload}>{t("reload")}</Button></div> : !doc ? <div role="status" className="flex items-center gap-2 text-fg-muted"><Spinner size={16} />{t("loading")}</div> : <>
					{needsApply && <div role="status" className="space-y-3 rounded-md bg-warn-bg p-3 text-warn"><p>{t("savedNotApplied")}</p><Button variant="secondary" disabled={!live || busy || dirty} onClick={() => void apply()}>{t("apply")}</Button></div>}
					<div className="space-y-3 border-t border-border pt-6">
						{doc.advisors.length > 0 && selectField(t("select"), String(selected), doc.advisors.map((entry, index) => [String(index), entry.name || t("newName", { count: index + 1 })]), value => setSelected(Number(value)))}
						<Button variant="secondary" icon={<Plus />} disabled={busy || view.readOnly} onClick={() => { setSelected(doc.advisors.length); setDoc({ ...doc, advisors: [...doc.advisors, { name: t("newName", { count: doc.advisors.length + 1 }) }] }); }}>{t("add")}</Button>
					</div>
					{advisor ? <fieldset disabled={busy || view.readOnly} className="min-w-0 space-y-6">
						<Input label={t("name")} value={advisor.name} onChange={event => update({ name: event.currentTarget.value })} />
						<Switch label={t("enabled")} checked={advisor.enabled !== false} onCheckedChange={enabled => update({ enabled })} />
						<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{selectField(t("cadence"), advisor.reviewMode ?? "turn", [["turn", t("turn")], ["agent-end", t("agent-end")]], value => update({ reviewMode: value as "turn" | "agent-end" }))}<Input label={t("interval")} type="number" min={1} step={1} value={advisor.reviewInterval ?? 1} onChange={event => update({ reviewInterval: Number(event.currentTarget.value) })} /></div>
						<p className="text-sm text-fg-muted">{t("intervalHint")}</p>
						{selectField(t("catchup"), String(advisor.syncBacklog ?? "inherit"), [["inherit", t("inherit")], ["off", t("off")], ...[1, 3, 5].map(count => [String(count), t("threshold", { count })] as [string, string]), ["strict", t("strict")]], value => update({ syncBacklog: value === "inherit" ? undefined : value as AdvisorEntry["syncBacklog"] }))}
						<p className="text-sm text-fg-muted">{t("catchupHint")}</p>
						<div className="space-y-3"><Input label={t("model")} description={t("modelHint")} value={advisor.model ?? ""} onChange={event => update({ model: event.currentTarget.value || undefined })} /><Popover open={modelOpen} onOpenChange={setModelOpen}><PopoverTrigger asChild><Button variant="secondary">{t("chooseModel")}</Button></PopoverTrigger><PopoverContent width="min(440px, calc(100vw - 32px))"><ModelList projectPath={session.projectPath} current={null} session={session} onDone={() => setModelOpen(false)} onPick={async model => { update({ model: `${model.provider}/${model.id}` }); return true; }} /></PopoverContent></Popover></div>
						{selectField(t("sessions"), advisor.scope ?? "all", [["all", t("all")], ["main", t("main")], ["subagent", t("subagent")]], value => update({ scope: value as AdvisorEntry["scope"] }))}
						<Switch label={t("reasoning")} checked={advisor.includeReasoning !== false} onCheckedChange={includeReasoning => update({ includeReasoning })} />
						<Input label={t("notes")} description={t("notesHint")} type="number" min={1} step={1} value={advisor.maxNotesPerUpdate ?? ""} onChange={event => update({ maxNotesPerUpdate: event.currentTarget.value ? Number(event.currentTarget.value) : undefined })} />
						<div className="space-y-4"><h3 className="font-semibold">{t("tools")}</h3><Checkbox label={t("defaultTools")} description={t("defaultToolsHint")} checked={advisor.tools === undefined} onCheckedChange={defaults => update({ tools: defaults ? undefined : ["read", "grep", "glob"] })} />{advisor.tools !== undefined && <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{tools.map(tool => <Checkbox key={tool} label={tool} checked={advisor.tools!.includes(tool)} onCheckedChange={checked => update({ tools: checked ? [...advisor.tools!, tool] : advisor.tools!.filter(value => value !== tool) })} />)}</div>}</div>
						<Textarea label={t("instructions")} description={t("instructionsHint")} rows={5} value={advisor.instructions ?? ""} onChange={event => update({ instructions: event.currentTarget.value || undefined })} />
						<Button variant="danger-ghost" icon={<Trash />} onClick={() => { setDoc({ ...doc, advisors: doc.advisors.filter((_, index) => index !== selected) }); setSelected(Math.max(0, selected - 1)); }}>{t("remove")}</Button>
					</fieldset> : <EmptyState title={t("empty")} body={t("emptyHint")} />}
					<div className="space-y-4 border-t border-border pt-6"><Textarea label={t("shared")} description={t("sharedHint")} rows={4} disabled={busy || view.readOnly} value={doc.instructions ?? ""} onChange={event => setDoc({ ...doc, instructions: event.currentTarget.value || undefined })} /><Input label={t("sharedNotes")} description={t("notesHint")} type="number" min={1} step={1} disabled={busy || view.readOnly} value={doc.maxNotesPerUpdate ?? ""} onChange={event => setDoc({ ...doc, maxNotesPerUpdate: event.currentTarget.value ? Number(event.currentTarget.value) : undefined })} /></div>
					<p className="text-sm text-fg-muted">{t(live ? "saveHint" : "idleHint")}</p>
				</>}
			</SheetContent>
		</Sheet>
		<Dialog open={discardAction !== null} onOpenChange={open => { if (!open) setDiscardAction(null); }}><DialogContent title={t("discardTitle")} description={t("discardBody")} size="sm" footer={<><Button variant="ghost" onClick={() => setDiscardAction(null)}>{t("keepEditing")}</Button><Button variant="danger" onClick={() => { const action = discardAction; setDiscardAction(null); if (action === "reload") setReload(value => value + 1); else close(); }}>{t("discard")}</Button></>} /></Dialog>
	</>;
}
