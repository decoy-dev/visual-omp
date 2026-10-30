import { ArrowUp, ChartBar, Check, CircleIcon, GearSix, House, MagnifyingGlass, NotePencil, Plus, Question, ShieldCheck, X } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn, duration, ease, PeriscopeMark, PresenceSwap, PulseDot, spring, Stagger, StaggerItem, useMotionReduced } from "../../ui";

export interface MiniShellProps {
	theme: "light" | "dark";
	ompLine: { tone: "busy" | "ok" | "err"; text: string } | null;
	providers: { id: string; name: string }[];
	model: string | null;
	permission: string | null;
	markFlash?: number;
	celebrate?: boolean;
	className?: string;
}

/**
 * A non-interactive, 1200 × 800 shell illustration. Scale a positioned parent with
 * transform-origin: top left; this component always keeps the real shell's proportions.
 * The theme scope is local, so appearance previews do not change the surrounding wizard.
 */
export function MiniShell({ className, ...props }: MiniShellProps) {
	const assembled = useRef(false);
	const reduced = useMotionReduced();
	useEffect(() => {
		assembled.current = true;
	}, []);
	return (
		<div aria-hidden="true" className={cn("pointer-events-none relative isolate h-[800px] w-[1200px] select-none overflow-hidden", className)}>
			<AnimatePresence initial={false}>
				<motion.div
					key={props.theme}
					data-theme={props.theme}
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={{ duration: reduced ? 0.14 : duration.slow, ease: ease.outQuart }}
					className="absolute inset-0 bg-chrome text-fg"
				>
					<ShellArtwork {...props} assemble={!assembled.current} />
				</motion.div>
			</AnimatePresence>
		</div>
	);
}

function ShellArtwork({ ompLine, providers, model, permission, markFlash, celebrate, assemble: playAssembly }: Omit<MiniShellProps, "theme" | "className"> & { assemble: boolean }) {
	const [assemble] = useState(playAssembly);
	const { t } = useTranslation("onboarding");
	const { t: shell } = useTranslation("shell");
	const { t: composer } = useTranslation("composer");
	const reduced = useMotionReduced();
	const entrance = (axis: "x" | "y", distance: number, delay: number) => ({
		initial: assemble ? { opacity: 0, [axis]: reduced ? 0 : distance } : false as const,
		animate: { opacity: 1, [axis]: 0 },
		transition: reduced
			? { duration: 0.14, ease: ease.outQuart }
			: { [axis]: { ...spring.gentle, delay }, opacity: { duration: duration.slow, ease: ease.outQuart, delay } },
	});
	return (
		<div className="flex h-full flex-col bg-chrome">
			<div className="flex min-h-0 flex-1">
				<motion.div data-region="chrome" className="flex w-[240px] shrink-0 flex-col bg-chrome text-fg" {...entrance("x", -40, 0)}>
					<div className="flex h-10 shrink-0 items-center gap-2 pl-[92px] pr-3">
						<PeriscopeMark size={18} mood={celebrate ? "celebrate" : assemble ? "enter" : "still"} flash={markFlash} inverse />
						<span className="whitespace-nowrap font-mono text-base font-semibold tracking-tight">visual-omp</span>
					</div>
					<div className="flex flex-col gap-1 px-3 pb-2">
						<div className="flex h-9 items-center gap-2 rounded-md px-row text-md font-semibold text-accent">
							<NotePencil className="size-4" />
							{shell("sidebar.newChat")}
						</div>
						<div className="flex h-8 items-center gap-2 rounded-md border border-control-border bg-bg-inset px-row text-sm text-fg-faint">
							<MagnifyingGlass className="size-3.5" />
							{shell("sidebar.search")}
						</div>
					</div>
					<div className="mx-3 h-px bg-border" />
					<div className="min-h-0 flex-1 overflow-hidden px-2 py-2">
						<div className="flex h-7 items-center px-row text-sm font-medium text-fg-muted">{shell("sidebar.current")}</div>
						<Stagger className="flex flex-col gap-1" animateOnMount={assemble}>
							{providers.map(provider => (
								<StaggerItem key={provider.id} distance={reduced ? 0 : 8} className="flex h-8 items-center gap-2 rounded-md bg-pill px-row text-md text-fg">
									<span className="inline-flex size-3.5 shrink-0 items-center justify-center"><CircleIcon weight="bold" className="size-2.5 text-fg-faint" /></span>
									<span className="truncate">{provider.name}</span>
								</StaggerItem>
							))}
						</Stagger>
						{providers.length === 0 && <p className="px-row py-1 text-sm text-fg-faint">{t("wizard.preview.noProviders")}</p>}
					</div>
					<div className="flex flex-col gap-px border-t border-border p-2 text-md font-medium text-fg-muted">
						{[{ Icon: ChartBar, label: shell("sidebar.usage") }, { Icon: GearSix, label: shell("sidebar.settings") }, { Icon: Question, label: shell("sidebar.help") }].map(({ Icon, label }) => (
							<div key={label} className="flex h-9 items-center gap-2 rounded-md px-row"><Icon className="size-4" />{label}</div>
						))}
					</div>
				</motion.div>
				<motion.div data-surface="sheet" className="z-0 flex min-w-0 flex-1 flex-col overflow-hidden rounded-l-lg border-l border-chrome-line bg-sheet text-fg" {...entrance("x", 0, 0.1)}>
					<div className="flex h-10 shrink-0 items-center px-4 text-fg-faint"><House className="size-4" /></div>
					<div className="flex min-h-0 flex-1 items-center justify-center px-page pb-section text-lg text-fg-faint">
						{t("wizard.preview.emptyChats")}
					</div>
					<div className="mx-auto mb-page w-full max-w-(--chat-max) px-page">
						<div className="rounded-xl border border-border-strong bg-panel p-2 shadow-(--shadow-card)">
							<div className="min-h-16 px-1 pt-1 text-base text-fg-faint">{composer("placeholder.idle")}</div>
							<div className="flex items-center gap-1">
								<div className="flex size-8 items-center justify-center text-fg-muted"><Plus className="size-4" /></div>
								<div className="ml-auto flex size-8 items-center justify-center rounded-sm bg-accent text-accent-fg opacity-45"><ArrowUp className="size-4" /></div>
							</div>
						</div>
						<div className="relative flex h-8 items-center gap-2 px-1 font-mono text-xs text-fg-muted">
							<PresenceSwap swapKey={model ?? "empty"} mode="popLayout" className="max-w-full truncate">
								{model && <span>{model}</span>}
							</PresenceSwap>
						</div>
					</div>
				</motion.div>
			</div>
			<motion.div data-region="chrome" className="relative flex h-(--statusbar-h) shrink-0 items-center gap-4 overflow-hidden bg-chrome px-3 font-mono text-xs text-fg-muted" {...entrance("y", 12, 0.18)}>
				<PresenceSwap swapKey={model ?? "empty"} mode="popLayout" className="min-w-0 max-w-[320px] truncate">{model && <span>{model}</span>}</PresenceSwap>
				<div className="relative min-w-0">
					<PresenceSwap swapKey={permission ?? "empty"} mode="popLayout">
						{permission && <span className="flex h-6 items-center gap-1.5 whitespace-nowrap rounded-sm bg-hover px-1.5"><ShieldCheck className="size-3.5 shrink-0" />{permission}</span>}
					</PresenceSwap>
				</div>
				<div className="flex-1" />
				<div className="relative min-w-0 max-w-[600px]">
					<PresenceSwap swapKey={ompLine ? `${ompLine.tone}:${ompLine.text}` : "empty"} mode="popLayout">
						{ompLine && <span className={cn("flex min-w-0 items-center gap-1.5", ompLine.tone === "err" ? "text-err" : ompLine.tone === "ok" ? "text-ok" : "text-accent")}>
							{ompLine.tone === "err" ? <X weight="bold" className="size-3 shrink-0" /> : ompLine.tone === "ok" ? <Check weight="bold" className="size-3 shrink-0" /> : <PulseDot className="size-1.5" />}
							<span className="truncate">{ompLine.text}</span>
						</span>}
					</PresenceSwap>
				</div>
			</motion.div>
		</div>
	);
}
