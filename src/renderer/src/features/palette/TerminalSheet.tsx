/**
 * omp terminal sheet (DESIGN §4.11): a live xterm.js mirror of a chat's hidden omp TUI, for the
 * full-screen omp menus visual-omp does not draw itself. Keystrokes go straight to omp; while the
 * sheet is open the hidden terminal is sized to it, and its previous size is restored on close.
 */
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { ArrowCounterClockwise, ArrowsIn, ArrowsOut, TerminalWindow, Warning } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSessionView } from "../../shell/hooks";
import { controllerFor, useApp } from "../../state/app";
import type { SessionController } from "../../state/session";
import { Button, cn, Dialog, DialogContent, EmptyState, Expand, IconButton, Sheet, SheetContent, Spinner } from "../../ui";
import { type ScreenKey, screenName } from "./overlays";

/** Tab whose sheet the overlay watcher opened (so it closes again when omp's screen goes away). */
export const autoOpened: { tabId: string | null } = { tabId: null };

/** Close the open sheet the way its close button does (asks first when an omp menu is open). */
export const terminalSheet: { requestClose: (() => void) | null } = { requestClose: null };

function xtermTheme() {
	const css = getComputedStyle(document.documentElement);
	const token = (name: string) => css.getPropertyValue(name).trim();
	return {
		background: token("--term-bg"),
		foreground: token("--term-fg"),
		cursor: token("--term-cursor"),
		cursorAccent: token("--term-bg"),
		selectionBackground: token("--term-selection"),
	};
}

interface MirrorProps {
	hostId: string;
	/** Re-attach when omp restarts in place. */
	generation: number;
	readOnly: boolean;
	/** Esc with no omp menu open closes the sheet instead of reaching omp. */
	onIdleEscape(): void;
	overlaysOpen(): boolean;
}

function Mirror({ hostId, generation, readOnly, onIdleEscape, overlaysOpen }: MirrorProps) {
	const { t } = useTranslation("palette");
	const container = useRef<HTMLDivElement>(null);
	const readOnlyRef = useRef(readOnly);
	readOnlyRef.current = readOnly;
	const escapeRef = useRef({ onIdleEscape, overlaysOpen });
	escapeRef.current = { onIdleEscape, overlaysOpen };

	useEffect(() => {
		const element = container.current;
		if (!element) return;
		const css = getComputedStyle(document.documentElement);
		const term = new Terminal({
			fontFamily: css.getPropertyValue("--font-mono").trim() || "monospace",
			fontSize: 13,
			lineHeight: 1.15,
			cursorBlink: true,
			allowProposedApi: true,
			scrollback: 0,
			theme: xtermTheme(),
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.loadAddon(new WebLinksAddon((_event, uri) => void window.vomp.invoke("app:openExternal", uri)));
		term.open(element);
		term.attachCustomKeyEventHandler(event => {
			if (event.type !== "keydown" || event.key !== "Escape" || escapeRef.current.overlaysOpen()) return true;
			escapeRef.current.onIdleEscape();
			return false;
		});

		let disposed = false;
		let attached = false;
		const pending: string[] = [];
		let sent = { cols: 0, rows: 0 };
		const offData = window.vomp.on("host:data", ({ hostId: id, data }) => {
			if (id !== hostId) return;
			if (attached) term.write(data);
			else pending.push(data);
		});
		const onInput = term.onData(data => {
			if (!readOnlyRef.current) void window.vomp.invoke("host:write", hostId, data);
		});
		const sendSize = async () => {
			if (term.cols === sent.cols && term.rows === sent.rows) return;
			sent = { cols: term.cols, rows: term.rows };
			await window.vomp.invoke("host:resize", hostId, term.cols, term.rows);
		};

		void (async () => {
			await document.fonts.ready;
			if (disposed) return;
			fit.fit();
			await sendSize();
			const buffer = await window.vomp.invoke("host:buffer", hostId);
			if (disposed) return;
			term.reset();
			term.write(buffer);
			for (const chunk of pending) term.write(chunk);
			pending.length = 0;
			attached = true;
			// omp repaints its whole screen on resize: nudge the height once so the mirror is exact.
			await window.vomp.invoke("host:resize", hostId, term.cols, Math.max(5, term.rows - 1));
			await window.vomp.invoke("host:resize", hostId, term.cols, term.rows);
			if (!readOnlyRef.current) term.focus();
		})();

		let resizeTimer: number | undefined;
		const observer = new ResizeObserver(() => {
			clearTimeout(resizeTimer);
			resizeTimer = window.setTimeout(() => {
				if (disposed || element.clientWidth === 0) return;
				fit.fit();
				if (attached) void sendSize();
			}, 60);
		});
		observer.observe(element);
		const themeObserver = new MutationObserver(() => {
			term.options.theme = xtermTheme();
		});
		themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

		return () => {
			disposed = true;
			clearTimeout(resizeTimer);
			observer.disconnect();
			themeObserver.disconnect();
			offData();
			onInput.dispose();
			term.dispose();
		};
	}, [hostId, generation]);

	useEffect(() => {
		if (!readOnly) container.current?.querySelector("textarea")?.focus();
	}, [readOnly]);

	return <div ref={container} role="application" aria-label={t("terminal.mirrorLabel")} className="h-full min-h-0 w-full" />;
}

/** Recognisable name of the omp screen on show, refreshed as omp repaints. */
function useScreenName(hostId: string | null, tuiKey: string): ScreenKey | null {
	const [name, setName] = useState<ScreenKey | null>(null);
	useEffect(() => {
		if (!hostId) return;
		let live = true;
		let timer: number | undefined;
		const refresh = () => {
			clearTimeout(timer);
			timer = window.setTimeout(() => {
				void window.vomp
					.invoke("host:screen", hostId)
					.then(lines => {
						if (live) setName(screenName(lines));
					})
					.catch(() => undefined);
			}, 250);
		};
		refresh();
		const off = window.vomp.on("host:data", ({ hostId: id }) => {
			if (id === hostId) refresh();
		});
		return () => {
			live = false;
			clearTimeout(timer);
			off();
		};
	}, [hostId, tuiKey]);
	return name;
}

function TerminalSheet({ tabId, controller }: { tabId: string; controller: SessionController }) {
	const { t } = useTranslation("palette");
	const view = useSessionView(controller);
	const [expanded, setExpanded] = useState(false);
	const [confirmLeave, setConfirmLeave] = useState(false);
	const host = view?.host ?? null;
	const hostId = host && host.phase !== "exited" ? host.hostId : null;
	const readOnly = view?.readOnly ?? false;
	const tui = host?.tui ?? null;
	const screen = useScreenName(hostId, `${tui?.overlays ?? 0}|${tui?.focused ?? ""}|${tui?.overlayKinds.join(",") ?? ""}`);
	/** The hidden terminal's size before the sheet resized it. */
	const previousSize = useRef<{ hostId: string; cols: number; rows: number } | null>(null);

	useEffect(() => {
		if (!readOnly) void controller.ensureLive().catch(() => undefined);
	}, [controller, readOnly]);

	if (host && host.phase !== "exited" && previousSize.current?.hostId !== host.hostId) {
		previousSize.current = { hostId: host.hostId, cols: host.cols, rows: host.rows };
	}
	useEffect(
		() => () => {
			const size = previousSize.current;
			if (size) void window.vomp.invoke("host:resize", size.hostId, size.cols, size.rows).catch(() => undefined);
			if (autoOpened.tabId === tabId) autoOpened.tabId = null;
		},
		[tabId],
	);

	const close = () => useApp.getState().closeTerminal();
	const overlaysOpen = () => (controller.getSnapshot().host?.tui?.overlays ?? 0) > 0;
	const requestClose = () => {
		if (overlaysOpen() && !readOnly && view?.mode === "live") setConfirmLeave(true);
		else close();
	};
	terminalSheet.requestClose = requestClose;
	useEffect(
		() => () => {
			terminalSheet.requestClose = null;
		},
		[],
	);
	const leave = async () => {
		setConfirmLeave(false);
		await controller.keys("escape");
		close();
	};

	const title = screen ? t("terminal.titleWith", { screen: t(`screens.${screen}`) }) : t("terminal.title");
	const mode = view?.mode ?? "starting";

	return (
		<Sheet
			open
			onOpenChange={open => {
				if (!open) requestClose();
			}}
		>
			<SheetContent
				side="bottom"
				height={expanded ? "calc(100vh - var(--titlebar-h) - 16px)" : "80vh"}
				title={
					<span className="flex items-center gap-2">
						<TerminalWindow aria-hidden className="size-4 text-fg-muted" />
						<span className="truncate text-md">{title}</span>
					</span>
				}
				description={readOnly ? t("terminal.readOnly") : t("terminal.hint")}
				actions={
					<IconButton
						label={expanded ? t("terminal.shrink") : t("terminal.expand")}
						icon={expanded ? <ArrowsIn /> : <ArrowsOut />}
						onClick={() => setExpanded(value => !value)}
					/>
				}
				onEscapeKeyDown={event => {
					// Esc inside the mirror belongs to omp (the key handler decides); elsewhere it closes.
					event.preventDefault();
					if (!(event.target instanceof Element && event.target.closest(".xterm"))) requestClose();
				}}
				onOpenAutoFocus={event => event.preventDefault()}
				bodyClassName="flex flex-col gap-2 overflow-hidden bg-inset p-3"
			>
				<Expand open={mode === "reconnecting"}>
					<div role="status" className="flex h-8 shrink-0 items-center gap-2 rounded-md bg-warn-bg px-3 text-sm text-warn">
						<Spinner size={12} tone="current" />
						{t("terminal.reconnecting")}
					</div>
				</Expand>
				<Expand open={mode === "exited"}>
					<div role="alert" className="flex h-9 shrink-0 items-center gap-2 rounded-md bg-err-bg px-3 text-sm text-err">
						<Warning aria-hidden className="size-4" />
						<span className="flex-1">{t("terminal.disconnected")}</span>
						<Button size="sm" variant="secondary" icon={<ArrowCounterClockwise />} onClick={() => void controller.restart()}>
							{t("terminal.restart")}
						</Button>
					</div>
				</Expand>
				<div className={cn("min-h-0 flex-1 transition-opacity duration-(--dur-slow)", mode === "exited" && "opacity-60")}>
					{hostId && host ? (
						<Mirror
							hostId={hostId}
							generation={host.generation}
							readOnly={readOnly || mode !== "live"}
							onIdleEscape={requestClose}
							overlaysOpen={overlaysOpen}
						/>
					) : readOnly ? (
						<EmptyState icon={<TerminalWindow />} title={t("terminal.readOnly")} />
					) : mode !== "exited" ? (
						<div className="flex h-full items-center justify-center gap-2 text-md text-fg-muted">
							<Spinner size={14} />
							{t("terminal.starting")}
						</div>
					) : null}
				</div>
			</SheetContent>
			<Dialog open={confirmLeave} onOpenChange={setConfirmLeave}>
				<DialogContent
					size="sm"
					title={t("terminal.leaveTitle")}
					description={t("terminal.leaveBody")}
					footer={
						<>
							<Button variant="secondary" onClick={() => setConfirmLeave(false)}>
								{t("terminal.stay")}
							</Button>
							<Button variant="primary" onClick={() => void leave()}>
								{t("terminal.leave")}
							</Button>
						</>
					}
				/>
			</Dialog>
		</Sheet>
	);
}

/** Mounted once at the app root; follows `useApp().terminalTabId`. */
export function TerminalSheetHost() {
	const tabId = useApp(state => state.terminalTabId);
	const controller = controllerFor(tabId);
	if (!tabId || !controller) return null;
	return <TerminalSheet key={tabId} tabId={tabId} controller={controller} />;
}
