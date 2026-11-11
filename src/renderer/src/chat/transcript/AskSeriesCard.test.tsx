// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { SessionController } from "../../state/session";
import { AskSeriesCard } from "./AskSeriesCard";
import type { AskSeriesState } from "./askSeriesStore";

vi.mock("./askSeriesStore", () => ({ askSeriesFor: () => ({ pendingRequest: () => null }) }));

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
		const html = renderToStaticMarkup(createElement(AskSeriesCard, { session, series }));
		const root = document.createElement("div");
		root.innerHTML = html;
		expect([...root.querySelectorAll("code")].map(code => code.textContent)).toEqual(["db.name", "config.yml", "mode"]);
	});
});
