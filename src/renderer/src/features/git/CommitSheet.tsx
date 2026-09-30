import type { GitChangeKind, GitCommitResult, GitFileStatus, GitStatus } from "@shared/contracts/git";
import { GitCommitHorizontal, Sparkles, Upload, WandSparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SheetProps } from "@/registry/slots";
import { useApp } from "@/state/app";
import { Button, Checkbox, Chip, type ChipTone, Progress, Sheet, SheetContent, Textarea, Tooltip, toast } from "@/ui";
import { shortSha } from "./format";
import { refreshGit, useGit } from "./store";

export interface GitSheetProps {
	/** Project folder; defaults to the active project. */
	cwd?: string;
}

const KIND_TONE: Record<GitChangeKind, ChipTone> = {
	modified: "blue",
	typechange: "blue",
	added: "ok",
	untracked: "ok",
	copied: "ok",
	deleted: "err",
	renamed: "neutral",
	conflicted: "warn",
};

/** Progress lines kept on screen while omp works. */
const MAX_PROGRESS_LINES = 6;

type Busy = null | "generate" | "commit" | "push" | "ai";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The staging `omp commit` needs so it sees exactly the chosen files: nothing extra when every file
 * is chosen and nothing is staged yet (omp then takes everything itself).
 */
async function stageSelection(cwd: string, status: GitStatus, paths: string[]): Promise<void> {
	if (paths.length === status.files.length && status.totals.staged === 0) return;
	await window.vomp.invoke("git:stageOnly", cwd, paths);
}

function FileRow({
	file,
	checked,
	disabled,
	onChange,
}: {
	file: GitFileStatus;
	checked: boolean;
	disabled: boolean;
	onChange(checked: boolean): void;
}) {
	const { t } = useTranslation("git");
	return (
		<li className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover">
			<Checkbox
				checked={checked}
				disabled={disabled}
				onCheckedChange={onChange}
				className="min-w-0 flex-1"
				label={
					<span className="block truncate text-left font-mono text-sm [direction:rtl]" title={file.path}>
						<bdi>{file.path}</bdi>
					</span>
				}
			/>
			<Chip tone={KIND_TONE[file.kind]} className="h-5 px-2">
				{t(`commit.kind.${file.kind}`)}
			</Chip>
			<span className="w-20 shrink-0 text-right font-mono text-xs tabular-nums">
				{file.binary ? (
					<span className="text-fg-faint">bin</span>
				) : (
					<>
						<span className="text-diff-add-text">+{file.additions ?? 0}</span>{" "}
						<span className="text-diff-del-text">−{file.deletions ?? 0}</span>
					</>
				)}
			</span>
		</li>
	);
}

export function CommitSheet({ props, close }: SheetProps<GitSheetProps>) {
	const { t } = useTranslation("git");
	const cwd = props.cwd ?? useApp.getState().activeProject ?? "";
	const git = useGit(cwd || null);
	const status = git?.status ?? null;
	const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState<Busy>(null);
	const [progress, setProgress] = useState<string[]>([]);
	const [note, setNote] = useState<string | null>(null);
	const listening = useRef(false);

	useEffect(
		() =>
			window.vomp.on("git:commitProgress", event => {
				if (!listening.current || event.cwd !== cwd) return;
				setProgress(lines => [...lines, event.line].slice(-MAX_PROGRESS_LINES));
			}),
		[cwd],
	);

	const files = status?.files ?? [];
	const selected = files.filter(file => !excluded.has(file.path)).map(file => file.path);
	const conflicted = (status?.totals.conflicted ?? 0) > 0;
	const canCommit = !busy && selected.length > 0 && !conflicted;
	const allChecked = files.length > 0 && selected.length === files.length;

	const withProgress = async <T,>(kind: Busy, run: () => Promise<T>): Promise<T> => {
		setBusy(kind);
		setProgress([]);
		listening.current = true;
		try {
			return await run();
		} finally {
			listening.current = false;
			setBusy(null);
			refreshGit(cwd);
		}
	};

	const announce = (result: GitCommitResult) => {
		if (result.commits.length === 0) {
			toast({ tone: "warn", message: t("commit.nothingCommitted"), description: result.log || undefined });
			return;
		}
		const shas = result.commits.map(commit => shortSha(commit.sha)).join(", ");
		toast({
			tone: "ok",
			message: t("commit.done", { count: result.commits.length, shas }),
			description: [result.commits.map(commit => commit.subject).join("\n"), result.pushed ? t("commit.pushed") : ""]
				.filter(Boolean)
				.join("\n"),
		});
		refreshGit(cwd, { pr: result.pushed });
		close();
	};

	const generate = async () => {
		if (!status) return;
		setNote(null);
		try {
			const draft = await withProgress("generate", async () => {
				await stageSelection(cwd, status, selected);
				return window.vomp.invoke("git:commitMessage", cwd);
			});
			const [first] = draft.commits;
			if (first) setMessage(first.message);
			const notes = [
				draft.commits.length > 1 ? t("commit.splitProposal", { count: draft.commits.length }) : null,
				draft.usedFallback ? t("commit.fallbackNote") : null,
			].filter(Boolean);
			setNote(notes.length ? notes.join(" ") : null);
		} catch (error) {
			if (errorText(error) !== "Cancelled") toast({ tone: "err", message: t("commit.generateFailed"), description: errorText(error) });
		}
	};

	const commit = async (push: boolean) => {
		if (!status || !message.trim()) return;
		try {
			const result = await withProgress(push ? "push" : "commit", () =>
				window.vomp.invoke("git:commit", cwd, { message, stage: allChecked ? "all" : selected, push }),
			);
			announce(result);
		} catch (error) {
			toast({ tone: "err", message: t("commit.failed"), description: errorText(error) });
		}
	};

	const letOmpCommit = async () => {
		if (!status) return;
		try {
			const result = await withProgress("ai", async () => {
				await stageSelection(cwd, status, selected);
				return window.vomp.invoke("git:commitAi", cwd);
			});
			announce(result);
		} catch (error) {
			if (errorText(error) !== "Cancelled") toast({ tone: "err", message: t("commit.failed"), description: errorText(error) });
		}
	};

	const running = busy === "generate" || busy === "ai";
	const footer = (
		<>
			<Tooltip content={t("commit.letOmpHint")}>
				<Button
					className="mr-auto"
					variant="secondary"
					icon={<Sparkles />}
					loading={busy === "ai"}
					disabled={!canCommit}
					onClick={() => void letOmpCommit()}
				>
					{t("commit.letOmp")}
				</Button>
			</Tooltip>
			{running ? (
				<Button variant="ghost" onClick={() => void window.vomp.invoke("git:commitCancel", cwd)}>
					{t("commit.stop")}
				</Button>
			) : (
				<Button variant="ghost" onClick={close}>
					{t("commit.cancel")}
				</Button>
			)}
			{git?.repo?.hasRemote && (
				<Button
					variant="secondary"
					icon={<Upload />}
					loading={busy === "push"}
					disabled={!canCommit || !message.trim()}
					onClick={() => void commit(true)}
				>
					{t("commit.commitPush")}
				</Button>
			)}
			<Button
				variant="primary"
				icon={<GitCommitHorizontal />}
				loading={busy === "commit"}
				disabled={!canCommit || !message.trim()}
				onClick={() => void commit(false)}
			>
				{t("commit.commit")}
			</Button>
		</>
	);

	return (
		<Sheet
			open
			onOpenChange={open => {
				if (!open && !busy) close();
			}}
		>
			<SheetContent
				width={600}
				title={t("commit.title")}
				description={status?.branch ? t("commit.branch", { name: status.branch }) : t("commit.description")}
				footer={footer}
				bodyClassName="flex flex-col gap-4"
				onOpenAutoFocus={event => {
					// Start in the message field (the close button otherwise takes focus first).
					const field = document.getElementById("git-commit-message");
					if (!field) return;
					event.preventDefault();
					field.focus();
				}}
			>
				{files.length === 0 ? (
					<p className="py-8 text-center text-fg-muted">{git?.loading ? "…" : t("commit.noChanges")}</p>
				) : (
					<section aria-labelledby="git-commit-files" className="flex min-h-0 flex-col">
						<div className="flex items-center justify-between gap-2 pb-1.5">
							<h3 id="git-commit-files" className="text-sm font-semibold text-fg">
								{t("commit.filesHeading")}
							</h3>
							<span className="text-xs text-fg-muted" aria-live="polite">
								{t("commit.selected", { count: selected.length, total: files.length })}
							</span>
						</div>
						<div className="rounded-lg border border-border bg-panel">
							<div className="border-b border-border px-2 py-1.5">
								<Checkbox
									label={<span className="text-sm">{t("commit.selectAll")}</span>}
									checked={allChecked}
									indeterminate={selected.length > 0 && !allChecked}
									disabled={Boolean(busy)}
									onCheckedChange={checked => setExcluded(checked ? new Set() : new Set(files.map(file => file.path)))}
								/>
							</div>
							<ul className="max-h-[280px] overflow-y-auto p-1">
								{files.map(file => (
									<FileRow
										key={file.path}
										file={file}
										checked={!excluded.has(file.path)}
										disabled={Boolean(busy)}
										onChange={checked =>
											setExcluded(current => {
												const next = new Set(current);
												if (checked) next.delete(file.path);
												else next.add(file.path);
												return next;
											})
										}
									/>
								))}
							</ul>
						</div>
						{conflicted && <p className="mt-2 text-sm text-warn">{t("commit.conflicts")}</p>}
					</section>
				)}

				{files.length > 0 && (
					<section className="flex flex-col gap-2">
						<div className="flex items-center justify-between gap-2">
							<label htmlFor="git-commit-message" className="text-sm font-semibold text-fg">
								{t("commit.messageLabel")}
							</label>
							<Button
								size="sm"
								variant="ghost"
								icon={<WandSparkles />}
								loading={busy === "generate"}
								disabled={Boolean(busy) || selected.length === 0}
								onClick={() => void generate()}
							>
								{t("commit.writeWithOmp")}
							</Button>
						</div>
						<Textarea
							id="git-commit-message"
							minRows={4}
							maxRows={12}
							className="font-mono text-sm"
							placeholder={t("commit.messagePlaceholder")}
							value={message}
							disabled={running}
							onChange={event => setMessage(event.currentTarget.value)}
						/>
						{note && <p className="text-sm text-fg-muted">{note}</p>}
					</section>
				)}

				{running && (
					<section aria-live="polite" className="flex flex-col gap-2">
						<Progress aria-label={busy === "ai" ? t("commit.aiRunning") : t("commit.writing")} />
						<p className="text-sm text-fg-muted">{busy === "ai" ? t("commit.aiRunning") : t("commit.writing")}</p>
						{progress.length > 0 && (
							<pre
								aria-label={t("commit.progress")}
								className="max-h-32 overflow-hidden whitespace-pre-wrap rounded-md bg-inset p-2 font-mono text-xs text-fg-muted"
							>
								{progress.join("\n")}
							</pre>
						)}
					</section>
				)}
			</SheetContent>
		</Sheet>
	);
}
