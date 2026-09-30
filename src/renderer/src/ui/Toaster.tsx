import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { cn } from "./cn";
import { focusRing } from "./styles";
import { dismissToast, type ToastRecord, type ToastTone, useToasts } from "./toast";

const toneIcon: Record<ToastTone, ReactNode> = {
	info: <Info className="size-4" aria-hidden />,
	ok: <CircleCheck className="size-4" aria-hidden />,
	warn: <TriangleAlert className="size-4" aria-hidden />,
	err: <CircleAlert className="size-4" aria-hidden />,
};

const toneColor: Record<ToastTone, string> = {
	info: "text-info",
	ok: "text-ok",
	warn: "text-warn",
	err: "text-err",
};

function ToastItem({ item }: { item: ToastRecord }) {
	// Hover or focus inside pauses the countdown (WCAG 2.2.1); leaving restarts the full duration.
	const [paused, setPaused] = useState(false);
	useEffect(() => {
		if (item.durationMs === null || paused) return;
		const timer = setTimeout(() => dismissToast(item.id), item.durationMs);
		return () => clearTimeout(timer);
	}, [item.id, item.durationMs, paused]);

	return (
		<li
			className="vo-toast pointer-events-auto flex w-[320px] max-w-[calc(100vw-32px)] items-start gap-2.5 rounded-lg border border-border bg-raised p-3 pr-2 shadow-(--shadow-pop)"
			onPointerEnter={() => setPaused(true)}
			onPointerLeave={() => setPaused(false)}
			onFocus={() => setPaused(true)}
			onBlur={() => setPaused(false)}
		>
			<span className={cn("mt-px inline-flex shrink-0", toneColor[item.tone])}>{toneIcon[item.tone]}</span>
			<div className="min-w-0 flex-1 select-text">
				<p className="text-md font-medium text-fg">{item.message}</p>
				{item.description && <p className="mt-0.5 text-sm text-fg-muted">{item.description}</p>}
			</div>
			{item.action && (
				<button
					type="button"
					onClick={() => {
						item.action?.onClick();
						dismissToast(item.id);
					}}
					className={cn(
						"-my-1 inline-flex h-7 shrink-0 items-center rounded-md px-2 text-sm font-semibold text-accent transition-colors duration-(--dur-fast) hover:bg-accent-muted",
						focusRing,
					)}
				>
					{item.action.label}
				</button>
			)}
			<button
				type="button"
				aria-label="Dismiss notification"
				onClick={() => dismissToast(item.id)}
				className={cn(
					"-my-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-faint transition-colors duration-(--dur-fast) hover:bg-hover hover:text-fg",
					focusRing,
				)}
			>
				<X className="size-3.5" aria-hidden />
			</button>
		</li>
	);
}

/** Mount once. Bottom-right stack of up to 3 toasts; info/ok announced politely, warn/err assertively. */
export function Toaster() {
	const toasts = useToasts();
	const polite = toasts.filter((t) => t.tone === "info" || t.tone === "ok");
	const assertive = toasts.filter((t) => t.tone === "warn" || t.tone === "err");
	return (
		<>
			<section aria-label="Notifications" className="pointer-events-none fixed bottom-4 right-4 z-(--z-toast)">
				<ol className="flex flex-col items-end gap-2">
					{toasts.map((t) => (
						<ToastItem key={t.id} item={t} />
					))}
				</ol>
			</section>
			{/* Persistent live regions: always mounted so insertions are announced reliably. */}
			<div className="sr-only" aria-live="polite" aria-atomic="false">
				{polite.map((t) => (
					<p key={t.id}>{t.description ? `${t.message}. ${t.description}` : t.message}</p>
				))}
			</div>
			<div className="sr-only" aria-live="assertive" aria-atomic="false">
				{assertive.map((t) => (
					<p key={t.id}>{t.description ? `${t.message}. ${t.description}` : t.message}</p>
				))}
			</div>
		</>
	);
}
