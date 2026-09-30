import type { GhAuthStatus, GhPrCreateResult } from "@shared/contracts/git";
import type { GitBranchCommit, GitPrContext } from "@shared/contracts/git-workflow";
import { ArrowSquareOut, CaretRight, Copy, GitPullRequest, Key, PencilSimpleLine, Warning } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SheetProps } from "@/registry/slots";
import { useApp } from "@/state/app";
import {
	Button,
	cn,
	Expand,
	Input,
	PresenceSwap,
	Progress,
	Select,
	SelectItem,
	Sheet,
	SheetContent,
	Skeleton,
	Switch,
	Textarea,
	toast,
} from "@/ui";
import { connectGitHub } from "./actions";
import type { GitSheetProps } from "./CommitSheet";
import { prefillPr, shortSha } from "./format";
import { refreshGit, useGit } from "./store";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A tinted notice in the sheet body: icon, message, optional hint and actions. */
function Notice({ tone = "info", title, hint, children }: { tone?: "info" | "warn"; title: ReactNode; hint?: ReactNode; children?: ReactNode }) {
	return (
		<div className={cn("flex gap-3 rounded-md p-3", tone === "warn" ? "bg-warn-bg" : "bg-inset")} role={tone === "warn" ? "status" : undefined}>
			{tone === "warn" ? (
				<Warning aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
			) : (
				<GitPullRequest aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-muted" />
			)}
			<div className="min-w-0 flex-1">
				<p className="text-md text-fg">{title}</p>
				{hint && <p className="mt-0.5 text-sm text-fg-muted">{hint}</p>}
				{children && <div className="mt-2.5 flex flex-wrap gap-2">{children}</div>}
			</div>
		</div>
	);
}

export function PrSheet({ props, close }: SheetProps<GitSheetProps>) {
	const { t } = useTranslation("git");
	const cwd = props.cwd ?? useApp.getState().activeProject ?? "";
	const git = useGit(cwd || null);
	const status = git?.status ?? null;
	const [auth, setAuth] = useState<GhAuthStatus | null>(null);
	const [context, setContext] = useState<GitPrContext | null>(null);
	const [base, setBase] = useState<string | null>(null);
	const [commits, setCommits] = useState<GitBranchCommit[] | null>(null);
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	// Commits prefill the form until the user edits it; a ref so typing never refetches commits.
	const edited = useRef(false);
	const [draft, setDraft] = useState(false);
	const [writing, setWriting] = useState(false);
	const [creating, setCreating] = useState(false);
	const [created, setCreated] = useState<GhPrCreateResult | null>(null);
	const [authCheck, setAuthCheck] = useState(0);
	const [showCommits, setShowCommits] = useState(false);

	useEffect(() => {
		let live = true;
		setAuth(null);
		void window.vomp.invoke("gh:auth").then(result => live && setAuth(result));
		return () => {
			live = false;
		};
	}, [authCheck]);

	useEffect(() => {
		if (!cwd) return;
		let live = true;
		window.vomp.invoke("git:prContext", cwd).then(
			result => {
				if (!live) return;
				setContext(result);
				setBase(current => current ?? result.defaultBase);
			},
			error => live && toast({ tone: "err", message: t("createPr.failed"), description: errorText(error) }),
		);
		return () => {
			live = false;
		};
	}, [cwd, t]);

	useEffect(() => {
		if (!cwd || !context) return;
		let live = true;
		void window.vomp.invoke("git:branchCommits", cwd, base).then(
			list => {
				if (!live) return;
				setCommits(list);
				if (!edited.current) {
					const fill = prefillPr(context.branch, list);
					setTitle(fill.title);
					setBody(fill.body);
				}
			},
			() => live && setCommits([]),
		);
		return () => {
			live = false;
		};
	}, [cwd, context, base]);

	const writeWithOmp = async () => {
		setWriting(true);
		try {
			const result = await window.vomp.invoke("git:prWrite", cwd, base);
			setTitle(result.title);
			setBody(result.body);
			edited.current = true;
		} catch (error) {
			toast({ tone: "err", message: t("createPr.writeFailed"), description: errorText(error) });
		} finally {
			setWriting(false);
		}
	};

	const create = async () => {
		if (!title.trim()) return;
		setCreating(true);
		try {
			const result = await window.vomp.invoke("gh:prCreate", cwd, {
				title: title.trim(),
				body,
				draft,
				...(base ? { base } : {}),
			});
			setCreated(result);
			refreshGit(cwd, { pr: true });
		} catch (error) {
			toast({ tone: "err", message: t("createPr.failed"), description: errorText(error) });
		} finally {
			setCreating(false);
		}
	};

	const openUrl = (url: string) => void window.vomp.invoke("app:openExternal", url);
	const branch = status?.branch ?? context?.branch ?? null;

	let content: ReactNode;
	/** Which state the body shows; switching it crossfades the body. */
	let stage = "form";
	let footer: ReactNode = (
		<Button variant="ghost" onClick={close}>
			{t("createPr.cancel")}
		</Button>
	);

	if (created) {
		stage = "created";
		content = (
			<div className="flex flex-col items-center gap-3 py-8 text-center">
				<span className="inline-flex size-10 items-center justify-center rounded-full bg-ok-bg text-ok">
					<GitPullRequest aria-hidden className="size-5" />
				</span>
				<div>
					<p className="text-lg font-semibold text-fg">{t("createPr.doneTitle", { number: created.number })}</p>
					<p className="mt-1 text-md text-fg-muted">{t("createPr.doneHint")}</p>
				</div>
				<a
					href={created.url}
					onClick={event => {
						event.preventDefault();
						openUrl(created.url);
					}}
					className="break-all font-mono text-sm text-accent underline-offset-2 hover:underline"
				>
					{created.url}
				</a>
			</div>
		);
		footer = (
			<>
				<Button
					className="mr-auto"
					variant="ghost"
					icon={<Copy />}
					onClick={() =>
						void navigator.clipboard.writeText(created.url).then(() => toast({ tone: "ok", message: t("createPr.copied") }))
					}
				>
					{t("createPr.copyLink")}
				</Button>
				<Button variant="secondary" onClick={close}>
					{t("createPr.close")}
				</Button>
				<Button variant="primary" icon={<ArrowSquareOut />} onClick={() => openUrl(created.url)}>
					{t("createPr.openLink")}
				</Button>
			</>
		);
	} else if (!auth || !context || !status) {
		stage = "checking";
		content = (
			<div className="flex flex-col gap-3" aria-busy>
				<p className="text-sm text-fg-muted">{t("createPr.checking")}</p>
				<Skeleton className="h-8" />
				<Skeleton className="h-24" />
			</div>
		);
	} else if (!auth.installed) {
		stage = "noGh";
		content = (
			<Notice title={t("createPr.noGh")} hint={t("createPr.noGhHint")}>
				<Button size="sm" variant="primary" icon={<ArrowSquareOut />} onClick={() => openUrl("https://cli.github.com")}>
					{t("createPr.installGh")}
				</Button>
				<Button size="sm" variant="ghost" onClick={() => setAuthCheck(n => n + 1)}>
					{t("createPr.checkAgain")}
				</Button>
			</Notice>
		);
	} else if (!auth.loggedIn) {
		stage = "signIn";
		content = (
			<Notice title={t("createPr.notLoggedIn")} hint={t("createPr.notLoggedInHint")}>
				<Button
					size="sm"
					variant="primary"
					icon={<Key />}
					onClick={() => {
						close();
						void connectGitHub(cwd);
					}}
				>
					{t("createPr.connect")}
				</Button>
				<Button size="sm" variant="ghost" onClick={() => setAuthCheck(n => n + 1)}>
					{t("createPr.checkAgain")}
				</Button>
			</Notice>
		);
	} else if (!context.remote) {
		stage = "noRemote";
		content = <Notice tone="warn" title={t("createPr.noRemote")} />;
	} else if (!branch) {
		stage = "detached";
		content = <Notice tone="warn" title={t("createPr.detached")} />;
	} else if (status.unborn) {
		stage = "unborn";
		content = <Notice tone="warn" title={t("createPr.unborn")} />;
	} else if (git?.pr && git.pr.state === "open") {
		const existing = git.pr;
		stage = "existing";
		content = (
			<Notice title={t("createPr.existing")} hint={existing.title}>
				<Button size="sm" variant="primary" icon={<ArrowSquareOut />} onClick={() => openUrl(existing.url)}>
					{t("createPr.openExisting", { number: existing.number })}
				</Button>
			</Notice>
		);
	} else {
		const uncommitted = status.totals.files;
		const needsPush = !status.upstream || status.ahead > 0;
		content = (
			<div className="flex flex-col gap-4">
				{auth.account && <p className="text-sm text-fg-muted">{t("createPr.connectedAs", { login: auth.account })}</p>}
				{uncommitted > 0 && (
					<Notice tone="warn" title={t("createPr.uncommitted", { count: uncommitted })}>
						<Button size="sm" variant="secondary" onClick={() => useApp.getState().openSheet("git-commit", { cwd })}>
							{t("createPr.commitFirst")}
						</Button>
					</Notice>
				)}
				<div className="flex flex-col gap-1.5">
					<label htmlFor="git-pr-base" className="text-sm font-medium text-fg">
						{t("createPr.baseLabel")}
					</label>
					<Select
						id="git-pr-base"
						value={base ?? undefined}
						onValueChange={value => setBase(value)}
						disabled={context.bases.length === 0 || creating}
						className="w-full font-mono"
					>
						{context.bases.map(name => (
							<SelectItem key={name} value={name} className="font-mono">
								{name}
							</SelectItem>
						))}
					</Select>
				</div>
				<Input
					label={t("createPr.titleLabel")}
					value={title}
					disabled={writing || creating}
					onChange={event => {
						setTitle(event.currentTarget.value);
						edited.current = true;
					}}
				/>
				<div className="flex flex-col gap-1.5">
					<div className="flex items-center justify-between gap-2">
						<label htmlFor="git-pr-body" className="text-sm font-medium text-fg">
							{t("createPr.bodyLabel")}
						</label>
						<Button
							size="sm"
							variant="ghost"
							icon={<PencilSimpleLine />}
							loading={writing}
							disabled={creating || !commits?.length}
							onClick={() => void writeWithOmp()}
						>
							{t("createPr.writeWithOmp")}
						</Button>
					</div>
					<Textarea
						id="git-pr-body"
						minRows={6}
						maxRows={14}
						className="text-sm"
						placeholder={t("createPr.bodyPlaceholder")}
						value={body}
						disabled={writing || creating}
						onChange={event => {
							setBody(event.currentTarget.value);
							edited.current = true;
						}}
					/>
					<Expand open={writing}>
						<div aria-live="polite" className="flex flex-col gap-1.5 pt-0.5">
							<Progress aria-label={t("createPr.writing")} />
							<p className="text-sm text-fg-muted">{t("createPr.writing")}</p>
						</div>
					</Expand>
				</div>
				<Switch label={t("createPr.draft")} description={t("createPr.draftHint")} checked={draft} onCheckedChange={setDraft} />
				{commits && commits.length > 0 && (
					<div className="text-sm">
						<button
							type="button"
							aria-expanded={showCommits}
							className="-ml-1 flex items-center gap-1 rounded-sm px-1 text-fg-muted outline-none hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
							onClick={() => setShowCommits(open => !open)}
						>
							<CaretRight aria-hidden className={cn("size-3.5 transition-transform duration-(--dur) ease-(--ease-out-quart)", showCommits && "rotate-90")} />
							{t("createPr.commitsHeading", { count: commits.length })}
						</button>
						<Expand open={showCommits}>
							<ul className="space-y-1 pt-2 pl-5">
								{commits.map(commit => (
									<li key={commit.sha} className="flex gap-2">
										<span className="shrink-0 font-mono text-fg-faint">{shortSha(commit.sha)}</span>
										<span className="min-w-0 truncate text-fg">{commit.subject}</span>
									</li>
								))}
							</ul>
						</Expand>
					</div>
				)}
				{needsPush && <p className="text-sm text-fg-muted">{t("createPr.needsPush")}</p>}
			</div>
		);
		footer = (
			<>
				<Button variant="ghost" onClick={close} disabled={creating}>
					{t("createPr.cancel")}
				</Button>
				<Button
					variant="primary"
					icon={<GitPullRequest />}
					loading={creating}
					disabled={!title.trim() || writing}
					onClick={() => void create()}
				>
					{t("createPr.create")}
				</Button>
			</>
		);
	}

	return (
		<Sheet
			open
			onOpenChange={open => {
				if (!open && !creating) close();
			}}
		>
			<SheetContent
				width={600}
				title={t("createPr.title")}
				description={branch ? t("createPr.description", { branch }) : undefined}
				footer={footer}
			>
				<PresenceSwap swapKey={stage} variant="rise">
					{content}
				</PresenceSwap>
			</SheetContent>
		</Sheet>
	);
}
