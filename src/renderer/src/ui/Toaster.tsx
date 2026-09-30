import { CheckCircle, Info, Warning, WarningCircle, X } from "@phosphor-icons/react";
import { AnimatePresence, motion, type PanInfo } from "motion/react";
import { type ReactNode, type Ref, useEffect, useState } from "react";
import { cn } from "./cn";
import { spring } from "./motion";
import { closeButton, focusRing } from "./styles";
import { dismissToast, type ToastAction, type ToastRecord, type ToastTone, useToasts } from "./toast";

const toneIcon: Record<ToastTone, ReactNode> = {
	info: <Info className="size-4" aria-hidden />,
	ok: <CheckCircle className="size-4" aria-hidden />,
	warn: <Warning className="size-4" aria-hidden />,
	err: <WarningCircle className="size-4" aria-hidden />,
};

const toneColor: Record<ToastTone, string> = {
	info: "text-info",
	ok: "text-ok",
	warn: "text-warn",
	err: "text-err",
};

/** Swipe right past this distance (px) or speed (px/s) to dismiss. */
const SWIPE_DISTANCE = 80;
const SWIPE_VELOCITY = 500;

function ToastButton({ id, action, quiet }: { id: string; action: ToastAction; quiet?: boolean }) {
	return (
		<button
			type="button"
			onClick={() => {
				action.onClick();
				dismissToast(id);
			}}
			className={cn(
				"inline-flex h-7 max-w-full shrink items-center rounded-md px-2 text-left text-sm font-semibold",
				"transition-[background-color,color,scale] duration-(--dur-fast) ease-(--ease-out-quart) active:scale-[0.97]",
				quiet ? "font-medium text-fg-muted hover:bg-hover hover:text-fg" : "text-accent hover:bg-accent-muted",
				focusRing,
			)}
		>
			{action.label}
		</button>
	);
}

/** `ref` is forwarded because AnimatePresence `popLayout` measures the exiting element. */
function ToastItem({ item, ref }: { item: ToastRecord; ref?: Ref<HTMLLIElement> }) {
	// Hover or focus inside pauses the countdown (WCAG 2.2.1); leaving restarts the full duration.
	const [paused, setPaused] = useState(false);
	useEffect(() => {
		if (item.durationMs === null || paused) return;
		const timer = setTimeout(() => dismissToast(item.id), item.durationMs);
		return () => clearTimeout(timer);
	}, [item.id, item.durationMs, paused]);

	// A swipe past the threshold dismisses; the exit then continues the throw to the right instead of shrinking.
	const [swiped, setSwiped] = useState(false);
	const onDragEnd = (_event: PointerEvent | MouseEvent | TouchEvent, info: PanInfo) => {
		if (info.offset.x > SWIPE_DISTANCE || info.velocity.x > SWIPE_VELOCITY) {
			setSwiped(true);
			dismissToast(item.id);
		}
	};

	return (
		<motion.li
			ref={ref}
			layout
			initial={{ opacity: 0, y: 16, scale: 0.97 }}
			animate={{ opacity: 1, y: 0, scale: 1 }}
			exit={
				swiped
					? { opacity: 0, x: 360, transition: { duration: 0.18, ease: "easeIn" } }
					: { opacity: 0, scale: 0.96, transition: { duration: 0.14, ease: "easeIn" } }
			}
			transition={spring.gentle}
			drag="x"
			dragConstraints={{ left: 0, right: 0 }}
			dragElastic={{ left: 0.05, right: 0.9 }}
			onDragEnd={onDragEnd}
			className="pointer-events-auto flex w-[320px] max-w-[calc(100vw-32px)] touch-pan-y flex-col gap-2 rounded-lg border border-border bg-raised p-3 pr-2 shadow-(--shadow-pop)"
			onPointerEnter={() => setPaused(true)}
			onPointerLeave={() => setPaused(false)}
			onFocus={() => setPaused(true)}
			onBlur={() => setPaused(false)}
		>
			<div className="flex items-start gap-2.5">
				<span className={cn("mt-px inline-flex shrink-0", toneColor[item.tone])}>{toneIcon[item.tone]}</span>
				{/* Long versions and file names break anywhere instead of pushing the close button out. */}
				<div className="min-w-0 flex-1 select-text [overflow-wrap:anywhere]">
					<p className="text-md font-medium text-fg">{item.message}</p>
					{item.description && <p className="mt-0.5 text-sm text-fg-muted">{item.description}</p>}
				</div>
				<button
					type="button"
					aria-label="Dismiss notification"
					onClick={() => dismissToast(item.id)}
					className={cn("-my-1", closeButton, "text-fg-faint")}
				>
					<X className="size-3.5" aria-hidden />
				</button>
			</div>
			{(item.action || item.secondaryAction) && (
				<div className="flex flex-wrap items-center justify-end gap-1 pl-6">
					{item.secondaryAction && <ToastButton id={item.id} action={item.secondaryAction} quiet />}
					{item.action && <ToastButton id={item.id} action={item.action} />}
				</div>
			)}
		</motion.li>
	);
}

/**
 * Mount once. Bottom-right stack of up to 3 toasts; info/ok announced politely, warn/err assertively.
 * Toasts rise in on a spring, the stack reflows with layout animation, and a rightward swipe dismisses.
 */
export function Toaster() {
	const toasts = useToasts();
	const polite = toasts.filter((t) => t.tone === "info" || t.tone === "ok");
	const assertive = toasts.filter((t) => t.tone === "warn" || t.tone === "err");
	return (
		<>
			<section aria-label="Notifications" className="pointer-events-none fixed bottom-4 right-4 z-(--z-toast)">
				<ol className="relative flex flex-col items-end gap-2">
					<AnimatePresence initial={false} mode="popLayout">
						{toasts.map((t) => (
							<ToastItem key={t.id} item={t} />
						))}
					</AnimatePresence>
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
