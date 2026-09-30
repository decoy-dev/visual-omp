/**
 * New project wizard (DESIGN §4.4): Where? (empty folder / open existing / clone from GitHub) →
 * Details → First chat? Enter or ⌘↵ advances, Esc cancels (asking first when something was filled).
 * Opened with a preselected `kind` it starts at Details. Folders are picked in the in-app browser.
 */
import type { GitCloneProgress } from "@shared/contracts/git";
import type { ProjectNameCheck, RecentFolder } from "@shared/contracts/project";
import type { RemoteCheck } from "@shared/contracts/workspace";
import { Check, Folder, FolderOpen, Warning, WarningCircle } from "@phosphor-icons/react";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SheetProps } from "@/registry/slots";
import { useApp } from "@/state/app";
import {
	Button,
	cn,
	Dialog,
	DialogContent,
	Expand,
	Input,
	PresenceSwap,
	Progress,
	Spinner,
	StepDots,
	Switch,
	Textarea,
	toast,
} from "@/ui";
import { addProject, errorText, startChat } from "./actions";
import { CheckFailure } from "./CheckFailure";
import { FolderBrowserDialog } from "./folders/FolderBrowser";
import { folderName } from "./format";
import { useDebouncedCheck } from "./useDebouncedCheck";

export interface NewProjectProps {
	/** Preselect a starting option (e.g. the "Clone from GitHub" command). */
	kind?: Kind;
}

type Kind = "empty" | "existing" | "clone";

const KINDS: readonly Kind[] = ["empty", "existing", "clone"];

const NAME_CHECK_DELAY_MS = 150;
const REMOTE_CHECK_DELAY_MS = 500;
const checkRemote = (url: string) => window.vomp.invoke("workspace:checkRemote", url);

export function NewProjectWizard({ props, close }: SheetProps<NewProjectProps | undefined>): ReactNode {
	const { t } = useTranslation("projects");
	const projects = useApp(state => state.projects);
	const [step, setStep] = useState(props?.kind ? 1 : 0);
	const [kind, setKind] = useState<Kind>(props?.kind ?? "empty");
	const [defaultParent, setDefaultParent] = useState<string | null>(null);
	const [parentDir, setParentDir] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [folder, setFolder] = useState<string | null>(null);
	const [recent, setRecent] = useState<RecentFolder[] | null>(null);
	const [url, setUrl] = useState("");
	const [cloneName, setCloneName] = useState<string | null>(null);
	const [chatNow, setChatNow] = useState(true);
	const [firstMessage, setFirstMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState<GitCloneProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [confirmClose, setConfirmClose] = useState(false);
	/** Which folder the in-app browser is picking: the new project's parent, or the existing folder. */
	const [browsing, setBrowsing] = useState<"parent" | "existing" | null>(null);
	const cloneId = useRef<string | null>(null);

	useEffect(() => {
		void window.vomp.invoke("project:defaults").then(defaults => setDefaultParent(defaults.parentDir));
		void window.vomp.invoke("project:recent", 5).then(setRecent, () => setRecent([]));
	}, []);

	const parent = parentDir ?? defaultParent ?? undefined;
	const checkName = useCallback((value: string) => window.vomp.invoke("project:checkName", value, parent), [parent]);
	// Name answers are keyed by the parent folder, so a check made for another location never unlocks Next.
	const nameCheck = useDebouncedCheck(name, NAME_CHECK_DELAY_MS, checkName, parent ?? "");
	const remote = useDebouncedCheck(url, REMOTE_CHECK_DELAY_MS, checkRemote);
	const effectiveCloneName = cloneName ?? remote.result?.folderName ?? "";
	const cloneCheck = useDebouncedCheck(effectiveCloneName, NAME_CHECK_DELAY_MS, checkName, parent ?? "");
	const alreadyProject = folder !== null && (projects.some(project => project.path === folder) || recent?.some(entry => entry.path === folder && entry.registered));

	const detailsReady =
		kind === "empty"
			? nameCheck.result?.ok === true
			: kind === "existing"
				? folder !== null
				: remote.result?.ok === true && cloneCheck.result?.ok === true;
	const canAdvance = !busy && (step === 0 || (step === 1 && detailsReady) || step === 2);
	const dirty = step > 0 || name.trim() !== "" || url.trim() !== "" || folder !== null;

	const requestClose = () => {
		if (busy || dirty) setConfirmClose(true);
		else close();
	};

	const cancelClone = async () => {
		if (cloneId.current) await window.vomp.invoke("git:cloneCancel", cloneId.current);
	};

	const finish = async () => {
		setBusy(true);
		setError(null);
		try {
			let path: string;
			if (kind === "empty") {
				const created = await window.vomp.invoke("project:create", { name, parentDir: parent });
				if (!created.ok) {
					setError(t(`new.problem.${created.problem}`));
					setStep(1);
					return;
				}
				path = created.path;
			} else if (kind === "existing" && folder) {
				path = folder;
			} else {
				const target = remote.result?.url;
				if (!target || !parent) return;
				const id = crypto.randomUUID();
				cloneId.current = id;
				const off = window.vomp.on("git:cloneProgress", event => {
					if (event.id === id) setProgress(event);
				});
				try {
					const result = await window.vomp.invoke("git:clone", { id, url: target, parentDir: parent, name: effectiveCloneName });
					if (result.cancelled) return;
					if (!result.ok) {
						setError(result.error ?? t("new.clone.failed"));
						return;
					}
					path = result.path;
				} finally {
					off();
					cloneId.current = null;
					setProgress(null);
				}
			}
			await addProject(path);
			close();
			if (chatNow) startChat(path, firstMessage);
		} catch (failure) {
			setError(errorText(failure));
		} finally {
			setBusy(false);
		}
	};

	const advance = () => {
		if (!canAdvance) return;
		if (step < 2) {
			setError(null);
			setStep(step + 1);
		} else void finish();
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
		const inTextarea = event.target instanceof HTMLTextAreaElement;
		const inButton = event.target instanceof HTMLButtonElement;
		if ((inTextarea || inButton) && !(event.metaKey || event.ctrlKey)) return;
		event.preventDefault();
		advance();
	};

	const openExisting = async () => {
		if (!folder) return;
		try {
			await addProject(folder);
			close();
		} catch (failure) {
			toast({ tone: "err", message: t("open.failed"), description: errorText(failure) });
		}
	};

	const titles = [t("new.step.where"), t("new.step.details"), t("new.step.firstChat")];
	// Next slides the new step in from the right, Back from the left.
	const [travel, setTravel] = useState<{ step: number; direction: 1 | -1 }>({ step, direction: 1 });
	if (travel.step !== step) setTravel({ step, direction: step > travel.step ? 1 : -1 });

	return (
		<>
			<Dialog open onOpenChange={open => !open && requestClose()}>
				<DialogContent
					size="lg"
					title={titles[step]}
					description={step === 1 ? t(`new.details.${kind}.description`) : step === 2 ? t("new.firstChat.description") : t("new.where.description")}
					onKeyDown={onKeyDown}
					onEscapeKeyDown={event => {
						event.preventDefault();
						requestClose();
					}}
					footer={
						<>
							{step > 0 && (
								<Button variant="ghost" className="mr-auto" disabled={busy} onClick={() => setStep(step - 1)}>
									{t("new.back")}
								</Button>
							)}
							<Button variant="secondary" onClick={requestClose}>
								{t("new.cancel")}
							</Button>
							<Button variant="primary" disabled={!canAdvance} loading={busy && !progress} onClick={advance}>
								{step < 2 ? t("new.next") : kind === "existing" ? t("new.open") : t("new.create")}
							</Button>
						</>
					}
				>
					<div className="mb-4 flex items-center gap-3">
						<StepDots total={3} current={step} />
						<span className="text-sm text-fg-muted">{t("new.stepOf", { step: step + 1, total: 3 })}</span>
					</div>

					<PresenceSwap swapKey={step === 1 ? `1-${kind}` : step} variant="slide" direction={travel.direction}>

					{step === 0 && (
						<fieldset className="m-0 flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border p-0">
							<legend className="sr-only">{titles[0]}</legend>
							{KINDS.map(option => (
								<label
									key={option}
									className={cn(
										"flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2.5",
										"transition-colors duration-(--dur-fast) hover:bg-hover",
										"has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-ring",
										kind === option && "bg-accent-muted hover:bg-accent-muted",
									)}
								>
									<input
										type="radio"
										name="project-kind"
										value={option}
										checked={kind === option}
										onChange={() => setKind(option)}
										className="size-4 shrink-0 accent-(--accent)"
									/>
									<span className="min-w-0">
										<span className="block text-md font-medium text-fg">{t(`new.kind.${option}.title`)}</span>
										<span className="block text-sm text-fg-muted">{t(`new.kind.${option}.body`)}</span>
									</span>
								</label>
							))}
						</fieldset>
					)}

					{step === 1 && kind === "empty" && (
						<div className="flex flex-col gap-4">
							<Input
								autoFocus
								label={t("new.name.label")}
								placeholder={t("new.name.placeholder")}
								value={name}
								onChange={event => setName(event.currentTarget.value)}
								error={nameError(nameCheck.result, t)}
								description={nameCheck.result?.ok ? nameCheck.result.path : undefined}
								trailing={nameCheck.pending ? <Spinner size={12} /> : nameCheck.result?.ok ? <Check className="size-4 text-ok" aria-hidden /> : null}
							/>
							<CheckFailure message={nameCheck.error && t("new.checkFailed.name", { reason: nameCheck.error })} />
							<LocationRow parent={parent} onPick={() => setBrowsing("parent")} />
						</div>
					)}

					{step === 1 && kind === "existing" && (
						<div className="flex flex-col gap-4">
							<div className="flex items-center gap-2">
								<div className="min-w-0 flex-1 truncate rounded-md border border-border bg-inset px-2.5 py-1.5 font-mono text-sm text-fg-muted" title={folder ?? undefined}>
									{folder ?? t("new.existing.none")}
								</div>
								<Button
									autoFocus
									icon={<FolderOpen />}
									onClick={() => setBrowsing("existing")}
								>
									{t("new.existing.choose")}
								</Button>
							</div>
							<Expand open={Boolean(alreadyProject)}>
								<div role="status" className="flex items-center gap-3 rounded-md bg-warn-bg px-3 py-2 text-md text-fg">
									<Warning className="size-4 shrink-0 text-warn" aria-hidden />
									<span className="flex-1">{t("new.existing.already")}</span>
									<Button size="sm" onClick={() => void openExisting()}>
										{t("new.open")}
									</Button>
								</div>
							</Expand>
							{recent && recent.length > 0 && (
								<div>
									<h3 className="mb-1.5 text-sm font-medium text-fg-muted">{t("new.existing.recent")}</h3>
									<ul className="flex flex-col gap-0.5" aria-label={t("new.existing.recent")}>
										{recent.slice(0, 5).map(entry => (
											<li key={entry.path}>
												<button
													type="button"
													disabled={!entry.exists}
													aria-pressed={folder === entry.path}
													onClick={() => setFolder(entry.path)}
													className={cn(
														"flex h-9 w-full items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45",
														folder === entry.path && "bg-selected",
													)}
												>
													<Folder className="size-4 shrink-0 text-fg-muted" aria-hidden />
													<span className="shrink-0 text-md font-medium text-fg">{entry.name}</span>
													<span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-faint">{entry.path}</span>
													{folder === entry.path && <Check className="size-4 shrink-0 text-accent" aria-hidden />}
												</button>
											</li>
										))}
									</ul>
								</div>
							)}
						</div>
					)}

					{step === 1 && kind === "clone" && (
						<div className="flex flex-col gap-4">
							<Input
								autoFocus
								label={t("new.clone.url")}
								placeholder="https://github.com/owner/repo"
								value={url}
								spellCheck={false}
								onChange={event => {
									setUrl(event.currentTarget.value);
									setCloneName(null);
								}}
								error={remoteError(remote.result, t)}
								trailing={remote.pending ? <Spinner size={12} /> : null}
							/>
							<CheckFailure message={remote.error && t("new.checkFailed.link", { reason: remote.error })} />
							{remote.result?.ok && (
								<p role="status" className="-mt-2 flex items-center gap-1.5 text-sm text-ok">
									<Check className="size-3.5" aria-hidden />
									{t("new.clone.found", { label: remote.result.label })}
								</p>
							)}
							{remote.result?.ok && (
								<Input
									label={t("new.clone.folder")}
									value={effectiveCloneName}
									onChange={event => setCloneName(event.currentTarget.value)}
									error={nameError(cloneCheck.result, t)}
									description={cloneCheck.result?.ok ? cloneCheck.result.path : undefined}
								/>
							)}
							{remote.result?.ok && <CheckFailure message={cloneCheck.error && t("new.checkFailed.name", { reason: cloneCheck.error })} />}
							<LocationRow parent={parent} onPick={() => setBrowsing("parent")} />
						</div>
					)}

					{step === 2 && (
						<div className="flex flex-col gap-4">
							<Switch label={t("new.firstChat.toggle")} checked={chatNow} onCheckedChange={setChatNow} />
							<Expand open={chatNow}>
								<Textarea
									autoFocus
									label={t("new.firstChat.message")}
									description={t("new.firstChat.hint")}
									placeholder={t("new.firstChat.placeholder")}
									value={firstMessage}
									onChange={event => setFirstMessage(event.currentTarget.value)}
									minRows={3}
									maxRows={8}
								/>
							</Expand>
							{kind === "clone" && progress && (
								<div className="flex items-end gap-3">
									<Progress className="flex-1" value={progress.overall} showValue aria-label={t(`new.clone.phase.${progress.phase}`)} />
									<Button size="sm" variant="secondary" onClick={() => void cancelClone()}>
										{t("new.cancel")}
									</Button>
								</div>
							)}
						</div>
					)}

					</PresenceSwap>

					<Expand open={Boolean(error)}>
						<p role="alert" className="mt-4 flex items-start gap-2 rounded-md bg-err-bg px-3 py-2 text-sm text-err">
							<WarningCircle className="mt-px size-4 shrink-0" aria-hidden />
							<span className="whitespace-pre-wrap break-words">{error}</span>
						</p>
					</Expand>
				</DialogContent>
			</Dialog>
			<FolderBrowserDialog
				open={browsing !== null}
				title={browsing === "existing" ? t("open.pickerTitle") : t("new.location.picker")}
				initialPath={browsing === "existing" ? (folder ?? undefined) : parent}
				confirmLabel={name => t("browser.useFolder", { name })}
				onConfirm={path => {
					if (browsing === "existing") setFolder(path);
					else setParentDir(path);
					setBrowsing(null);
				}}
				onCancel={() => setBrowsing(null)}
			/>
			<Dialog open={confirmClose} onOpenChange={setConfirmClose}>
				<DialogContent
					size="sm"
					destructive
					title={t(busy ? "new.discard.titleBusy" : "new.discard.title")}
					description={t(busy ? "new.discard.bodyBusy" : "new.discard.body")}
					footer={
						<>
							<Button variant="secondary" onClick={() => setConfirmClose(false)}>
								{t("new.discard.keep")}
							</Button>
							<Button
								variant="danger"
								onClick={() => {
									void cancelClone();
									setConfirmClose(false);
									close();
								}}
							>
								{t("new.discard.confirm")}
							</Button>
						</>
					}
				/>
			</Dialog>
		</>
	);
}

function LocationRow({ parent, onPick }: { parent: string | undefined; onPick(): void }): ReactNode {
	const { t } = useTranslation("projects");
	const id = useId();
	return (
		<div className="flex flex-col gap-1.5">
			<span id={id} className="text-md font-medium text-fg">
				{t("new.location.label")}
			</span>
			<div className="flex items-center gap-2" role="group" aria-labelledby={id}>
				<div className="min-w-0 flex-1 truncate rounded-md border border-border bg-inset px-2.5 py-1.5 font-mono text-sm text-fg-muted" title={parent}>
					{parent ?? "…"}
				</div>
				<Button icon={<FolderOpen />} onClick={onPick}>
					{t("new.location.change")}
				</Button>
			</div>
			{parent && <span className="text-sm text-fg-faint">{t("new.location.inside", { name: folderName(parent) })}</span>}
		</div>
	);
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

function nameError(check: ProjectNameCheck | null, t: Translate): string | undefined {
	if (!check || check.ok || !check.problem) return undefined;
	return t(`new.problem.${check.problem}`);
}

function remoteError(check: RemoteCheck | null, t: Translate): string | undefined {
	if (!check || check.ok || !check.problem) return undefined;
	return t(`new.clone.problem.${check.problem}`, { label: check.label ?? check.input });
}
