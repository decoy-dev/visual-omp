/**
 * Voice input through omp's own dictation, so it uses the speech model and language the user set up in
 * omp (default: a local model, nothing leaves the computer).
 *
 * omp has no transcription command; dictation lives in its terminal UI behind the `app.stt.toggle` key
 * (unbound by default) and needs `stt.enabled`. The app turns on `voiceInput` (SessionHost then enables
 * STT in the chat's own config overlay, never the global config), binds a function key in
 * keybindings.yml, and restarts the chat so omp picks both up. The mic presses that key in the hidden
 * TUI to start and stop; omp writes the words into its own editor, which the app reads back through
 * the TUI debug socket, moves into this composer, and clears from omp's editor with one Ctrl+C.
 */
import { CircleNotch, Microphone, Square } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import type { ChatSlotProps } from "../../registry/slots";
import { useApp } from "../../state/app";
import type { SessionController } from "../../state/session";
import { Button, cn, Dialog, DialogContent, spring, toast, Tooltip } from "../../ui";
import { runInTerminal } from "../../features/panes/terminal";
import { useComposerDrafts } from "./drafts";
import { whenLive } from "./send";

interface VoiceRequests {
	/** Tab whose dictation should start, bumped per request. */
	start: { tabId: string; seq: number } | null;
	requestStart(tabId: string): void;
}

/** Start requests from the composer's ＋ menu, which offers dictation while the row folds the mic away. */
export const useVoiceRequests = create<VoiceRequests>()(set => ({
	start: null,
	requestStart: tabId => set(state => ({ start: { tabId, seq: (state.start?.seq ?? 0) + 1 } })),
}));

type VoiceState = "idle" | "starting" | "recording" | "transcribing";

const POLL_MS = 250;
/** omp commits the last words after the stop; the editor must hold still this long to count as done. */
const SETTLE_MS = 900;
/** Local models transcribe as you talk; a cloud model uploads the whole clip on stop. */
const TRANSCRIBE_TIMEOUT_MS = 30_000;

async function readEditor(hostId: string) {
	return window.vomp.invoke("composer:tuiEditorText", hostId).catch(() => null);
}

/** Wait until omp's editor text stops changing after the stop key, then return it. */
async function settledText(hostId: string, before: string): Promise<string> {
	const deadline = Date.now() + TRANSCRIBE_TIMEOUT_MS;
	let last = before;
	let stableSince = Date.now();
	while (Date.now() < deadline) {
		const tick = Promise.withResolvers<void>();
		setTimeout(tick.resolve, POLL_MS);
		await tick.promise;
		const current = (await readEditor(hostId))?.text ?? "";
		if (current !== last) {
			last = current;
			stableSince = Date.now();
		} else if (current !== before && Date.now() - stableSince >= SETTLE_MS) {
			return current;
		}
	}
	return last === before ? "" : last;
}

function setUpVoice(session: SessionController): void {
	void runInTerminal(session.projectPath, "omp setup speech");
}

export function VoiceTool({ session }: ChatSlotProps) {
	const { t } = useTranslation("composer");
	const voiceOn = useApp(state => state.prefs?.voiceInput ?? false);
	const readOnly = useSyncExternalStore(session.subscribe, () => session.getSnapshot().readOnly);
	const [state, setState] = useState<VoiceState>("idle");
	const [consent, setConsent] = useState(false);
	const key = useRef<string | null>(null);
	const before = useRef("");
	const noticeMark = useRef(0);

	// Surface omp's own dictation warnings ("Speech-to-text is disabled", download errors) while active.
	useEffect(() => {
		if (state === "idle") return;
		return session.subscribe(() => {
			const notices = session.getSnapshot().guest?.notices ?? [];
			for (const notice of notices) {
				if (notice.id <= noticeMark.current) continue;
				noticeMark.current = notice.id;
				if (notice.level !== "info" && /speech|stt|dictation|transcri|microphone|audio/i.test(notice.message)) {
					toast({ tone: "warn", message: notice.message, action: { label: t("voice.setUp"), onClick: () => setUpVoice(session) } });
				}
			}
		});
	}, [state, session, t]);

	const start = async () => {
		setState("starting");
		try {
			const binding = await window.vomp.invoke("composer:voiceKey");
			key.current = binding.key;
			if (binding.changed && session.getSnapshot().host) {
				// omp reads keybindings at startup.
				await session.restart();
			}
			await whenLive(session);
			const hostId = session.hostId;
			if (!hostId) throw new Error("omp is not running");
			noticeMark.current = session.getSnapshot().guest?.notices.at(-1)?.id ?? 0;
			const current = await readEditor(hostId);
			if (current?.text) throw new Error(t("voice.clearTuiFirst"));
			before.current = "";
			await session.keys(binding.key);
			setState("recording");
		} catch (error) {
			setState("idle");
			toast({ tone: "err", message: t("voice.failed"), description: error instanceof Error ? error.message : String(error) });
		}
	};

	const stop = async () => {
		const hostId = session.hostId;
		if (!hostId || !key.current) {
			setState("idle");
			return;
		}
		setState("transcribing");
		try {
			await session.keys(key.current);
			const text = (await settledText(hostId, before.current)).trim();
			const spoken = before.current && text.startsWith(before.current) ? text.slice(before.current.length).trim() : text;
			if (text) {
				// Clear omp's editor (one Ctrl+C only: two within 500ms quit omp).
				await session.keys("C-c");
			}
			if (spoken) useComposerDrafts.getState().insert(session.tabId, spoken);
			else
				toast({
					tone: "info",
					message: t("voice.nothing"),
					description: t("voice.nothingBody"),
					action: { label: t("voice.setUp"), onClick: () => setUpVoice(session) },
				});
		} finally {
			setState("idle");
		}
	};

	const onClick = () => {
		if (state === "recording") void stop();
		else if (state === "idle") {
			if (voiceOn) void start();
			else setConsent(true);
		}
	};

	// A ＋ menu request starts dictation here. Requests made before this mic mounted are not replayed.
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
			await window.vomp.invoke("composer:voiceKey");
			await useApp.getState().setPrefs({ voiceInput: true });
			// SessionHost adds `stt.enabled` to a chat's config when it (re)starts.
			if (session.getSnapshot().host) await session.restart();
			toast({ tone: "ok", message: t("voice.ready") });
		} catch (error) {
			toast({ tone: "err", message: t("voice.failed"), description: error instanceof Error ? error.message : String(error) });
		}
	};

	const recording = state === "recording";
	const busy = state === "starting" || state === "transcribing";
	const label = recording ? t("voice.stop") : busy ? t(`voice.${state}`) : t("voice.start");

	return (
		<>
			<Tooltip content={label}>
				<button
					type="button"
					aria-label={label}
					aria-pressed={recording}
					disabled={readOnly || busy}
					onClick={onClick}
					className={cn(
						"relative inline-flex size-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors duration-(--dur-fast)",
						"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45",
						recording ? "bg-err-bg text-err" : "text-fg-muted enabled:hover:bg-hover enabled:hover:text-fg",
						// Folded into the ＋ menu on a narrow card, except while dictation is under way.
						state === "idle" && "group-data-fold-tools/composer:hidden",
					)}
				>
					{recording && <span aria-hidden className="vo-ping absolute inset-0 rounded-md ring-2 ring-err" />}
					<AnimatePresence initial={false} mode="popLayout">
						<motion.span
							key={busy ? "busy" : recording ? "recording" : "idle"}
							initial={{ opacity: 0, scale: 0.6 }}
							animate={{ opacity: 1, scale: 1 }}
							exit={{ opacity: 0, scale: 0.6 }}
							transition={spring.snappy}
							className="inline-flex"
						>
							{busy ? (
								<CircleNotch className="vo-spin size-4" aria-hidden />
							) : recording ? (
								<Square weight="fill" className="size-3.5" aria-hidden />
							) : (
								<Microphone className="size-4" aria-hidden />
							)}
						</motion.span>
					</AnimatePresence>
				</button>
			</Tooltip>
			<span aria-live="polite" className="sr-only">
				{recording ? t("voice.listening") : ""}
			</span>
			<Dialog open={consent} onOpenChange={setConsent}>
				<DialogContent
					size="sm"
					title={t("voice.consentTitle")}
					description={t("voice.consentBody")}
					footer={
						<>
							<Button variant="ghost" onClick={() => setUpVoice(session)}>
								{t("voice.setUp")}
							</Button>
							<Button variant="primary" onClick={() => void enable()}>
								{t("voice.turnOn")}
							</Button>
						</>
					}
				>
					<ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-fg-muted">
						<li>{t("voice.consentLocal")}</li>
						<li>{t("voice.consentDownload")}</li>
						<li>{t("voice.consentRestart")}</li>
					</ul>
				</DialogContent>
			</Dialog>
		</>
	);
}
