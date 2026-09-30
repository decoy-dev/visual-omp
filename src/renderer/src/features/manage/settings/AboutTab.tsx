import type { AppUpdateStatus, OmpUpdateStatus } from "@shared/contracts/updates";
import { Bug, ExternalLink, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/state/app";
import { Button, Mark, Wordmark } from "@/ui";
import { useResource } from "../shared";

const DOCS_URL = "https://omp.sh";
const ISSUES_URL = "https://github.com/decoy-dev/visual-omp/issues";

interface UpdateResults {
	app: AppUpdateStatus;
	omp: OmpUpdateStatus;
}

export function AboutTab() {
	const { t } = useTranslation("manage");
	const info = useResource(() => window.vomp.invoke("app:info"), []);
	const omp = useApp(state => state.omp);
	const [checking, setChecking] = useState(false);
	const [updates, setUpdates] = useState<UpdateResults | null>(null);

	const check = async () => {
		setChecking(true);
		try {
			const [app, engine] = await Promise.all([
				window.vomp.invoke("updates:app:check", true),
				window.vomp.invoke("updates:omp:check", true),
			]);
			setUpdates({ app, omp: engine });
		} finally {
			setChecking(false);
		}
	};
	const open = (url: string) => void window.vomp.invoke("app:openExternal", url);

	return (
		<div>
			<div className="flex items-center gap-4">
				<Mark size={48} />
				<div>
					<Wordmark size="lg" blink />
					<p className="mt-1 text-sm text-fg-muted">{t("about.tagline")}</p>
				</div>
			</div>

			<dl className="mt-6 grid grid-cols-[140px_1fr] gap-x-4 gap-y-2 rounded-lg border border-border bg-panel p-4 text-md">
				<dt className="text-fg-muted">{t("about.appVersion")}</dt>
				<dd className="font-mono text-fg">
					{info.data ? `${info.data.version} · ${info.data.platform} ${info.data.arch}` : "…"}
				</dd>
				<dt className="text-fg-muted">{t("about.ompVersion")}</dt>
				<dd className="font-mono text-fg">{omp?.version ?? t("about.ompMissing")}</dd>
				{omp?.path && (
					<>
						<dt className="text-fg-muted">{t("about.ompPath")}</dt>
						<dd className="truncate font-mono text-sm text-fg-muted" title={omp.path}>
							{omp.path}
						</dd>
					</>
				)}
			</dl>

			<div className="mt-4 flex flex-wrap items-center gap-2">
				<Button variant="primary" icon={<RefreshCw />} loading={checking} onClick={() => void check()}>
					{t("about.checkUpdates")}
				</Button>
				<Button variant="ghost" icon={<ExternalLink />} onClick={() => open(DOCS_URL)}>
					{t("about.docs")}
				</Button>
				<Button variant="ghost" icon={<Bug />} onClick={() => open(ISSUES_URL)}>
					{t("about.reportIssue")}
				</Button>
			</div>

			{updates && (
				<div role="status" className="mt-4 space-y-2 text-md">
					<UpdateLine
						text={
							updates.app.error
								? t("about.appCheckFailed", { reason: updates.app.error })
								: updates.app.updateAvailable
									? t("about.appUpdate", { version: updates.app.latestVersion })
									: t("about.appCurrent")
						}
						tone={updates.app.error ? "err" : updates.app.updateAvailable ? "accent" : "ok"}
						action={
							updates.app.updateAvailable && updates.app.releaseUrl
								? { label: t("about.viewRelease"), run: () => open(updates.app.releaseUrl ?? "") }
								: null
						}
					/>
					<UpdateLine
						text={
							updates.omp.error
								? t("about.ompCheckFailed", { reason: updates.omp.error })
								: updates.omp.updateAvailable
									? t("about.ompUpdate", { version: updates.omp.latestVersion })
									: t("about.ompCurrent")
						}
						tone={updates.omp.error ? "err" : updates.omp.updateAvailable ? "accent" : "ok"}
						action={null}
					/>
				</div>
			)}
		</div>
	);
}

const TONES = { ok: "bg-ok", accent: "bg-accent", err: "bg-err" } as const;

function UpdateLine({
	text,
	tone,
	action,
}: {
	text: string;
	tone: keyof typeof TONES;
	action: { label: string; run(): void } | null;
}) {
	return (
		<p className="flex items-center gap-2 text-fg">
			<span aria-hidden className={`size-2 shrink-0 rounded-full ${TONES[tone]}`} />
			<span className="min-w-0 flex-1">{text}</span>
			{action && (
				<Button size="sm" variant="secondary" onClick={action.run}>
					{action.label}
				</Button>
			)}
		</p>
	);
}
