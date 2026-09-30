import * as RD from "@radix-ui/react-dialog";
import { ArrowLeft, ArrowSquareOut, Bug, CaretRight, ChatCenteredDots, Compass, Keyboard, MagnifyingGlassMinus, X } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSheetPresence } from "../../registry/sheetPresence";
import type { SheetProps } from "../../registry/slots";
import { controllerFor, useApp } from "../../state/app";
import { Button, cn, EmptyState, PresenceSwap, SearchInput, spring, toast } from "../../ui";
import { closeButton, focusRingInset } from "../../ui/styles";
import { GUIDES, type Guide, matchesQuery, TERMS } from "./helpContent";
import { startTour } from "./tour";

const OMP_DOCS_URL = "https://omp.sh";
const REPORT_URL = "https://github.com/decoy-dev/visual-omp/issues";

export interface HelpProps {
	/** Setup screen: omp isn't available, so hide actions that need it (tour, ask omp). */
	limited?: boolean;
}

export function HelpSheet({ props, close }: SheetProps<HelpProps | undefined>) {
	const presence = useSheetPresence();
	return <HelpDialog limited={props?.limited ?? false} open={presence.open} onClose={close} onExited={presence.exited} />;
}

export interface HelpDialogProps {
	limited: boolean;
	/** False plays the exit; the caller unmounts on `onExited`. */
	open: boolean;
	onClose(): void;
	/** The dialog finished leaving and focus went back to where it was. */
	onExited(): void;
}

/** DESIGN §4.21: modal sheet 720×560 with guides, glossary and footer links. */
export function HelpDialog({ limited, open, onClose, onExited }: HelpDialogProps) {
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
		<RD.Root open={open} onOpenChange={next => !next && onClose()}>
			<RD.Portal>
				<RD.Overlay className="vo-scrim fixed inset-0 z-(--z-scrim) bg-backdrop" />
				<RD.Content
					onCloseAutoFocus={onExited}
					aria-describedby={undefined}
					className={cn(
						"vo-dialog fixed left-1/2 top-1/2 z-(--z-sheet) flex h-[560px] w-[720px] max-h-[calc(100vh-64px)] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden",
						"rounded-lg border border-border bg-overlay text-fg shadow-(--shadow-overlay) outline-none",
					)}
				>
					<header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3.5">
						<div className="min-w-0 flex-1">
							<RD.Title className="text-lg font-semibold text-fg">{t("help.title")}</RD.Title>
							<p className="text-sm text-fg-muted">{t("help.subtitle")}</p>
						</div>
						<RD.Close aria-label={t("help.close")} className={closeButton}>
							<X className="size-4" aria-hidden />
						</RD.Close>
					</header>

					<div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 py-4">
						<PresenceSwap swapKey={guide?.id ?? "index"} variant="slide" direction={guide ? 1 : -1}>
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
										icon={<MagnifyingGlassMinus aria-hidden />}
										title={t("help.noMatches")}
										body={t("help.noMatchesBody")}
										actions={
											!limited && (
												<Button variant="primary" icon={<ChatCenteredDots aria-hidden />} onClick={askOmp}>
													{t("help.askOmp", { q: question.length > 40 ? `${question.slice(0, 39)}…` : question })}
												</Button>
											)
										}
									/>
								) : (
									<>
										{guides.length > 0 && (
											<section aria-labelledby="help-guides" className="mt-5">
												<h3 id="help-guides" className="mb-1 text-sm font-medium text-fg-muted">
													{t("help.guides")}
												</h3>
												<ul className="relative -mx-2">
													<AnimatePresence initial={false} mode="popLayout">
													{guides.map(entry => (
														<motion.li
															key={entry.id}
															layout="position"
															initial={{ opacity: 0 }}
															animate={{ opacity: 1 }}
															exit={{ opacity: 0 }}
															transition={spring.snappy}
														>
															<button
																type="button"
																onClick={() => setGuideId(entry.id)}
																className={cn(
																	"group flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left transition-colors duration-(--dur-fast) hover:bg-hover",
																	focusRingInset,
																)}
															>
																<entry.icon className="size-4 shrink-0 text-fg-muted" aria-hidden />
																<span className="min-w-0 flex-1">
																	<span className="block text-md font-medium text-fg">{t(`help.guide.${entry.id}.title`)}</span>
																	<span className="block text-sm text-fg-muted">{t(`help.guide.${entry.id}.summary`)}</span>
																</span>
																<CaretRight
																	className="size-4 shrink-0 text-fg-faint transition-[translate,color] duration-(--dur-fast) ease-(--ease-out-quart) group-hover:translate-x-0.5 group-hover:text-fg-muted"
																	aria-hidden
																/>
															</button>
														</motion.li>
													))}
													</AnimatePresence>
												</ul>
											</section>
										)}
										{terms.length > 0 && (
											<section aria-labelledby="help-terms" className="mt-6">
												<h3 id="help-terms" className="mb-1 text-sm font-medium text-fg-muted">
													{t("help.glossary")}
												</h3>
												<dl className="divide-y divide-border">
													{terms.map(key => (
														<div key={key} className="flex items-baseline gap-4 py-2.5">
															<dt className="w-32 shrink-0 font-mono text-sm text-fg">{t(`help.terms.${key}.term`)}</dt>
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
						</PresenceSwap>
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
						<Button variant="ghost" size="sm" iconRight={<ArrowSquareOut aria-hidden />} onClick={() => openExternal(OMP_DOCS_URL)}>
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
			<div className="mt-3 flex items-start gap-3">
				<guide.icon className="mt-1 size-5 shrink-0 text-accent" aria-hidden />
				<div>
					<h3 id={`guide-${guide.id}`} className="text-xl font-semibold text-fg">
						{t(`help.guide.${guide.id}.title`)}
					</h3>
					<p className="text-md text-fg-muted">{t(`help.guide.${guide.id}.summary`)}</p>
				</div>
			</div>
			<ol className="mt-5 divide-y divide-border border-y border-border">
				{guide.steps.map((StepIcon, index) => (
					<li key={index} className="flex items-start gap-3 py-3">
						<StepIcon className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden />
						<p className="min-w-0 text-md text-fg">{t(`help.guide.${guide.id}.s${index + 1}`)}</p>
					</li>
				))}
			</ol>
		</article>
	);
}
