import { describe, expect, it, vi } from "vitest";
import { readComposerAssist } from "./native-composer";

describe("omp composer projection", () => {
	it("keeps upstream model ordering, literal colons and supported efforts without inventing levels", async () => {
		const rows = [{ value: "fixture/model:high", description: "Literal model" }, { value: "fixture/model:low", description: "\x1b[31mModel · low\x1b[0m" }];
		const complete = vi.fn(async () => ({ prefix: "^model:", items: rows }));
		const text = "first line\nuse ^model:";
		expect(await readComposerAssist({ text, cursor: text.length, complete: true }, { complete })).toEqual({ items: [{ ...rows[0] }, { ...rows[1], description: "Model · low" }], keywords: [] });
		expect(complete).toHaveBeenCalledExactlyOnceWith(["first line", "use ^model:"], 1, 11);
		complete.mockResolvedValue({ prefix: "^model:", items: [] });
		expect((await readComposerAssist({ text, cursor: text.length, complete: true }, { complete })).items).toEqual([]);
	});
	it("never asks non-model provider branches or changes the draft", async () => {
		const complete = vi.fn();
		for (const text of ["email^model", "^model done", "@file", "ultrathink", "/model"]) {
			await readComposerAssist({ text, cursor: text.length, complete: true }, { complete });
		}
		expect(complete).not.toHaveBeenCalled();
	});
	it("honors both effective enablement handles and uses only omp's prose ranges", async () => {
		const text = "ultrathink `ultrathink` chillax";
		const keywords = [{ id: "ultrathink", word: "ultrathink", description: "Maximum thinking" }, { id: "chillax", word: "chillax", description: "Lowest effort" }];
		const start = text.indexOf("chillax");
		const ranges = () => [{ from: 0, to: 10 }, { from: start, to: start + 7 }];
		const request = { text, cursor: text.length, complete: false };
		expect((await readComposerAssist(request, { keywords, ranges, enabled: () => false })).keywords).toEqual([]);
		expect((await readComposerAssist(request, { keywords, ranges, enabled: id => id !== "ultrathink" })).keywords).toEqual([{ start, end: start + 7, description: "Requests the model's lowest thinking effort where supported and adds instructions for brief reasoning." }]);
		expect(await readComposerAssist(request, {})).toEqual({ items: null, keywords: [] });
	});
	it.each(["settings", "ranges"] as const)("keeps model completion when the keyword %s engine throws", async failure => {
		const text = "ultrathink ^fixture/reasoner:h";
		const result = await readComposerAssist({ text, cursor: text.length, complete: true }, {
			enabled: () => { if (failure === "settings") throw new Error("Changed settings shape"); return true; },
			ranges: () => { throw new Error("Changed keyword shape"); },
			complete: async () => ({ prefix: "^fixture/reasoner:h", items: [{ value: "fixture/reasoner:high", description: "High" }] }),
		});
		expect(result).toEqual({ items: [{ value: "fixture/reasoner:high", description: "High" }], keywords: [] });
	});
});
