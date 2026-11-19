// @vitest-environment happy-dom
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as UiModule from "../../ui";
import "../../i18n";
import { TooltipProvider } from "../../ui/Tooltip";
import type { SessionController } from "../../state/session";
import { defaultAnswer, parseAskFormQuestions } from "./askSeries";
import { AskSeriesCard } from "./AskSeriesCard";
import type { AskSeriesState } from "./askSeriesStore";

const cardMocks = vi.hoisted(() => ({
	driver: {
		pendingRequest: vi.fn(() => null),
		show: vi.fn(),
		setAnswer: vi.fn(),
		submit: vi.fn(),
		skipQuestion: vi.fn(),
		skip: vi.fn(),
		cancelForm: vi.fn(),
		chat: vi.fn(),
	},
	show: null as ((index: number) => void) | null,
	skip: null as (() => void) | null,
}));

vi.mock("./askSeriesStore", () => ({ askSeriesFor: () => cardMocks.driver }));
vi.mock("../../ui", async importOriginal => {
	const actual = await importOriginal<typeof UiModule>();
	return {
		...actual,
		PresenceSwap: ({ children, swapKey, direction }: { children: ReactNode; swapKey: number; direction: 1 | -1 }) =>
			<div key={swapKey} data-test-swap-direction={direction}>{children}</div>,
	};
});

beforeEach(() => {
	vi.clearAllMocks();
	cardMocks.show = null;
	cardMocks.skip = null;
});

afterEach(() => {
	cardMocks.show = null;
	cardMocks.skip = null;
});

describe("AskSeriesCard", () => {
	it("renders question and option code spans", () => {
		const question: AskSeriesState["questions"][number] = {
			id: "db",
			question: "Save `db.name`?",
			options: [{ label: "Use `config.yml`", description: "Set `mode`" }],
			multi: false,
		};
		const series: AskSeriesState = {
			toolCallId: "call-1",
			room: { hostId: "host-1", generation: 1, client: {} },
			heldReqId: 1,
			questions: [question],
			answers: [{ selected: [0], custom: "" }],
			index: 0,
			phase: "editing",
			cursor: { question: 0, awaiting: "select", steps: 0 },
			fallbackReason: null,
			fallbackWhileSending: false,
		};
		const session = {} as SessionController;
		const html = renderToStaticMarkup(<TooltipProvider><AskSeriesCard session={session} series={series} /></TooltipProvider>);
		const root = document.createElement("div");
		root.innerHTML = html;
		expect([...root.querySelectorAll("code")].map(code => code.textContent)).toEqual(["db.name", "config.yml", "mode"]);
	});

	it("renders a one-field form with skip and cancel actions and no terminal hints", () => {
		const htmlSource = '<form><p>Keep the note concise.</p><label>Release note<textarea name="note">Default note</textarea></label></form>';
		const question = parseAskFormQuestions(htmlSource)![0]!;
		const series: AskSeriesState = {
			toolCallId: "form-call",
			room: { hostId: "host-1", generation: 1, client: {} },
			heldReqId: 1,
			questions: [question],
			answers: [{ selected: [], custom: "", text: "Default note" }],
			formHtml: htmlSource,
			index: 0,
			phase: "editing",
			cursor: { question: 0, awaiting: "select", steps: 0 },
			fallbackReason: null,
			fallbackWhileSending: false,
		};
		const html = renderToStaticMarkup(<TooltipProvider><AskSeriesCard session={{} as SessionController} series={series} /></TooltipProvider>);
		const root = document.createElement("div");
		root.innerHTML = html;
		expect(root.textContent).toContain("Keep the note concise.");
		expect(root.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Default note");
		// The only question is also the last, so skipping it sends the form.
		expect(root.textContent).toContain("Skip and send answers");
		// Cancel form and stop reply lives in the ⋯ menu at the top right, which closed markup shows as its button.
		expect(root.querySelector('[data-card-actions][aria-label="More actions"]')).not.toBeNull();
		expect([...root.querySelectorAll("button")].some(button => button.textContent?.trim() === "Cancel form and stop reply")).toBe(false);
		expect(root.textContent).not.toContain("Question 1 of 1");
		expect(root.textContent).not.toContain("Skip questions");
		expect(root.textContent).not.toContain("↑/↓ navigate Enter toggle Next → continue Escape cancel");
	});
	it("explains why a required empty field cannot be skipped", () => {
		const htmlSource = '<form><label>Release note<textarea name="note" required></textarea></label></form>';
		const question = parseAskFormQuestions(htmlSource)![0]!;
		const series: AskSeriesState = {
			toolCallId: "form-call",
			room: { hostId: "host-1", generation: 1, client: {} },
			heldReqId: 1,
			questions: [question],
			answers: [{ selected: [], custom: "", text: "" }],
			formHtml: htmlSource,
			index: 0,
			phase: "editing",
			cursor: { question: 0, awaiting: "select", steps: 0 },
			fallbackReason: null,
			fallbackWhileSending: false,
		};
		const html = renderToStaticMarkup(<TooltipProvider><AskSeriesCard session={{} as SessionController} series={series} /></TooltipProvider>);
		const root = document.createElement("div");
		root.innerHTML = html;
		const skip = [...root.querySelectorAll("button")].find(button => button.textContent?.trim() === "Skip and send answers");
		expect(skip?.disabled).toBe(true);
		expect(root.textContent).toContain("This question needs an answer and the form leaves it empty, so it can't be skipped.");
	});
	it("shows safe form context and option descriptions", () => {
		const htmlSource = `<form>
			<p>Choose a channel for this release.</p>
			<fieldset><legend>Release channel</legend>
				<label><input type="radio" name="channel" value="stable" checked>Stable<br><small>Use the tested channel.</small></label>
				<label><input type="radio" name="channel" value="preview" disabled>Preview<br><small>Hold back preview builds.</small></label>
			</fieldset>
		</form>`;
		const question = parseAskFormQuestions(htmlSource)![0]!;
		const series: AskSeriesState = {
			toolCallId: "form-call",
			room: { hostId: "host-1", generation: 1, client: {} },
			heldReqId: 1,
			questions: [question],
			answers: [{ selected: [0], custom: "", text: "" }],
			formHtml: htmlSource,
			index: 0,
			phase: "editing",
			cursor: { question: 0, awaiting: "select", steps: 0 },
			fallbackReason: null,
			fallbackWhileSending: false,
		};
		const root = document.createElement("div");
		root.innerHTML = renderToStaticMarkup(<TooltipProvider><AskSeriesCard session={{} as SessionController} series={series} /></TooltipProvider>);
		expect(root.querySelector("[data-form-context]")?.textContent).toContain("Choose a channel for this release.");
		expect(root.querySelector('[data-choice="0"]')?.querySelector(".text-md.font-medium")?.textContent).toBe("Stable");
		expect(root.querySelector('[data-choice="0"]')?.querySelector(".text-sm.text-fg-muted")?.textContent).toBe("Use the tested channel.");
		expect(root.textContent).not.toContain("Preview");
	});
	it("moves a skipped form field forward and focuses the arriving question", async () => {
		const htmlSource = `<form>
			<fieldset><legend>First note</legend><label>First note<textarea name="first" required>First default</textarea></label></fieldset>
			<fieldset><legend>Second note</legend><label>Second note<textarea name="second" required>Second default</textarea></label></fieldset>
			<fieldset><legend>Third note</legend><label>Third note<textarea name="third" required>Third default</textarea></label></fieldset>
		</form>`;
		const questions = parseAskFormQuestions(htmlSource)!;
		const series: AskSeriesState = {
			toolCallId: "skip-focus",
			room: { hostId: "host-1", generation: 1, client: {} },
			heldReqId: 1,
			questions,
			answers: questions.map(defaultAnswer),
			formHtml: htmlSource,
			index: 2,
			phase: "editing",
			cursor: { question: 0, awaiting: "select", steps: 0 },
			fallbackReason: null,
			fallbackWhileSending: false,
		};
		cardMocks.driver.show.mockImplementation((index: number) => cardMocks.show?.(index));
		cardMocks.driver.skipQuestion.mockImplementation(() => cardMocks.skip?.());
		function Harness() {
			const [current, setCurrent] = useState(series);
			cardMocks.show = index => setCurrent(previous => ({ ...previous, index }));
			cardMocks.skip = () => setCurrent(previous => ({
				...previous,
				index: previous.index + 1,
				answers: previous.answers.map((answer, index) => index === previous.index ? defaultAnswer(previous.questions[index]!) : answer),
			}));
			return createElement(AskSeriesCard, { session: {} as SessionController, series: current });
		}
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		try {
			await act(async () => root.render(<TooltipProvider><Harness /></TooltipProvider>));
			const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label)!;
			await act(async () => button("Previous question").click());
			expect(host.querySelector("[data-test-swap-direction]")?.getAttribute("data-test-swap-direction")).toBe("-1");
			expect(document.activeElement?.tagName).toBe("TEXTAREA");
			await act(async () => button("Skip this question").click());
			expect(cardMocks.driver.skipQuestion).toHaveBeenCalledOnce();
			expect(host.querySelector("[data-test-swap-direction]")?.getAttribute("data-test-swap-direction")).toBe("1");
			const arriving = host.querySelector<HTMLTextAreaElement>("textarea");
			expect(arriving?.value).toBe("Third default");
			expect(document.activeElement).toBe(arriving);
		} finally {
			await act(async () => root.unmount());
			host.remove();
		}
	});
});
