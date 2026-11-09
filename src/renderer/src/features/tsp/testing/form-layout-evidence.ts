/** Test-only frame recorder. Reads layout without focusing or scrolling any element. */
import type { FormButtonEvidence, FormLayoutEvidence, FormLayoutRecorder, LayoutBox } from "./form-layout-types";
function box(rect: DOMRectReadOnly): LayoutBox { return { top: rect.top, left: rect.left, width: rect.width, height: rect.height, bottom: rect.bottom }; }
function elementBox(selector: string): LayoutBox | null { const element = document.querySelector(selector); return element ? box(element.getBoundingClientRect()) : null; }
export function recordFormLayout(context: () => { requestId: number | null; claims: number }): FormLayoutRecorder {
	let phase = "initial";
	let raf = 0;
	const evidence: FormLayoutEvidence = { frames: [], shifts: [], layoutShiftSupported: PerformanceObserver.supportedEntryTypes.includes("layout-shift"), viewport: { width: innerWidth, height: innerHeight }, motion: document.documentElement.dataset.motion };
	const identities = new WeakMap<HTMLButtonElement, number>();
	let nextIdentity = 0;
	const buttons = (selector: string): FormButtonEvidence[] => [...document.querySelectorAll<HTMLButtonElement>(selector)].map(button => {
		let id = identities.get(button);
		if (id === undefined) { id = ++nextIdentity; identities.set(button, id); }
		let effectiveOpacity = 1;
		for (let node: HTMLElement | null = button; node; node = node.parentElement) effectiveOpacity *= Number(getComputedStyle(node).opacity);
		return { id, text: button.textContent?.trim() ?? "", label: button.getAttribute("aria-label") ?? "", disabledAttribute: button.hasAttribute("disabled"), disabled: button.matches(":disabled"), opacity: Number(getComputedStyle(button).opacity), effectiveOpacity, box: box(button.getBoundingClientRect()) };
	});
	const observer = evidence.layoutShiftSupported ? new PerformanceObserver(list => {
		for (const entry of list.getEntries()) {
			const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Node; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[] };
			evidence.shifts.push({ time: entry.startTime, value: shift.value, hadRecentInput: shift.hadRecentInput, sources: (shift.sources ?? []).map(source => ({ node: source.node instanceof Element ? `${source.node.tagName.toLowerCase()}${source.node.getAttribute("data-question-card") ? `[data-question-card="${source.node.getAttribute("data-question-card")}"]` : ""}` : null, previousRect: box(source.previousRect), currentRect: box(source.currentRect) })) });
		}
	}) : null;
	observer?.observe({ type: "layout-shift", buffered: false });
	const sample = (time: number) => {
		const transcript = document.querySelector<HTMLElement>('[data-form-layout] [role="log"]');
		const focus = document.activeElement;
		const text = (selector: string) => document.querySelector(selector)?.textContent?.trim() ?? "";
		const questionText = { header: text("[data-gate-header] [role=status]"), placeholder: document.querySelector<HTMLTextAreaElement>("[data-gate-composer] textarea")?.placeholder ?? "", composerHint: text("[data-gate-composer] [data-question-hint]"), cardHint: text("[data-form-status-text]"), working: text("[data-gate-working]") };
		const controls = { card: buttons("[data-form-question] [data-question-card] button"), composer: buttons("[data-gate-composer] [data-composer-actions] button") };
		evidence.frames.push({ time, phase, ...context(), questionText, buttons: controls, card: elementBox("[data-form-layout] [data-question-card]"), form: elementBox("[data-form-layout] [data-form-question]"), transcript: transcript ? { ...box(transcript.getBoundingClientRect()), scrollTop: transcript.scrollTop, scrollHeight: transcript.scrollHeight, clientHeight: transcript.clientHeight } : null, composer: elementBox("[data-gate-composer]"), composerInput: elementBox("[data-gate-composer] textarea"), focus: focus instanceof HTMLElement ? { tag: focus.tagName, label: focus.getAttribute("aria-label"), text: focus.textContent?.trim().slice(0, 100) ?? "", questionId: focus.closest("[data-question-card]")?.getAttribute("data-question-card") ?? null } : null, status: [...document.querySelectorAll('[data-form-layout] [role="status"], [data-form-layout] [data-form-question] p')].map(element => element.textContent?.trim() ?? "").filter(Boolean), busy: document.querySelector("[data-form-question]")?.getAttribute("aria-busy") ?? null, screen: !!document.querySelector(".tsp-screen"), documentScroll: document.scrollingElement?.scrollTop ?? 0 });
		raf = requestAnimationFrame(sample);
	};
	raf = requestAnimationFrame(sample);
	return { mark(value: string) { phase = value; }, stop() { cancelAnimationFrame(raf); observer?.disconnect(); return evidence; } };
}
