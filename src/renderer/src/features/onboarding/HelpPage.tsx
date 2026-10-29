/**
 * Help (DESIGN §4.21): a full page with searchable guides and a glossary, the tour, keyboard
 * shortcuts, the omp documentation and a link for reporting a problem. The setup screen shows the
 * same content in place, without the parts that need omp (`limited`).
 */
import { ArrowSquareOut, Bug, CaretDown, ChatCenteredDots, Compass, GearSix, Keyboard, MagnifyingGlassMinus } from "@phosphor-icons/react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PageProps } from "@/registry/slots";
import { controllerFor, useApp } from "@/state/app";
import { openSettings, usePageBack } from "@/state/navigation";
import { Button, cn, EmptyState, Expand, type PageBack, PageFrame, PageHeader, SearchInput, SectionHeader, toast } from "@/ui";
import { focusRingInset } from "@/ui/styles";
import { GUIDES, type Guide, matchesQuery, TERMS } from "./helpContent";
import { startSetup } from "./setup";
import { startTourFromAnywhere } from "./tour";

const OMP_DOCS_URL = "https://omp.sh";
const REPORT_URL = "https://github.com/decoy-dev/visual-omp/issues";

/** The `help` page. */
export function HelpPage({ seq, close }: PageProps<Record<string, never>>): ReactNode {
	return <HelpView back={usePageBack(close)} focusKey={seq} />;
}

export interface HelpViewProps {
	back: PageBack;
	focusKey: string | number;
	/** Setup screen: omp isn't available, so hide what needs it (tour, shortcuts, asking omp). */
	limited?: boolean;
}

export function HelpView({ back, focusKey, limited = false }: HelpViewProps): ReactNode {
	const { t } = useTranslation("onboarding");
	const [query, setQuery] = useState("");

	const guides = useMemo(
		() =>
			GUIDES.filter(entry =>
				matchesQuery(query, [
					t(`help.guide.${entry.id}.title`),
					t(`help.guide.${entry.id}.summary`),
					...[1, 2, 3, 4].map(step => t(`help.guide.${entry.id}.s${step}`)),
				]),
			),
		[query, t],
	);
	const terms = useMemo(
		() => TERMS.filter(key => matchesQuery(query, [t(`help.terms.${key}.term`), t(`help.terms.${key}.def`)])),
		[query, t],
	);
	const question = query.trim();

	const askOmp = async () => {
		if (!useApp.getState().activeProject) {
			toast({ tone: "warn", message: t("help.askNeedsProject"), description: t("help.askNeedsProjectBody") });
			return;
		}
		// The new chat replaces this page.
		const controller = controllerFor(await useApp.getState().newChat());
		if (controller) void controller.send(question);
	};

	return (
		<PageFrame back={back} width="form" label={t("help.title")} focusKey={focusKey}>
			<PageHeader
				title={t("help.title")}
				description={t("help.description")}
				actions={
					!limited && (
						<>
							<Button icon={<GearSix aria-hidden />} onClick={startSetup}>
								{t("help.actions.setup")}
							</Button>
							<Button icon={<Compass aria-hidden />} onClick={startTourFromAnywhere}>
								{t("help.actions.tour")}
							</Button>
							<Button icon={<Keyboard aria-hidden />} onClick={() => openSettings("shortcuts")}>
								{t("help.actions.shortcuts")}
							</Button>
						</>
					)
				}
			/>

			<SearchInput value={query} onValueChange={setQuery} placeholder={t("help.search")} aria-label={t("help.search")} />

			{guides.length === 0 && terms.length === 0 ? (
				<EmptyState
					icon={<MagnifyingGlassMinus aria-hidden />}
					title={t("help.noMatches")}
					body={t(limited ? "help.noMatchesLimited" : "help.noMatchesBody")}
					actions={
						!limited && (
							<Button variant="primary" icon={<ChatCenteredDots aria-hidden />} onClick={() => void askOmp()}>
								{t("help.askOmp", { q: question.length > 40 ? `${question.slice(0, 39)}…` : question })}
							</Button>
						)
					}
				/>
			) : (
				<>
					{guides.length > 0 && <Guides guides={guides} />}
					{terms.length > 0 && <Glossary terms={terms} />}
				</>
			)}

			<MoreHelp />
		</PageFrame>
	);
}

function Guides({ guides }: { guides: readonly Guide[] }): ReactNode {
	const { t } = useTranslation("onboarding");
	const id = useId();
	return (
		<section aria-labelledby={id} className="mt-8">
			<SectionHeader id={id} title={t("help.guides")} />
			<ul className="-mx-2 flex flex-col">
				{guides.map(guide => (
					<GuideRow key={guide.id} guide={guide} />
				))}
			</ul>
		</section>
	);
}

/** A guide as a disclosure row: title and summary, opening to its four steps. */
function GuideRow({ guide }: { guide: Guide }): ReactNode {
	const { t } = useTranslation("onboarding");
	const [open, setOpen] = useState(false);
	const stepsId = useId();
	return (
		<li>
			<button
				type="button"
				aria-expanded={open}
				aria-controls={stepsId}
				onClick={() => setOpen(value => !value)}
				className={cn("flex w-full items-start gap-3 rounded-md px-2 py-3 text-left transition-colors duration-(--dur-fast) hover:bg-hover", focusRingInset)}
			>
				<guide.icon className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden />
				<span className="min-w-0 flex-1">
					<span className="block text-md font-medium text-fg">{t(`help.guide.${guide.id}.title`)}</span>
					<span className="block text-sm text-fg-muted">{t(`help.guide.${guide.id}.summary`)}</span>
				</span>
				<CaretDown
					className={cn("mt-0.5 size-4 shrink-0 text-fg-faint transition-transform duration-(--dur-fast) ease-(--ease-out-quart)", open && "rotate-180")}
					aria-hidden
				/>
			</button>
			<Expand open={open} id={stepsId}>
				<ol className="mb-2 ml-9 mr-2 flex flex-col divide-y divide-border">
					{guide.steps.map((StepIcon, index) => (
						<li key={index} className="flex items-start gap-3 py-3">
							<StepIcon className="mt-0.5 size-4 shrink-0 text-fg-faint" aria-hidden />
							<p className="min-w-0 text-md text-fg">{t(`help.guide.${guide.id}.s${index + 1}`)}</p>
						</li>
					))}
				</ol>
			</Expand>
		</li>
	);
}

function Glossary({ terms }: { terms: readonly (typeof TERMS)[number][] }): ReactNode {
	const { t } = useTranslation("onboarding");
	const id = useId();
	return (
		<section aria-labelledby={id} className="mt-10">
			<SectionHeader id={id} title={t("help.glossary")} />
			<dl className="flex flex-col divide-y divide-border">
				{terms.map(key => (
					<div key={key} className="flex flex-col gap-1 py-3 @md/content:flex-row @md/content:items-baseline @md/content:gap-4">
						<dt className="shrink-0 font-mono text-sm text-fg @md/content:w-36">{t(`help.terms.${key}.term`)}</dt>
						<dd className="min-w-0 flex-1 text-md text-fg-muted">{t(`help.terms.${key}.def`)}</dd>
					</div>
				))}
			</dl>
		</section>
	);
}

/** Documentation and problem reports, both opened in the browser. */
function MoreHelp(): ReactNode {
	const { t } = useTranslation("onboarding");
	const id = useId();
	const links = [
		{ key: "docs", url: OMP_DOCS_URL, icon: ArrowSquareOut },
		{ key: "report", url: REPORT_URL, icon: Bug },
	] as const;
	return (
		<section aria-labelledby={id} className="mt-10">
			<SectionHeader id={id} title={t("help.more.title")} />
			<ul className="-mx-2 flex flex-col">
				{links.map(link => (
					<li key={link.key}>
						<button
							type="button"
							onClick={() => void window.vomp.invoke("app:openExternal", link.url)}
							className={cn("flex w-full items-start gap-3 rounded-md px-2 py-3 text-left transition-colors duration-(--dur-fast) hover:bg-hover", focusRingInset)}
						>
							<link.icon className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden />
							<span className="min-w-0 flex-1">
								<span className="block text-md font-medium text-fg">{t(`help.more.${link.key}`)}</span>
								<span className="block text-sm text-fg-muted">{t(`help.more.${link.key}Body`)}</span>
							</span>
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}
