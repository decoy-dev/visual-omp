import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionController } from "../../state/session";
import { parseOmpDialog } from "./ompDialog";
import { submitText } from "./ompDialogActions";

const drive = vi.hoisted(() => ({ press: vi.fn(), readScreen: vi.fn(), waitForScreen: vi.fn() }));
vi.mock("./drive", () => drive);
vi.mock("../../i18n", () => ({ i18n: { t: (key: string) => key } }));
const fixtures = import.meta.glob<string>("./fixtures/omp-dialogs/*.txt", { query: "?raw", import: "default", eager: true });

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("native text dialog submission", () => {
	it("does not press the submit key when shutdown rejects an application paste", async () => {
		const lines = fixtures["./fixtures/omp-dialogs/input-empty.txt"]!.split("\n");
		const dialog = parseOmpDialog(lines);
		if (dialog?.kind !== "input") throw new Error("Expected the captured empty text dialog");
		drive.readScreen.mockResolvedValue(lines);
		const paste = Promise.withResolvers<void>();
		const invoke = vi.fn(() => paste.promise);
		vi.stubGlobal("window", { vomp: { invoke } });
		const session = { hostId: "host" } as SessionController;
		const pending = submitText(session, dialog, "A native dialog answer");
		const rejected = expect(pending).rejects.toThrow("closing this chat");
		await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("host:paste", "host", "A native dialog answer"));
		paste.reject(new Error("omp is closing this chat. The message was not submitted."));
		await rejected;
		expect(drive.press).not.toHaveBeenCalled();
		expect(drive.waitForScreen).not.toHaveBeenCalled();
	});
});
