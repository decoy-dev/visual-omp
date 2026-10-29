import type { PredictionCapture } from "@shared/contracts/composer";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";
import { useApp } from "../../state/app";
import type { SessionController } from "../../state/session";
import { Button, toast } from "../../ui";
import { useComposerDrafts } from "./drafts";

const captureSchema = z.object({ id: z.string(), hostId: z.string(), generation: z.number(), tabId: z.string(), folder: z.string(), text: z.string().nullable(), blocked: z.boolean(), error: z.string().nullable() });
interface CaptureState {
	captures: PredictionCapture[];
	merge(captures: PredictionCapture[]): void;
	reconcile(captures: PredictionCapture[]): void;
	remove(id: string): void;
}
export const usePredictionCaptures = create<CaptureState>()(persist((set, get) => ({
	captures: [],
	merge(incoming) {
		const merged = new Map(get().captures.map(capture => [capture.id, capture]));
		for (const capture of incoming) merged.set(capture.id, capture);
		set({ captures: [...merged.values()] });
	},
	reconcile(incoming) {
		const active = new Set(incoming.map(capture => capture.id));
		const kept = get().captures.map(capture => active.has(capture.id) ? capture : { ...capture, blocked: false, error: null });
		set({ captures: kept });
		get().merge(incoming);
	},
	remove(id) { set({ captures: get().captures.filter(capture => capture.id !== id) }); },
}), {
	name: "vomp.composer.prediction-captures", storage: createJSONStorage(() => localStorage),
	partialize: state => ({ captures: state.captures }),
	merge(persisted, current) {
		const parsed = z.object({ captures: z.array(captureSchema) }).safeParse(persisted);
		return { ...current, captures: parsed.success ? parsed.data.captures : [] };
	},
}));

export async function acknowledgePrediction(id: string): Promise<void> {
	await window.vomp.invoke("composer:ackPrediction", id);
	usePredictionCaptures.getState().remove(id);
}

export function PredictionRecovery({ session, readOnly }: { session: SessionController; readOnly: boolean }) {
	const { t } = useTranslation("composer");
	const captures = usePredictionCaptures(state => state.captures);
	const tabs = useApp(state => state.tabs);
	const [busy, setBusy] = useState<string | null>(null);
	useEffect(() => {
		let current = true;
		const off = window.vomp.on("composer:predictionCaptures", incoming => usePredictionCaptures.getState().merge(incoming));
		void window.vomp.invoke("composer:predictionCaptures").then(incoming => {
			if (current) usePredictionCaptures.getState().reconcile(incoming);
		}).catch(() => {});
		return () => { current = false; off(); };
	}, []);
	const visible = captures.filter(capture => capture.tabId === session.tabId || !tabs.some(tab => tab.id === capture.tabId));
	if (visible.length === 0) return null;
	const run = (id: string, operation: () => Promise<void>) => {
		setBusy(id);
		void operation().catch((error: unknown) => toast({ tone: "err", message: t("prediction.recoveryFailed"), description: String(error) })).finally(() => setBusy(null));
	};
	return <section aria-label={t("prediction.saved")} className="mb-3 rounded-lg border border-border bg-panel px-3 py-2">
		<p className="text-sm font-medium text-fg">{t("prediction.saved")}</p>
		<ul className="divide-y divide-border">
			{visible.map(capture => <li key={capture.id} data-prediction-recovery={capture.id} className="py-2">
				<p className="text-sm text-fg-muted break-words">{capture.folder}</p>
				{capture.text && <p className="mt-2 max-h-32 overflow-auto text-sm whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">{capture.text}</p>}
				{capture.text === null && <p className="mt-2 text-sm text-fg-muted">{t("prediction.unreadable")}</p>}
				{capture.error && <p className="mt-2 text-sm text-fg-muted">{capture.error}</p>}
				{capture.blocked && <p className="mt-1 text-sm text-fg-muted">{t("prediction.editorBlocked")}</p>}
				<div className="mt-2 flex flex-wrap gap-2">
					{capture.blocked && <Button variant="secondary" disabled={busy === capture.id} onClick={() => run(capture.id, async () => {
						const recovered = await window.vomp.invoke("composer:retryPrediction", capture.id);
						if (recovered) usePredictionCaptures.getState().merge([recovered]);
					})}>{t("prediction.retry")}</Button>}
					{capture.blocked && session.hostId === capture.hostId && <Button variant="secondary" onClick={() => useApp.getState().openTerminal(session.tabId)}>{t("prediction.openTerminal")}</Button>}
					<Button variant="secondary" disabled={readOnly || capture.blocked || !capture.text || busy === capture.id} onClick={() => run(capture.id, async () => {
						if (capture.text) useComposerDrafts.getState().insert(session.tabId, capture.text);
						await acknowledgePrediction(capture.id);
					})}>{t("prediction.insertSaved")}</Button>
					<Button variant="ghost" disabled={capture.blocked || busy === capture.id} onClick={() => run(capture.id, () => acknowledgePrediction(capture.id))}>{t("prediction.dismiss")}</Button>
				</div>
			</li>)}
		</ul>
	</section>;
}
