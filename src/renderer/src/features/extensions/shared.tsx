/** Hooks and small building blocks shared by the extensions sheets. */
import { Info, Warning, WarningCircle } from "@phosphor-icons/react";
import { type DependencyList, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { EventChannel, IpcEventMap } from "@shared/ipc";
import { useSheetPresence } from "@/registry/sheetPresence";
import { useApp } from "@/state/app";
import { Button, cn, Dialog, DialogContent, Input, Sheet, SheetContent } from "@/ui";
import { errorText } from "./format";

/** Props every extensions sheet accepts via `openSheet(id, { projectPath, scope })`. */
export interface ExtensionSheetProps {
	projectPath?: string | null;
	/** Land on the all-projects (`global`) or this-project view. */
	scope?: "global" | "project";
}

/** The project the sheet is about: the one it was opened for, else the focused project. */
export function useSheetProject(props: ExtensionSheetProps | undefined): string | null {
	const active = useApp(state => state.activeProject);
	return props?.projectPath ?? active;
}

export interface Loaded<T> {
	data: T | null;
	error: string | null;
	loading: boolean;
	/** Re-run the loader; keeps the previous data visible until the new result arrives. */
	reload(): Promise<void>;
}

/** Run an async loader on mount and whenever `deps` change; stale results are dropped. */
export function useLoad<T>(load: () => Promise<T>, deps: DependencyList): Loaded<T> {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const seq = useRef(0);
	// `deps` is the caller's dependency list; `load` changes every render and is read when they change.
	const reload = useCallback(async () => {
		const mine = ++seq.current;
		setLoading(true);
		try {
			const next = await load();
			if (mine !== seq.current) return;
			setData(next);
			setError(null);
		} catch (err) {
			if (mine !== seq.current) return;
			setError(errorText(err));
		} finally {
			if (mine === seq.current) setLoading(false);
		}
	}, deps);
	useEffect(() => {
		void reload();
	}, [reload]);
	return { data, error, loading, reload };
}

/** Subscribe to a main-process push channel for the component's lifetime. */
export function useIpcEvent<C extends EventChannel>(channel: C, listener: (payload: IpcEventMap[C]) => void): void {
	const latest = useRef(listener);
	latest.current = listener;
	useEffect(() => window.vomp.on(channel, payload => latest.current(payload)), [channel]);
}

/** Value that follows `value` after it has been stable for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
	const [settled, setSettled] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setSettled(value), ms);
		return () => clearTimeout(timer);
	}, [value, ms]);
	return settled;
}

export interface ExtensionSheetFrameProps {
	close(): void;
	title: ReactNode;
	description?: ReactNode;
	width: number;
	actions?: ReactNode;
	footer?: ReactNode;
	bodyClassName?: string;
	children: ReactNode;
}

/** Right-docked modal sheet; dismissing it calls `close()`, and in the sheet host it slides out before unmounting. */
export function ExtensionSheetFrame({ close, width, children, ...content }: ExtensionSheetFrameProps) {
	const presence = useSheetPresence();
	return (
		<Sheet open={presence.open} onOpenChange={open => !open && close()}>
			<SheetContent width={width} onCloseAutoFocus={presence.exited} {...content}>
				{children}
			</SheetContent>
		</Sheet>
	);
}

export type NoticeTone = "info" | "warn" | "err";

const noticeTones: Record<NoticeTone, { box: string; icon: ReactNode }> = {
	info: { box: "border-border bg-inset text-fg-muted", icon: <Info aria-hidden className="size-4 text-info" /> },
	warn: { box: "border-border bg-warn-bg text-fg", icon: <Warning aria-hidden className="size-4 text-warn" /> },
	err: { box: "border-border bg-err-bg text-fg", icon: <WarningCircle aria-hidden className="size-4 text-err" /> },
};

/** Inline banner: glyph + message (+ optional actions on the right). Errors are announced. */
export function Notice({
	tone = "info",
	children,
	actions,
	className,
}: {
	tone?: NoticeTone;
	children: ReactNode;
	actions?: ReactNode;
	className?: string;
}) {
	const style = noticeTones[tone];
	return (
		<div
			role={tone === "err" ? "alert" : "status"}
			className={cn("flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm", style.box, className)}
		>
			<span className="mt-px inline-flex shrink-0">{style.icon}</span>
			<div className="min-w-0 flex-1 break-words">{children}</div>
			{actions && <div className="-my-1 flex shrink-0 items-center gap-1.5">{actions}</div>}
		</div>
	);
}

/** Letter tile used as an avatar for skills, plugins and servers. */
export function LetterTile({ name, className }: { name: string; className?: string }) {
	const letter = (name.replace(/^[@/._-]+/, "")[0] ?? "?").toUpperCase();
	return (
		<span
			aria-hidden
			className={cn(
				"inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-inset font-mono text-sm font-semibold text-fg-muted",
				className,
			)}
		>
			{letter}
		</span>
	);
}

export interface ConfirmDialogProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	title: ReactNode;
	description?: ReactNode;
	confirmLabel: string;
	onConfirm(): Promise<void> | void;
	/** Destructive styling (danger button, warning glyph, scrim click does not dismiss). */
	destructive?: boolean;
	/** The user must type this word before the action enables. */
	typeToConfirm?: string;
	/** Label above the type-to-confirm field, e.g. `Type "forget" to confirm`. */
	typeLabel?: string;
	cancelLabel: string;
	children?: ReactNode;
}

/** [Cancel][Action] confirmation; the action shows a spinner while `onConfirm` runs and closes when it resolves. */
export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel,
	onConfirm,
	destructive = true,
	typeToConfirm,
	typeLabel,
	cancelLabel,
	children,
}: ConfirmDialogProps) {
	const [typed, setTyped] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (!open) {
			setTyped("");
			setError(null);
		}
	}, [open]);
	const armed = !typeToConfirm || typed.trim().toLowerCase() === typeToConfirm.toLowerCase();
	const run = async () => {
		setBusy(true);
		setError(null);
		try {
			await onConfirm();
			onOpenChange(false);
		} catch (err) {
			setError(errorText(err));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open={open} onOpenChange={next => !busy && onOpenChange(next)}>
			<DialogContent
				title={title}
				description={description}
				destructive={destructive}
				footer={
					<>
						<Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
							{cancelLabel}
						</Button>
						<Button variant={destructive ? "danger" : "primary"} loading={busy} disabled={!armed} onClick={() => void run()}>
							{confirmLabel}
						</Button>
					</>
				}
			>
				{(children || typeToConfirm || error) && (
					<div className="flex flex-col gap-3">
						{children}
						{typeToConfirm && (
							<Input
								label={typeLabel}
								value={typed}
								autoFocus
								autoComplete="off"
								spellCheck={false}
								onChange={event => setTyped(event.currentTarget.value)}
								onKeyDown={event => {
									if (event.key === "Enter" && armed && !busy) void run();
								}}
							/>
						)}
						{error && <Notice tone="err">{error}</Notice>}
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
