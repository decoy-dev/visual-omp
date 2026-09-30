import type { GhCheck, GitBranches, GitStatus } from "@shared/contracts/git";
import {
	ExternalLink,
	FolderGit2,
	GitBranchPlus,
	GitCommitHorizontal,
	GitPullRequest,
	GitPullRequestCreate,
	RefreshCw,
	Wrench,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PaneProps } from "@/registry/slots";
import { useApp } from "@/state/app";
import {
	Button,
	cn,
	Dialog,
	DialogContent,
	Input,
	Menu,
	MenuCheckboxItem,
	MenuContent,
	MenuItem,
	MenuLabel,
	MenuRadioGroup,
	MenuRadioItem,
	MenuSeparator,
	MenuSub,
	MenuTrigger,
	Popover,
	PopoverContent,
	PopoverTrigger,
	Tooltip,
} from "@/ui";
import { focusRing } from "@/ui/styles";
import { backToMainCopy, createBranch, fixCi, initGit, startWorktree, switchBranch } from "./actions";
import { type CiState, ciState } from "./format";
import { refreshGit, useGit } from "./store";

/** Status-bar button: 24px, xs text, ghost, truncates instead of wrapping. */
const itemClass = cn(
	"inline-flex h-6 min-w-0 max-w-[240px] shrink items-center gap-1.5 rounded-sm px-1.5 text-xs text-fg-muted",
	"transition-colors duration-(--dur-fast) hover:bg-hover hover:text-fg data-[state=open]:bg-selected data-[state=open]:text-fg",
	focusRing,
);

const MAX_LOCAL_BRANCHES = 12;

/** Tracked changes that make switching branches unsafe (untracked files travel along). */
const hasUnsavedChanges = (status: GitStatus) =>
	status.totals.staged + status.totals.unstaged + status.totals.conflicted > 0;

function MenuNote({ children }: { children: ReactNode }) {
	return <p className="max-w-[280px] px-2 pb-1.5 pt-0.5 text-sm text-fg-muted">{children}</p>;
}

function NewBranchDialog({ cwd, open, onOpenChange }: { cwd: string; open: boolean; onOpenChange(open: boolean): void }) {
	const { t } = useTranslation("git");
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const submit = async () => {
		if (!name.trim() || busy) return;
		setBusy(true);
		const ok = await createBranch(cwd, name);
		setBusy(false);
		if (ok) {
			setName("");
			onOpenChange(false);
		}
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				size="sm"
				title={t("newBranch.title")}
				description={t("newBranch.description")}
				footer={
					<>
						<Button variant="ghost" onClick={() => onOpenChange(false)}>
							{t("newBranch.cancel")}
						</Button>
						<Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void submit()}>
							{t("newBranch.create")}
						</Button>
					</>
				}
			>
				<form
					onSubmit={event => {
						event.preventDefault();
						void submit();
					}}
				>
					<Input
						autoFocus
						label={t("newBranch.label")}
						placeholder={t("newBranch.placeholder")}
						value={name}
						onChange={event => setName(event.currentTarget.value.replace(/\s/g, "-"))}
						boxClassName="font-mono"
						spellCheck={false}
					/>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** ⎇ branch name; opens the branch menu (switch, new branch, separate copy, commit, PR). */
export function BranchItem({ projectPath }: PaneProps) {
	const { t } = useTranslation("git");
	const git = useGit(projectPath);
	const [branches, setBranches] = useState<GitBranches | null>(null);
	const [newBranchOpen, setNewBranchOpen] = useState(false);
	if (!projectPath || !git) return null;
	const cwd = projectPath;
	const openSheet = useApp.getState().openSheet;

	if (git.loading) {
		return (
			<span className={cn(itemClass, "pointer-events-none text-fg-faint")} aria-live="polite">
				{t("branch.loading")}
			</span>
		);
	}

	if (!git.repo?.isRepo || !git.status) {
		return (
			<Menu>
				<Tooltip content={t("branch.notRepoTooltip")}>
					<MenuTrigger className={cn(itemClass, "text-fg-faint")}>
						<span aria-hidden className="font-mono">
							⎇
						</span>
						{t("branch.notRepo")}
					</MenuTrigger>
				</Tooltip>
				<MenuContent side="top">
					<MenuItem icon={<FolderGit2 />} onSelect={() => void initGit(cwd)}>
						{t("branch.initGit")}
					</MenuItem>
					<MenuNote>{t("branch.initGitHint")}</MenuNote>
				</MenuContent>
			</Menu>
		);
	}

	const { status, repo, pr } = git;
	const dirty = hasUnsavedChanges(status);
	const label = status.branch ?? (status.head ? status.head.slice(0, 7) : t("branch.detached"));
	const localNames = new Set(branches?.local.map(entry => entry.name));
	const remoteOnly =
		branches?.remote.filter(entry => {
			const name = entry.name.slice((entry.remote?.length ?? -1) + 1);
			return !localNames.has(name) && name !== status.branch;
		}) ?? [];
	const locals = branches?.local.slice(0, MAX_LOCAL_BRANCHES) ?? [];

	return (
		<>
			<Menu
				onOpenChange={open => {
					if (open) void window.vomp.invoke("git:branches", cwd).then(setBranches, () => setBranches(null));
				}}
			>
				<Tooltip content={status.branch ? t("branch.tooltip", { name: status.branch }) : t("branch.detachedTooltip")}>
					<MenuTrigger className={itemClass} data-tour="git-branch">
						<span aria-hidden className="font-mono text-fg-faint">
							⎇
						</span>
						<span className="truncate font-mono">{label}</span>
						{repo.isLinkedWorktree && <span className="sr-only">{t("branch.worktree")}</span>}
					</MenuTrigger>
				</Tooltip>
				<MenuContent side="top" className="max-h-[70vh] w-[300px] overflow-y-auto">
					<MenuLabel>{t("branch.switchTo")}</MenuLabel>
					{dirty && <MenuNote>{t("branch.dirtyNote")}</MenuNote>}
					{status.detached && <MenuNote>{t("branch.detachedNote")}</MenuNote>}
					<MenuRadioGroup
						value={status.branch ?? ""}
						onValueChange={name => {
							if (name !== status.branch) void switchBranch(cwd, name);
						}}
					>
						{locals.map(entry => {
							const elsewhere = entry.worktreePath !== null && !entry.current;
							return (
								<MenuRadioItem key={entry.ref} value={entry.name} disabled={!entry.current && (dirty || elsewhere)}>
									<span className="font-mono">{entry.name}</span>
									{elsewhere && <span className="ml-2 text-xs text-fg-faint">{t("branch.inOtherCopy")}</span>}
								</MenuRadioItem>
							);
						})}
					</MenuRadioGroup>
					{branches && locals.length <= 1 && remoteOnly.length === 0 && <MenuNote>{t("branch.noOtherBranches")}</MenuNote>}
					{remoteOnly.length > 0 && (
						<MenuSub label={t("branch.onGithub")} disabled={dirty} contentClassName="max-h-[60vh] overflow-y-auto">
							{remoteOnly.map(entry => (
								<MenuItem key={entry.ref} onSelect={() => void switchBranch(cwd, entry.name)}>
									<span className="font-mono">{entry.name}</span>
								</MenuItem>
							))}
						</MenuSub>
					)}
					<MenuSeparator />
					<MenuItem icon={<GitBranchPlus />} onSelect={() => setNewBranchOpen(true)}>
						{t("branch.newBranch")}
					</MenuItem>
						<MenuCheckboxItem
							checked={repo.isLinkedWorktree}
							disabled={!repo.hasCommits}
							onCheckedChange={() => void (repo.isLinkedWorktree ? backToMainCopy(cwd) : startWorktree(cwd))}
						>
							{repo.isLinkedWorktree ? t("branch.worktreeBack") : t("branch.worktree")}
						</MenuCheckboxItem>
					<MenuNote>{t("branch.worktreeHint")}</MenuNote>
					<MenuSeparator />
					<MenuItem
						icon={<GitCommitHorizontal />}
						disabled={status.totals.files === 0}
						onSelect={() => openSheet("git-commit", { cwd })}
					>
						{t("branch.commit")}
					</MenuItem>
					{pr ? (
						<MenuItem icon={<ExternalLink />} onSelect={() => void window.vomp.invoke("app:openExternal", pr.url)}>
							{t("branch.openPr", { number: pr.number })}
						</MenuItem>
					) : (
						<MenuItem
							icon={<GitPullRequestCreate />}
							disabled={!repo.github || !status.branch || !repo.hasCommits}
							onSelect={() => openSheet("git-pr", { cwd })}
						>
							{t("branch.pr")}
						</MenuItem>
					)}
					<MenuItem icon={<RefreshCw />} onSelect={() => refreshGit(cwd, { pr: true })}>
						{t("branch.refresh")}
					</MenuItem>
				</MenuContent>
			</Menu>
			<NewBranchDialog cwd={cwd} open={newBranchOpen} onOpenChange={setNewBranchOpen} />
		</>
	);
}

/** `+12 −3` across all changed files; opens the Diff pane. Hidden when the tree is clean. */
export function ChangesItem({ projectPath }: PaneProps) {
	const { t } = useTranslation("git");
	const git = useGit(projectPath);
	const totals = git?.status?.totals;
	if (!totals || totals.files === 0) return null;
	return (
		<Tooltip content={t("changes.tooltip", { files: totals.files, additions: totals.additions, deletions: totals.deletions })}>
			<button type="button" className={cn(itemClass, "font-mono tabular-nums")} onClick={() => useApp.getState().showPane("diff")}>
				<span aria-hidden className="text-diff-add-text">
					+{totals.additions}
				</span>
				<span aria-hidden className="text-diff-del-text">
					−{totals.deletions}
				</span>
				<span className="sr-only">{t("changes.srLabel", { additions: totals.additions, deletions: totals.deletions })}</span>
			</button>
		</Tooltip>
	);
}

const CI_GLYPH: Record<CiState, { glyph: string; tone: string }> = {
	pass: { glyph: "✓", tone: "text-ok" },
	pending: { glyph: "▲", tone: "text-warn" },
	fail: { glyph: "✕", tone: "text-err" },
	none: { glyph: "•", tone: "text-fg-faint" },
};

/** Failures first, then running, so the checks that need attention are at the top. */
const CHECK_ORDER: Record<GhCheck["bucket"], number> = { fail: 0, pending: 1, pass: 2, cancel: 3, skipping: 4 };

const CHECK_TONE: Record<GhCheck["bucket"], string> = {
	pass: "text-ok",
	fail: "text-err",
	pending: "text-warn",
	skipping: "text-fg-faint",
	cancel: "text-fg-faint",
};

/** PR number with a CI glyph; popover lists checks. A "Fix CI" button sits beside it on failure. */
export function PrItem({ projectPath }: PaneProps) {
	const { t } = useTranslation("git");
	const git = useGit(projectPath);
	const pr = git?.pr;
	if (!projectPath || !pr) return null;
	const cwd = projectPath;
	const ci = ciState(pr);
	const stateText =
		pr.state === "merged" ? t("pr.merged") : pr.state === "closed" ? t("pr.closed") : pr.draft ? `${t("pr.draft")} · ${t(`pr.${ci}`)}` : t(`pr.${ci}`);
	const glyph = pr.state === "open" ? CI_GLYPH[ci] : { glyph: pr.state === "merged" ? "✓" : "•", tone: "text-fg-faint" };
	const { passing, failing, pending } = pr.checksSummary;
	return (
		<>
			<Popover>
				<Tooltip content={t("pr.tooltip", { number: pr.number, title: pr.title, state: stateText })}>
					<PopoverTrigger className={itemClass}>
						<span aria-hidden className={cn("font-mono", glyph.tone)}>
							{glyph.glyph}
						</span>
						<span className="font-mono">{t("pr.chip", { number: pr.number })}</span>
						<span className="sr-only">{stateText}</span>
					</PopoverTrigger>
				</Tooltip>
				<PopoverContent side="top" align="start" width={400}>
					<div className="flex items-start gap-2">
						<GitPullRequest aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-muted" />
						<div className="min-w-0 flex-1">
							<p className="truncate font-medium text-fg">{pr.title}</p>
							<p className="text-sm text-fg-muted">
								#{pr.number} · {stateText}
							</p>
						</div>
					</div>
					{pr.checks.length > 0 && (
						<>
							<p className="mt-3 text-sm text-fg-muted">{t("pr.summary", { passing, failing, pending })}</p>
							<ul className="mt-1.5 max-h-48 space-y-0.5 overflow-y-auto" aria-label={t("pr.checksHeading")}>
								{[...pr.checks].sort((a, b) => CHECK_ORDER[a.bucket] - CHECK_ORDER[b.bucket]).map(check => (
									<li key={`${check.workflow ?? ""}/${check.name}`} className="flex items-center gap-2 text-sm">
										<span aria-hidden className={cn("w-3 font-mono", CHECK_TONE[check.bucket])}>
											{check.bucket === "pass" ? "✓" : check.bucket === "fail" ? "✕" : check.bucket === "pending" ? "▲" : "–"}
										</span>
										<span className="min-w-0 flex-1 truncate text-fg">
											{check.workflow ? `${check.workflow} / ${check.name}` : check.name}
										</span>
										<span className="sr-only">{check.bucket}</span>
									</li>
								))}
							</ul>
						</>
					)}
					<div className="mt-3 flex flex-wrap items-center justify-end gap-2">
						<Button size="sm" variant="ghost" icon={<RefreshCw />} onClick={() => refreshGit(cwd, { pr: true })}>
							{t("pr.refresh")}
						</Button>
						{ci === "fail" && pr.state === "open" && (
							<Button size="sm" variant="secondary" icon={<Wrench />} onClick={() => void fixCi(cwd)}>
								{t("pr.fixCi")}
							</Button>
						)}
						<Button
							size="sm"
							variant="primary"
							icon={<ExternalLink />}
							onClick={() => void window.vomp.invoke("app:openExternal", pr.url)}
						>
							{t("pr.openOnGithub")}
						</Button>
					</div>
				</PopoverContent>
			</Popover>
			{ci === "fail" && pr.state === "open" && (
				<Tooltip content={t("pr.fixCiTooltip")}>
					<button type="button" className={cn(itemClass, "text-err hover:text-err")} onClick={() => void fixCi(cwd)}>
						<Wrench aria-hidden className="size-3.5" />
						{t("pr.fixCi")}
					</button>
				</Tooltip>
			)}
		</>
	);
}
