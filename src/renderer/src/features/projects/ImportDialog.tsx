/**
 * Import a Claude Code or Codex conversation. omp has no non-interactive import: its
 * `--from-claude` / `--from-codex` launch flags open omp's own session picker, so this starts a
 * chat with those flags and shows omp's screen in the terminal sheet (see `@shared/contracts/share`).
 */
import type { ImportSource } from "@shared/contracts/share";
import { ArrowRight } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SheetProps } from "@/registry/slots";
import { shortAgo } from "@/shell/hooks";
import { useApp } from "@/state/app";
import { cn, Dialog, DialogContent, Skeleton, toast } from "@/ui";
import { errorText } from "./actions";

export interface ImportProps {
	projectPath?: string | null;
}

export function ImportDialog({ props, close }: SheetProps<ImportProps | undefined>): ReactNode {
	const { t } = useTranslation("projects");
	const active = useApp(state => state.activeProject);
	const [sources, setSources] = useState<ImportSource[] | null>(null);

	useEffect(() => {
		window.vomp.invoke("share:importSources").then(setSources, error => {
			toast({ tone: "err", message: t("import.failed"), description: errorText(error) });
			setSources([]);
		});
	}, [t]);

	const start = async (source: ImportSource) => {
		// omp switches to the imported chat's own folder; the cwd is only a fallback for chats whose folder is gone.
		const cwd = props?.projectPath ?? active ?? (await window.vomp.invoke("app:info")).homeDir;
		const tabId = useApp.getState().newChat(cwd, { extraArgs: source.launchArgs });
		close();
		if (tabId) useApp.getState().openTerminal(tabId);
	};

	const now = Date.now();
	return (
		<Dialog open onOpenChange={open => !open && close()}>
			<DialogContent size="md" title={t("import.title")} description={t("import.body")}>
				{!sources ? (
					<div className="flex flex-col gap-2" aria-busy>
						<Skeleton height={56} />
						<Skeleton height={56} />
					</div>
				) : (
					<ul className="flex flex-col gap-2">
						{sources.map(source => (
							<li key={source.id}>
								<button
									type="button"
									disabled={!source.available}
									onClick={() => void start(source)}
									className={cn(
										"group flex min-h-14 w-full items-center gap-3 rounded-lg border border-border bg-panel px-3 py-2.5 text-left outline-none",
										"transition-[background-color,translate,box-shadow] duration-(--dur-fast) enabled:hover:-translate-y-px enabled:hover:bg-hover enabled:hover:shadow-(--shadow-card)",
										"focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:enabled:hover:translate-y-0",
									)}
								>
									<span className="min-w-0 flex-1">
										<span className="block text-md font-semibold text-fg">{t("import.from", { label: source.label })}</span>
										<span className="block truncate text-sm text-fg-muted">
											{source.available
												? t("import.count", {
														count: source.sessionCount,
														ago: source.lastModified ? shortAgo(source.lastModified, now) : "—",
													})
												: t("import.none", { dir: source.dataDir })}
										</span>
									</span>
									<ArrowRight className="size-4 shrink-0 text-fg-faint group-enabled:group-hover:text-fg" aria-hidden />
								</button>
							</li>
						))}
					</ul>
				)}
				<p className="mt-4 text-sm text-fg-faint">{t("import.note")}</p>
			</DialogContent>
		</Dialog>
	);
}
