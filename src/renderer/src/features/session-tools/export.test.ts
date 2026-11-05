import { beforeEach, expect, it, vi } from "vitest";
import type { SessionController } from "../../state/session";
import type { CommandOptions, CommandResult } from "./drive";
import { exportChat } from "./export";

const fake = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn(), ready: vi.fn(), run: vi.fn(), failure: vi.fn(), output: vi.fn() }));
vi.mock("@/ui", () => ({ toast: fake.toast }));
vi.mock("../../i18n", () => ({ i18n: { t: (key: string, args?: { path: string }) => args ? `Session exported to: ${args.path}` : key } }));
vi.mock("./drive", () => ({ readyEditor: fake.ready, runCommand: fake.run, reportFailure: fake.failure, reportOutput: fake.output }));
const session = { sessionFile: "/sessions/chat.jsonl", projectPath: "/project" } as SessionController;

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubGlobal("window", { vomp: { invoke: fake.invoke } });
	fake.invoke.mockResolvedValue({ path: "/project/omp-session-chat.html", command: "/export /project/omp-session-chat.html" });
	fake.run.mockImplementation(async (_session: SessionController, _line: string, options: CommandOptions) => {
		const result: CommandResult = { output: ["Session exported to: C:\\project\\chat.html"], screen: [] };
		options.present?.(result);
		return result;
	});
});

it("uses the live absolute export and preserves the Windows drive in Show for classic output", async () => {
	await exportChat(session, true);
	expect(fake.ready).toHaveBeenCalledWith(session);
	expect(fake.invoke).toHaveBeenCalledWith("share:defaultExport", session.sessionFile, session.projectPath, true);
	expect(fake.run).toHaveBeenCalledWith(session, "/export /project/omp-session-chat.html", expect.objectContaining({ timeoutMs: 10000 }));
	const toast = fake.toast.mock.calls[0]?.[0];
	expect(toast).toMatchObject({ tone: "ok", message: "Session exported to: C:\\project\\chat.html" });
	toast.action.onClick();
	expect(fake.invoke).toHaveBeenLastCalledWith("app:showItem", "C:\\project\\chat.html");
});

it("shows a completed CLI fallback without typing a slash line", async () => {
	const path = "C:\\project folder\\omp-session-chat.html";
	fake.invoke.mockResolvedValue({ path, command: null, fallback: "cli" });
	await exportChat(session);
	expect(fake.run).not.toHaveBeenCalled();
	const toast = fake.toast.mock.calls[0]?.[0];
	expect(toast).toMatchObject({ tone: "ok", message: `Session exported to: ${path}`, description: "session:export.cli" });
	toast.action.onClick();
	expect(fake.invoke).toHaveBeenLastCalledWith("app:showItem", path);
});

it("explains a live export saved in Downloads and keeps its Show action", async () => {
	const path = "C:\\Downloads\\omp-session-chat.html";
	fake.invoke.mockResolvedValue({ path, command: `/export --themes ${path}`, fallback: "downloads" });
	fake.run.mockImplementation(async (_session, _line, options: CommandOptions) => {
		const result = { output: [`Session exported to: ${path}`], screen: [], status: "success" as const };
		options.present?.(result);
		return result;
	});
	await exportChat(session, true);
	expect(fake.run).toHaveBeenCalledWith(session, `/export --themes ${path}`, expect.any(Object));
	const toast = fake.toast.mock.calls[0]?.[0];
	expect(toast).toMatchObject({ tone: "ok", message: `Session exported to: ${path}`, description: "session:export.downloads" });
	toast.action.onClick();
	expect(fake.invoke).toHaveBeenLastCalledWith("app:showItem", path);
});

it.each(["error", "cancelled", undefined] as const)("reports failed export feedback through the existing output handler: %s", async status => {
	const result = { output: ["Failed to export session: EACCES"], screen: [], status };
	fake.run.mockImplementation(async (_session, _line, options: CommandOptions) => { options.present?.(result); return result; });
	await exportChat(session);
	expect(fake.output).toHaveBeenCalledWith(result.output, undefined, status);
	expect(fake.toast).not.toHaveBeenCalled();
});

it("reports CLI failures through the existing failure handler", async () => {
	const error = new Error("Export failed");
	fake.invoke.mockRejectedValue(error);
	await exportChat(session);
	expect(fake.failure).toHaveBeenCalledWith(error);
	expect(fake.toast).not.toHaveBeenCalled();
});

it("reads the session file after readiness and reports an unsaved chat", async () => {
	await exportChat({ ...session, sessionFile: null } as unknown as SessionController);
	expect(fake.failure).toHaveBeenCalledWith(expect.objectContaining({ message: "session:export.unsaved" }));
	expect(fake.invoke).not.toHaveBeenCalled();
});
