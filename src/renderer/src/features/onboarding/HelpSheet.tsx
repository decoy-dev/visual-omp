import * as RD from "@radix-ui/react-dialog";
import { ArrowLeft, Bug, ChevronRight, Compass, ExternalLink, Keyboard, MessageSquarePlus, SearchX, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SheetProps } from "../../registry/slots";
import { controllerFor, useApp } from "../../state/app";
import { Button, cn, EmptyState, SearchInput, toast } from "../../ui";
import { focusRing } from "../../ui/styles";
import { GUIDES, type Guide, matchesQuery, TERMS } from "./helpContent";
import { startTour } from "./tour";

const OMP_DOCS_URL = "https://omp.sh";
const REPORT_URL = "https://github.com/decoy-dev/visual-omp/issues";

export interface HelpProps {
	/** Setup screen: omp isn't available, so hide actions that need it (tour, ask omp). */
	limited?: boolean;
}

export function HelpSheet({ props, close }: SheetProps<HelpProps | undefined>) {
	return <HelpDialog limited={props?.limited ?? false} onClose={close} />;
}

/** DESIGN §4.21: modal sheet 720×560 with guides, glossary and footer links. */
export function HelpDialog({ limited, onClose }: { limited: boolean; onClose(): void }) {
	const { t } = useTranslation("onboarding");
	const [query, setQuery] = useState("");
	const [guideId, setGuideId] = useState<Guide["id"] | null>(null);
	const guide = GUIDES.find(entry => entry.id === guideId) ?? null;

	const guideText = (entry: Guide) => [
		t(`help.guide.${entry.id}.title`),
		t(`help.guide.${entry.id}.summary`),
		...[1, 2, 3, 4].map(step => t(`help.guide.${entry.id}.s${step}`)),
	];
	const guides = useMemo(() => GUIDES.filter(entry => matchesQuery(query, guideText(entry))), [query, t]);
	const terms = useMemo(
		() => TERMS.filter(key => matchesQuery(query, [t(`help.terms.${key}.term`), t(`help.terms.${key}.def`)])),
		[query, t],
	);
	const question = query.trim();

	const askOmp = () => {
		const tabId = useApp.getState().newChat();
		const controller = controllerFor(tabId);
		if (!controller) {
			toast({ tone: "warn", message: t("help.askNeedsProject"), description: t("help.askNeedsProjectBody") });
			return;
		}
		onClose();
		void controller.send(question);
	};

	const openExternal = (url: string) => void window.vomp.invoke("app:openExternal", url);

	return (
		<RD.Root open onOpenChange={open => !open && onClose()}>
			<RD.Portal>
				<RD.Overlay className="vo-scrim fixed inset-0 z-(--z-scrim) bg-backdrop backdrop-blur-[2px]" />
				<RD.Content
					aria-describedby={undefined}
					className={cn(
						"vo-dialog fixed left-1/2 top-1/2 z-(--z-sheet) flex h-[560px] w-[720px] max-h-[calc(100vh-64px)] max-w-[calc(100vw-32px)] flex-col overflow-hidden",
						"[transform:translate(-50%,-50%)] rounded-xl border border-border bg-overlay text-fg shadow-(--shadow-overlay) outline-none",
					)}
				>
					<header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3.5">
						<div className="min-w-0 flex-1">
							<RD.Title className="text-lg font-semibold text-fg">{t("help.title")}</RD.Title>
							<p className="text-sm text-fg-muted">{t("help.subtitle")}</p>
						</div>
						<RD.Close
							aria-label={t("help.close")}
							className={cn(
								"inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors duration-(--dur-fast) hover:bg-hover hover:text-fg",
								focusRing,
							)}
						>
							<X className="size-4" aria-hidden />
						</RD.Close>
					</header>

					<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
						{guide ? (
							<GuideArticle guide={guide} onBack={() => setGuideId(null)} />
						) : (
							<>
								<SearchInput
									value={query}
									onValueChange={setQuery}
									placeholder={t("help.search")}
									aria-label={t("help.search")}
									autoFocus
								/>
								{guides.length === 0 && terms.length === 0 ? (
									<EmptyState
										icon={<SearchX aria-hidden />}
										title={t("help.noMatches")}
										body={t("help.noMatchesBody")}
										actions={
											!limited && (
												<Button variant="primary" icon={<MessageSquarePlus aria-hidden />} onClick={askOmp}>
													{t("help.askOmp", { q: question.length > 40 ? `${question.slice(0, 39)}…` : question })}
												</Button>
											)
										}
									/>
								) : (
									<>
										{guides.length > 0 && (
											<section aria-labelledby="help-guides" className="mt-5">
												<h3 id="help-guides" className="mb-2 text-sm font-semibold text-fg-muted">
													{t("help.guides")}
												</h3>
												<ul className="grid grid-cols-2 gap-2">
													{guides.map(entry => (
														<li key={entry.id}>
															<button
																type="button"
																onClick={() => setGuideId(entry.id)}
																className={cn(
																	"group flex w-full items-start gap-3 rounded-lg border border-border bg-panel p-3 text-left transition-[background-color,box-shadow] duration-(--dur-fast) hover:bg-hover hover:shadow-(--shadow-card)",
																	focusRing,
																)}
															>
																<span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-muted text-accent">
																	<entry.icon className="size-4" aria-hidden />
																</span>
																<span className="min-w-0 flex-1">
																	<span className="block text-md font-semibold text-fg">{t(`help.guide.${entry.id}.title`)}</span>
																	<span className="mt-0.5 block text-sm text-fg-muted">{t(`help.guide.${entry.id}.summary`)}</span>
																</span>
																<ChevronRight className="mt-2 size-4 shrink-0 text-fg-faint group-hover:text-fg-muted" aria-hidden />
															</button>
														</li>
													))}
												</ul>
											</section>
										)}
										{terms.length > 0 && (
											<section aria-labelledby="help-terms" className="mt-6">
												<h3 id="help-terms" className="mb-2 text-sm font-semibold text-fg-muted">
													{t("help.glossary")}
												</h3>
												<dl className="divide-y divide-border rounded-lg border border-border bg-panel">
													{terms.map(key => (
														<div key={key} className="flex items-baseline gap-4 px-3 py-2.5">
															<dt className="w-32 shrink-0">
																<span className="inline-flex rounded-sm bg-inset px-1.5 py-0.5 font-mono text-sm text-fg">
																	{t(`help.terms.${key}.term`)}
																</span>
															</dt>
															<dd className="min-w-0 flex-1 text-md text-fg-muted">{t(`help.terms.${key}.def`)}</dd>
														</div>
													))}
												</dl>
											</section>
										)}
									</>
								)}
							</>
						)}
					</div>

					<footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-5 py-3">
						{!limited && (
							<Button
								variant="ghost"
								size="sm"
								icon={<Compass aria-hidden />}
								onClick={() => {
									onClose();
									startTour();
								}}
							>
								{t("help.footer.tour")}
							</Button>
						)}
						{!limited && (
							<Button
								variant="ghost"
								size="sm"
								icon={<Keyboard aria-hidden />}
								onClick={() => useApp.getState().openSheet("settings", { tab: "shortcuts" })}
							>
								{t("help.footer.shortcuts")}
							</Button>
						)}
						<span className="flex-1" />
						<Button variant="ghost" size="sm" iconRight={<ExternalLink aria-hidden />} onClick={() => openExternal(OMP_DOCS_URL)}>
							{t("help.footer.docs")}
						</Button>
						<Button variant="ghost" size="sm" icon={<Bug aria-hidden />} onClick={() => openExternal(REPORT_URL)}>
							{t("help.footer.report")}
						</Button>
					</footer>
				</RD.Content>
			</RD.Portal>
		</RD.Root>
	);
}

/** A guide opened in place: back link, title, and a 4-step illustrated sequence. */
function GuideArticle({ guide, onBack }: { guide: Guide; onBack(): void }) {
	const { t } = useTranslation("onboarding");
	return (
		<article aria-labelledby={`guide-${guide.id}`}>
			<Button variant="ghost" size="sm" icon={<ArrowLeft aria-hidden />} onClick={onBack} autoFocus className="-ml-2">
				{t("help.back")}
			</Button>
			<div className="mt-3 flex items-center gap-3">
				<span className="inline-flex size-10 items-center justify-center rounded-lg bg-accent-muted text-accent">
					<guide.icon className="size-5" aria-hidden />
				</span>
				<div>
					<h3 id={`guide-${guide.id}`} className="text-xl font-semibold text-fg">
						{t(`help.guide.${guide.id}.title`)}
					</h3>
					<p className="text-md text-fg-muted">{t(`help.guide.${guide.id}.summary`)}</p>
				</div>
			</div>
			<ol className="mt-6 grid grid-cols-2 gap-3">
				{guide.steps.map((Icon, index) => (
					<li key={index} className="flex gap-3 rounded-lg border border-border bg-panel p-4">
						<div className="flex shrink-0 flex-col items-center gap-2">
							<span className="inline-flex size-9 items-center justify-center rounded-md border border-border bg-inset text-accent shadow-(--shadow-card)">
								<Icon className="size-4.5" aria-hidden />
							</span>
							<span className="font-mono text-xs text-fg-faint">{t("help.stepOf", { step: index + 1 })}</span>
						</div>
						<p className="min-w-0 text-md text-fg">{t(`help.guide.${guide.id}.s${index + 1}`)}</p>
					</li>
				))}
			</ol>
		</article>
	);
}
