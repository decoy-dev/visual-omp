import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
	realpath: vi.fn(), stat: vi.fn(), previewablePath: vi.fn(), showItemInFolder: vi.fn(), openPath: vi.fn(), showMessageBox: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ realpath: deps.realpath, stat: deps.stat }));
vi.mock("electron", () => ({
	BrowserWindow: { getFocusedWindow: () => null },
	dialog: { showMessageBox: deps.showMessageBox },
	shell: { showItemInFolder: deps.showItemInFolder, openPath: deps.openPath },
}));
vi.mock("./services/panes", () => ({ previewablePath: deps.previewablePath }));
import { localFilePath, openFile, showItem } from "./fileActions";

beforeEach(() => {
	vi.resetAllMocks();
	deps.realpath.mockImplementation(async (path: string) => path);
	deps.stat.mockResolvedValue({ isFile: () => true });
	deps.previewablePath.mockResolvedValue(undefined);
	deps.openPath.mockResolvedValue("");
});

const invalid: unknown[] = [null, undefined, 12, {}, "", "relative/file", "file:///tmp/file", "/tmp/\0file", "\\\\server\\share\\file", "//server/share/file", "\\\\?\\C:\\file", "\\\\.\\PhysicalDrive0", "\\??\\C:\\file", "/\\server/share/file"];

describe("file action IPC handlers", () => {
	it.each(invalid)("refuses invalid reveal input before invoking the shell: %j", value => {
		expect(() => showItem(value)).toThrow("absolute local path");
		expect(deps.showItemInFolder).not.toHaveBeenCalled();
		expect(deps.realpath).not.toHaveBeenCalled();
		expect(deps.stat).not.toHaveBeenCalled();
	});
	it.each(invalid)("refuses invalid open input before filesystem or shell access: %j", async value => {
		await expect(openFile(value)).rejects.toThrow("absolute local path");
		expect(deps.realpath).not.toHaveBeenCalled();
		expect(deps.stat).not.toHaveBeenCalled();
		expect(deps.openPath).not.toHaveBeenCalled();
		expect(deps.showMessageBox).not.toHaveBeenCalled();
	});
	it("keeps local files outside the project available and preserves literal names", async () => {
		const path = resolve("/outside-project/report:12");
		showItem(path);
		await openFile(path);
		expect(deps.showItemInFolder).toHaveBeenCalledWith(path);
		expect(deps.realpath).toHaveBeenCalledWith(path);
		expect(deps.openPath).toHaveBeenCalledWith(path);
	});
	it("rejects a resolved network path before stat or opening", async () => {
		deps.realpath.mockResolvedValue("\\\\server\\share\\file");
		await expect(openFile(resolve("/local/link"))).rejects.toThrow("absolute local path");
		expect(deps.stat).not.toHaveBeenCalled();
		expect(deps.openPath).not.toHaveBeenCalled();
	});
	it("retains confirmation for other regular files and honors cancellation", async () => {
		deps.previewablePath.mockRejectedValue(new Error("Not a previewable file"));
		deps.showMessageBox.mockResolvedValue({ response: 0 });
		await openFile(resolve("/outside-project/script.sh"));
		expect(deps.showMessageBox).toHaveBeenCalled();
		expect(deps.openPath).not.toHaveBeenCalled();
	});
});

describe("platform-local absolute paths", () => {
	it("accepts drive-rooted Windows paths but refuses root-relative and device paths", () => {
		expect(localFilePath("C:\\outside\\report.txt", "win32")).toBe("C:\\outside\\report.txt");
		expect(localFilePath("D:/outside/report.txt", "win32")).toBe("D:/outside/report.txt");
		for (const path of ["C:relative.txt", "\\root-relative.txt", "\\\\server\\share\\file", "\\\\?\\C:\\file", "\\\\.\\C:\\file", "\\??\\C:\\file"]) expect(() => localFilePath(path, "win32")).toThrow();
	});
	it("preserves POSIX punctuation and outside-project paths", () => {
		for (const path of ["/work/report:12", "/outside/what?", "/outside/star*", "/outside/ spaced "]) expect(localFilePath(path, "darwin")).toBe(path);
	});
});
