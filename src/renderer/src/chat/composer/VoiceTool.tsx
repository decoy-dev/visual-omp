/** Draft-only omp RPC dictation reports recording readiness and cancels a pending start. */
import { CircleNotch, Microphone, Square } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import type { ChatSlotProps } from "../../registry/slots";
import { useApp } from "../../state/app";
import { Button, cn, Dialog, DialogContent, spring, toast, Tooltip } from "../../ui";
import { runInTerminal } from "../../features/panes/terminal";
import { useComposerDrafts } from "./drafts";

interface VoiceRequests {
	start: { tabId: string; seq: number } | null;
	requestStart(tabId: string): void;
}
export const useVoiceRequests = create<VoiceRequests>()(set => ({
	start: null,
	requestStart: tabId => set(state => ({ start: { tabId, seq: (state.start?.seq ?? 0) + 1 } })),
}));
type VoiceState = "idle" | "starting" | "recording" | "transcribing";

export function VoiceTool({ session }: ChatSlotProps) {
	const { t } = useTranslation("composer");
	const voiceOn = useApp(state => state.prefs?.voiceInput ?? false);
	const readOnly = useSyncExternalStore(session.subscribe, () => session.getSnapshot().readOnly);
	const [state, setState] = useState<VoiceState>("idle");
	const [consent, setConsent] = useState(false);
	const capture = useRef<{ id: string; cancelled: boolean; state: VoiceState } | null>(null);
	const setUpVoice = () => void runInTerminal(session.projectPath, "omp setup speech", session.tabId);
	const failed = (error: unknown) => toast({ tone: "err", message: t("voice.failed"), description: String(error), action: { label: t("voice.setUp"), onClick: setUpVoice } });

	useEffect(() => {
		let mounted = true;
		const off = window.vomp.on("composer:dictation", update => {
			const current = capture.current;
			if (!current || update.captureId !== current.id) return;
			if (update.state !== "ended") {
				current.state = update.state;
				if (mounted && !current.cancelled) setState(update.state);
				return;
			}
			capture.current = null;
			if (mounted) setState("idle");
			else off();
			if (current.cancelled) return;
			const text = update.text.trim();
			if (text) useComposerDrafts.getState().insert(session.tabId, text);
			if (update.error) failed(update.error);
			else if (!text) toast({ tone: "info", message: t("voice.nothing"), description: t("voice.nothingBody"), action: { label: t("voice.setUp"), onClick: setUpVoice } });
		});
		return () => {
			mounted = false;
			const current = capture.current;
			if (!current) { off(); return; }
			current.cancelled ||= current.state === "starting";
			// Finish a recording into its original draft if the reader changes chats.
			void window.vomp.invoke("composer:voiceStop", current.id).catch(() => {}).finally(off);
		};
	}, [session, t]);

	const start = async () => {
		if (capture.current || readOnly) return;
		const current = { id: crypto.randomUUID(), cancelled: false, state: "starting" as VoiceState };
		capture.current = current;
		setState("starting");
		try {
			await window.vomp.invoke("composer:voiceStart", session.projectPath, current.id);
		} catch (error) {
			if (capture.current !== current) return;
			capture.current = null;
			setState("idle");
			if (!current.cancelled) failed(error);
		}
	};
	const stop = async () => {
		const current = capture.current;
		if (!current) return;
		current.cancelled = state === "starting";
		// Keep cancellation in Starting until omp's terminal frame, without a transcription timeout.
		if (!current.cancelled) setState("transcribing");
		try { await window.vomp.invoke("composer:voiceStop", current.id); }
		catch (error) {
			if (capture.current !== current) return;
			capture.current = null;
			setState("idle");
			if (!current.cancelled) failed(error);
		}
	};
	const onClick = () => {
		if (state === "recording" || state === "starting") void stop();
		else if (state === "idle") {
			if (voiceOn) void start();
			else setConsent(true);
		}
	};
	const startRequest = useVoiceRequests(store => store.start);
	const handled = useRef(startRequest?.seq ?? 0);
	useEffect(() => {
		if (!startRequest || startRequest.seq === handled.current) return;
		handled.current = startRequest.seq;
		if (startRequest.tabId === session.tabId && state === "idle") onClick();
	});
	const enable = async () => {
		setConsent(false);
		try {
			await useApp.getState().setPrefs({ voiceInput: true });
			toast({ tone: "ok", message: t("voice.ready") });
		} catch (error) { failed(error); }
	};
	const recording = state === "recording";
	const busy = state === "starting" || state === "transcribing";
	const label = state === "starting" ? t("voice.cancel") : recording ? t("voice.stop") : busy ? t("voice.transcribing") : t("voice.start");
	return <>
		{(voiceOn || state !== "idle") && <>
			{busy && <span className="text-sm text-fg-muted" role="status">{t(`voice.${state}`)}</span>}
			<Tooltip content={label}>
				<button type="button" aria-label={label} aria-pressed={recording} disabled={readOnly || state === "transcribing"}
					onClick={onClick} className={cn("relative inline-flex size-8 shrink-0 items-center justify-center rounded-sm outline-none transition-colors duration-(--dur-fast)",
						"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45",
						recording ? "bg-err-bg text-err" : "text-fg-muted enabled:hover:bg-hover enabled:hover:text-fg")}>
					{recording && <span aria-hidden className="vo-ping absolute inset-0 rounded-sm ring-2 ring-err" />}
					<AnimatePresence initial={false} mode="popLayout"><motion.span key={busy ? "busy" : recording ? "recording" : "idle"}
						initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }} transition={spring.snappy} className="inline-flex">
						{busy ? <CircleNotch className="vo-spin size-4" aria-hidden /> : recording ? <Square weight="fill" className="size-3.5" aria-hidden /> : <Microphone className="size-4" aria-hidden />}
					</motion.span></AnimatePresence>
				</button>
			</Tooltip>
		</>}
		<span aria-live="polite" className="sr-only">{recording ? t("voice.listening") : ""}</span>
		<Dialog open={consent} onOpenChange={setConsent}><DialogContent size="sm" title={t("voice.consentTitle")} description={t("voice.consentBody")}
			footer={<><Button variant="ghost" onClick={setUpVoice}>{t("voice.setUp")}</Button><Button variant="primary" onClick={() => void enable()}>{t("voice.turnOn")}</Button></>}>
			<ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-fg-muted"><li>{t("voice.consentLocal")}</li><li>{t("voice.consentDownload")}</li></ul>
		</DialogContent></Dialog>
	</>;
}
