// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactI18next from "react-i18next";
import type { CommandResultRecord } from "../../features/session-tools/results";
import session from "../../i18n/en/session.json";
import type * as UiModule from "../../ui";
import { TooltipProvider } from "../../ui/Tooltip";
import { CommandResultRow } from "./CommandResultRow";

const fake = vi.hoisted(() => ({ invoke: vi.fn(), copy: vi.fn(), toast: vi.fn(), dismiss: vi.fn(), panel: vi.fn() }));
vi.mock("react-i18next", async importOriginal => ({
	...await importOriginal<typeof ReactI18next>(),
	useTranslation: () => ({ t: (key: string, values: Record<string, string | number> = {}) => {
		const text = session.commandResult[key.split(".")[1] as keyof typeof session.commandResult];
		return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name] ?? ""));
	} }),
}));
vi.mock("../../ui", async importOriginal => ({ ...await importOriginal<typeof UiModule>(), toast: fake.toast }));
vi.mock("./TranscriptTime", () => ({ TranscriptTime: () => null }));
vi.mock("../../features/session-tools/command-panels", () => ({ CommandPanelOwnership: (props: { result: CommandResultRecord; onRelease: () => void }) => {
	fake.panel(props.result, props.onRelease);
	return null;
} }));

let root: Root;
let container: HTMLDivElement;
const base: CommandResultRecord = {
	id: "result-1", command: "/stats", lines: ["omp's exact output"], tone: "info", anchor: null, room: "session-1", createdAt: 1000,
};

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.clearAllMocks();
	fake.invoke.mockReset().mockResolvedValue(false);
	fake.copy.mockReset().mockResolvedValue(undefined);
	vi.stubGlobal("vomp", { invoke: fake.invoke });
	Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: fake.copy } });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

async function paint(result: CommandResultRecord): Promise<void> {
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(CommandResultRow, { result, onDismiss: fake.dismiss }))));
}
function button(label: string): HTMLButtonElement | undefined {
	return [...container.querySelectorAll<HTMLButtonElement>("button")].find(element => (element.getAttribute("aria-label") ?? element.textContent) === label);
}

describe("command result locations", () => {
	it("keeps omp's title, output, tone, expansion and panel ownership", async () => {
		const lines = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`);
		const result: CommandResultRecord = { ...base, title: "Session statistics", lines, tone: "warn" };
		await paint(result);
		expect(container.querySelector("h3")?.textContent).toBe(result.title);
		expect(container.querySelector(".text-warn")).not.toBeNull();
		expect(container.querySelector("pre")?.textContent).toBe(lines.slice(0, 12).join("\n"));
		expect(fake.panel).toHaveBeenLastCalledWith(result, fake.dismiss);
		await act(async () => button("Show all 14 lines")!.click());
		expect(container.querySelector("pre")?.textContent).toBe(lines.join("\n"));
		expect(button("Show fewer lines")?.getAttribute("aria-expanded")).toBe("true");
		await act(async () => button("Dismiss result")!.click());
		expect(fake.dismiss).toHaveBeenCalledOnce();
	});

	it("renders report Markdown with the shared renderer and copies its complete raw source", async () => {
		const raw = ["## Checker report", "", "| Tool | Result |", "| --- | --- |", "| `read` | Ready |", "", "```ts", "const ready = true;", "```", "", "### Details", "", "A complete report.", "", "The final line."].join("\n");
		const lines = raw.split("\n");
		await paint({ ...base, markdown: true, lines });
		expect(container.querySelector(".tr-md h2")?.textContent).toBe("Checker report");
		expect(container.querySelector(".tr-md table th")?.textContent).toBe("Tool");
		expect(container.querySelector(".tr-md pre code")?.textContent).toContain("const ready = true;");
		const content = container.querySelector(".tr-md")!.parentElement!;
		expect(content.classList.contains("max-h-96")).toBe(true);
		expect(container.querySelector(".tr-md")?.textContent).toContain("The final line.");
		await act(async () => button("Copy result")!.click());
		expect(fake.copy).toHaveBeenCalledExactlyOnceWith(raw);
		expect(fake.toast).toHaveBeenLastCalledWith({ tone: "ok", message: session.commandResult.copied });
		await act(async () => button("Show full report")!.click());
		expect(content.classList.contains("max-h-96")).toBe(false);
		await act(async () => button("Show less")!.click());
		expect(content.classList.contains("max-h-96")).toBe(true);
	});

	it.each([undefined, false])("keeps an earlier or text-only Result plain when its Markdown flag is %s", async markdown => {
		const lines = ["## Literal output", "| still | plain |"];
		await paint({ ...base, lines, ...(markdown === undefined ? {} : { markdown }) });
		expect(container.querySelector(".tr-md")).toBeNull();
		expect(container.querySelector("pre")?.textContent).toBe(lines.join("\n"));
		expect(button("Copy result")).toBeUndefined();
	});

	it("offers expansion for wrapped Markdown with fewer than twelve source lines", async () => {
		let resize: (() => void) | undefined;
		vi.stubGlobal("ResizeObserver", class {
			constructor(callback: () => void) { resize = callback; }
			observe() {}
			disconnect() {}
		});
		await paint({ ...base, markdown: true, lines: ["A long report paragraph. ".repeat(200)] });
		const content = container.querySelector(".tr-md")!.parentElement!;
		Object.defineProperties(content, { clientHeight: { configurable: true, value: 384 }, scrollHeight: { configurable: true, value: 900 } });
		await act(async () => resize!());
		expect(button("Show full report")).toBeDefined();
		await act(async () => button("Show full report")!.click());
		expect(content.classList.contains("max-h-96")).toBe(false);
	});

	it("keeps a full URL selectable and copies it without opening or revealing it", async () => {
		const value = "https://example.test/stats/session?report=full&token=a%20b#detail";
		const location = { kind: "url", value } as const;
		await paint({ ...base, locations: [location, { ...location }] });
		const literal = container.querySelector("code")!;
		expect(literal.textContent).toBe(value);
		expect(literal.classList.contains("selectable")).toBe(true);
		expect(literal.tabIndex).toBe(0);
		literal.focus();
		expect(document.activeElement).toBe(literal);
		expect(container.querySelectorAll("li")).toHaveLength(1);
		expect(container.querySelector("a")).toBeNull();
		expect(button("Show in folder")).toBeUndefined();
		expect(fake.invoke).not.toHaveBeenCalled();
		await act(async () => button("Copy URL")!.click());
		expect(fake.copy).toHaveBeenCalledExactlyOnceWith(value);
		expect(fake.toast).toHaveBeenLastCalledWith({ tone: "ok", message: session.commandResult.urlCopied });
		expect(fake.invoke).not.toHaveBeenCalled();
	});

	it.each(["/tmp/Project with spaces/session report.html", "C:\\Project with spaces\\session report.html"])("copies and reveals an existing literal path: %s", async value => {
		fake.invoke.mockResolvedValue(true);
		const location = { kind: "path", value } as const;
		await paint({ ...base, command: "/export", locations: [location, { ...location }] });
		expect(fake.invoke).toHaveBeenCalledExactlyOnceWith("fs:exists", value);
		expect(container.querySelector("code")?.textContent).toBe(value);
		expect(container.querySelectorAll("li")).toHaveLength(1);
		await act(async () => button("Copy path")!.click());
		expect(fake.copy).toHaveBeenCalledExactlyOnceWith(value);
		expect(fake.toast).toHaveBeenLastCalledWith({ tone: "ok", message: session.commandResult.pathCopied });
		await act(async () => button("Show in folder")!.click());
		expect(fake.invoke).toHaveBeenLastCalledWith("app:showItem", value);
	});

	it("leaves missing paths selectable and copyable without a reveal control", async () => {
		const value = "/tmp/missing report.html";
		await paint({ ...base, locations: [{ kind: "path", value }] });
		expect(fake.invoke).toHaveBeenCalledExactlyOnceWith("fs:exists", value);
		expect(button("Show in folder")).toBeUndefined();
		await act(async () => button("Copy path")!.click());
		expect(fake.copy).toHaveBeenCalledExactlyOnceWith(value);
		expect(fake.invoke).toHaveBeenCalledOnce();
	});

	it("does not reveal a path whose existence check failed", async () => {
		fake.invoke.mockRejectedValue(new Error("Filesystem unavailable"));
		await paint({ ...base, locations: [{ kind: "path", value: "/tmp/report.html" }] });
		expect(button("Show in folder")).toBeUndefined();
		expect(button("Copy path")).toBeDefined();
	});

	it.each(["/tmp/report.html", "/tmp/different report.html"])("ignores an old row's pending path check when the next path is %s", async nextPath => {
		const oldCheck = Promise.withResolvers<boolean>();
		fake.invoke.mockReturnValueOnce(oldCheck.promise).mockResolvedValue(false);
		await paint({ ...base, locations: [{ kind: "path", value: "/tmp/report.html" }] });
		await paint({ ...base, id: "result-2", locations: [{ kind: "path", value: nextPath }] });
		await act(async () => oldCheck.resolve(true));
		expect(container.querySelector("code")?.textContent).toBe(nextPath);
		expect(button("Show in folder")).toBeUndefined();
		expect(fake.invoke).toHaveBeenCalledTimes(2);
	});

	it("removes a previous reveal control immediately when the row changes", async () => {
		fake.invoke.mockResolvedValueOnce(true).mockReturnValueOnce(Promise.withResolvers<boolean>().promise);
		await paint({ ...base, locations: [{ kind: "path", value: "/tmp/report.html" }] });
		expect(button("Show in folder")).toBeDefined();
		await paint({ ...base, id: "result-2", locations: [{ kind: "path", value: "/tmp/report.html" }] });
		expect(button("Show in folder")).toBeUndefined();
	});

	it("keeps copy errors localized without replacing omp's output", async () => {
		fake.copy.mockRejectedValue(new Error("Clipboard unavailable"));
		await paint({ ...base, locations: [{ kind: "url", value: "https://example.test/report" }] });
		await act(async () => button("Copy URL")!.click());
		expect(fake.toast).toHaveBeenLastCalledWith({ tone: "err", message: session.commandResult.copyFailed });
		expect(container.querySelector("pre")?.textContent).toBe(base.lines.join("\n"));
	});

	it("reports a failed reveal with localized feedback", async () => {
		fake.invoke.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("Reveal unavailable"));
		await paint({ ...base, locations: [{ kind: "path", value: "/tmp/report.html" }] });
		await act(async () => button("Show in folder")!.click());
		expect(fake.toast).toHaveBeenLastCalledWith({ tone: "err", message: session.commandResult.revealFailed });
	});
});
