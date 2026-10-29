import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionController, SessionView } from "../state/session";
import "../i18n";

const actions = vi.hoisted(() => ({ clicks: [] as (() => void)[], newChat: vi.fn(), ensureLive: vi.fn(), restore: vi.fn() }));
vi.mock("../registry/slots", () => ({ chatSlots: { use: () => [] } }));
vi.mock("../shell/hooks", () => ({ elapsed: vi.fn(), useNow: vi.fn(), useSessionView: vi.fn() }));
vi.mock("../state/app", () => ({ useApp: { getState: () => ({ newChat: actions.newChat }) } }));
vi.mock("../ui", () => {
	return {
		cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
		Button: ({ onClick, children }: { onClick: () => void; children: ReactNode }) => {
			actions.clicks.push(onClick);
			return createElement("button", null, children);
		},
		Expand: () => null,
		WorkingIndicator: () => null,
	};
});
vi.mock("./composer/Composer", () => ({ Composer: () => null }));
vi.mock("./SessionHeader", () => ({ SessionHeader: () => null }));
vi.mock("./transcript/Transcript", () => ({ Transcript: () => null }));

import { StateBanner } from "./ChatView";

beforeEach(() => { actions.clicks.length = 0; actions.newChat.mockClear(); actions.ensureLive.mockClear(); actions.restore.mockClear(); });

function render(reason: string | null, missing = false, error: string | null = null, restore = false): string {
	const session = { projectPath: "/chosen/folder", ensureLive: actions.ensureLive, restore: actions.restore } as unknown as SessionController;
	const view = { mode: "exited", readOnly: false, error, host: { exitCode: 1, exitReason: reason, resumeFileMissing: missing, restoreAvailable: restore } } as SessionView;
	return renderToStaticMarkup(createElement(StateBanner, { session, view }));
}

describe("startup exit banner", () => {
	it("shows the missing session path and starts a fresh chat in the same folder", () => {
		const html = render("Session file not found: /chosen/folder/missing.jsonl", true);
		expect(html).toContain("Session file not found: /chosen/folder/missing.jsonl");
		expect(html).toContain("Start a fresh chat");
		expect(html).not.toContain("Start omp again");
		actions.clicks[0]();
		expect(actions.newChat).toHaveBeenCalledWith("/chosen/folder");
		expect(actions.ensureLive).not.toHaveBeenCalled();
	});

	it("shows the named model error and preserves the restart action", () => {
		const html = render("Model unavailable: provider/model-name\nretry.modelFallback is disabled.");
		expect(html).toContain("provider/model-name");
		expect(html).toContain("retry.modelFallback is disabled.");
		expect(html).toContain("Start omp again");
		actions.clicks[0]();
		expect(actions.ensureLive).toHaveBeenCalledOnce();
		expect(actions.newChat).not.toHaveBeenCalled();
	});

	it("keeps a launch error when no terminal reason was reported", () => {
		expect(render(null, false, "Permission denied")).toContain("Permission denied");
	});
});

it("offers explicit crash recovery without silently choosing it for an ordinary restart", () => {
	expect(render(null, false, null, true)).toContain("Continue where omp stopped");
	actions.clicks[0]();
	expect(actions.restore).toHaveBeenCalledOnce();
	expect(actions.ensureLive).not.toHaveBeenCalled();
});
