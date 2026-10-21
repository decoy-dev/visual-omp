/**
 * A run of tool steps as one row (Normal view): "Worked for 1m 42s · 9 tool calls". Each step joins the group the
 * moment it appears, the first call and a call still running included, so the turn never shows a step as its own row
 * first. While a call in it runs, the row takes the running look of a tool row (accent icon, pulse dot) and reads
 * "Working for 14s", counting up. It opens to the same tool rows the turn would show, a running command's output well
 * included. Elapsed time for a finished group appears only when every call has a known start and result time (see
 * `turns.ts`). File changes belong to the turn's TurnSummary, not here. A group that forms while the chat is open
 * (`arriving`) rises in like a new row. While the reader uses it (opened it, or keyboard focus is inside), it reports
 * `onEngage` so the layout keeps it as its own group with its key. Its open state is kept by key in `openState`, so
 * the group stays open when a streamed reply turns into its saved entry and the row remounts.
 */
import { CaretRight, Stack } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { elapsed, useNow } from "../../shell/hooks";
import { cn, Expand, PulseDot, Rise } from "../../ui";
import type { ToolGroupPlan } from "./turns";

/** "Working for 14s", counting up each second while the group runs. */
function WorkingFor({ since }: { since: number }): ReactNode {
	const { t } = useTranslation("panes");
	const now = useNow(1000);
	return t("work.group.working", { elapsed: elapsed(now - since) });
}

export function ToolGroup({
	plan,
	arriving = false,
	openState,
	onEngage,
	children,
}: {
	plan: ToolGroupPlan;
	arriving?: boolean;
	/** Open groups by key, kept across remounts. */
	openState?: Map<string, boolean>;
	/** Told with the group's key when the reader starts or stops using it. */
	onEngage?: (key: string, engaged: boolean) => void;
	children: ReactNode;
}): ReactNode {
	const { t } = useTranslation("panes");
	const [open, setOpen] = useState(() => openState?.get(plan.key) ?? false);
	const [focused, setFocused] = useState(false);
	const engaged = open || focused;
	useEffect(() => {
		if (!onEngage || !engaged) return;
		onEngage(plan.key, true);
		return () => onEngage(plan.key, false);
	}, [onEngage, plan.key, engaged]);
	const toggle = () => {
		const next = !open;
		setOpen(next);
		if (next) openState?.set(plan.key, true);
		else openState?.delete(plan.key);
	};
	const time = plan.running ? (
		plan.startedAt !== null ? (
			<WorkingFor since={plan.startedAt} />
		) : (
			t("work.group.workingNow")
		)
	) : plan.elapsedMs !== null ? (
		t("work.group.worked", { elapsed: elapsed(plan.elapsedMs) })
	) : null;
	return (
		<Rise
			play={arriving}
			distance={4}
			tempo="snappy"
			className="group/steps"
			onFocus={() => setFocused(true)}
			onBlur={event => {
				if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
			}}
		>
			<button
				type="button"
				aria-expanded={open}
				onClick={toggle}
				className="-mx-2 flex h-8 w-[calc(100%+1rem)] items-center gap-2.5 rounded-md px-2 text-left outline-none transition-colors duration-(--dur-fast) hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
			>
				<Stack className={cn("size-4 shrink-0 transition-colors duration-(--dur)", plan.running ? "text-accent" : "text-fg-faint")} aria-hidden />
				<span
					className={cn(
						"min-w-0 truncate text-md transition-colors duration-(--dur)",
						plan.running ? "text-fg" : "text-fg-muted group-hover/steps:text-fg",
					)}
				>
					{time}
					{time !== null && " · "}
					{t("work.group.calls", { count: plan.calls })}
				</span>
				{plan.failed > 0 && <span className="shrink-0 text-sm text-err">{t("work.group.failed", { count: plan.failed })}</span>}
				{plan.running && (
					<span className="inline-flex size-4 shrink-0 items-center justify-center">
						<PulseDot />
					</span>
				)}
				<CaretRight
					className={cn("size-3.5 shrink-0 text-fg-faint transition-[rotate] duration-(--dur) ease-(--ease-out)", open && "rotate-90")}
					aria-hidden
				/>
			</button>
			<Expand open={open} className="ml-2 border-l border-border pt-1 pb-1 pl-3">
				{children}
			</Expand>
		</Rise>
	);
}
