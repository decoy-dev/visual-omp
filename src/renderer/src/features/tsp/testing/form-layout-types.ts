/** Serializable evidence shared by the renderer recorder and the Node gate runner. */
export interface LayoutBox { top: number; left: number; width: number; height: number; bottom: number }
export interface FormLayoutFrame {
	time: number;
	phase: string;
	requestId: number | null;
	card: LayoutBox | null;
	form: LayoutBox | null;
	transcript: (LayoutBox & { scrollTop: number; scrollHeight: number; clientHeight: number }) | null;
	composer: LayoutBox | null;
	composerInput: LayoutBox | null;
	focus: { tag: string; label: string | null; text: string; questionId: string | null } | null;
	status: string[];
	questionText: { header: string; placeholder: string; composerHint: string; cardHint: string; working: string };
	busy: string | null;
	claims: number;
	screen: boolean;
	documentScroll: number;
}
export interface FormLayoutShift { time: number; value: number; hadRecentInput: boolean; sources: { node: string | null; previousRect: LayoutBox; currentRect: LayoutBox }[] }
export interface FormLayoutEvidence { frames: FormLayoutFrame[]; shifts: FormLayoutShift[]; layoutShiftSupported: boolean; viewport: { width: number; height: number }; motion: string | undefined }
export interface FormLayoutRecorder { mark(phase: string): void; stop(): FormLayoutEvidence }
