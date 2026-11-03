import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ClassicSuccessCapture } from "./classic-image-success";
import { attachClassicImages } from "./classic-image-paste";
import { decodedOscPayloads } from "./tsp/sanitize-fixture";

describe.each(["18.15.0", "18.16.0"])("recorded classic image success from standalone omp %s", version => {
	const capture: ClassicSuccessCapture = JSON.parse(readFileSync(new URL(`./fixtures/${version}/classic-image-success.json`, import.meta.url), "utf8"));
	it("retains sanitized raw bytes and source/executable provenance with exact artifact integrity", () => {
		const integrity = JSON.parse(readFileSync(new URL(`./fixtures/${version}/classic-image-success.integrity.json`, import.meta.url), "utf8"));
		expect(integrity.version).toBe(version);
		expect(integrity.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
		expect(integrity.executableSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(integrity.sourceFiles).toHaveLength(4);
		expect(integrity.classicEnvironment).toEqual({ PI_TUI_NATIVE: "0", TERM_PROGRAM: null });
		for (const source of integrity.sourceFiles) expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
		for (const [name, expected] of Object.entries(integrity.artifacts)) {
			const bytes = readFileSync(new URL(`./fixtures/${version}/${name}`, import.meta.url));
			expect({ bytes: bytes.length, carriageReturns: bytes.filter(byte => byte === 13).length, sha256: createHash("sha256").update(bytes).digest("hex") }).toEqual(expected);
			expect(bytes.toString("utf8")).not.toMatch(/\/Users\/|vomp-tsp-record-|local-fixture-only/);
			for (const text of decodedOscPayloads(bytes.toString("utf8"))) expect(text).not.toMatch(/\/Users\/|vomp-tsp-record-/);
		}
		expect(integrity.inputImages).toHaveLength(2);
		for (const image of integrity.inputImages) expect(createHash("sha256").update(Buffer.from(image.base64, "base64")).digest("hex")).toBe(image.sha256);
	});
	it.each([0, 1])("accepts the actual public editor response sequence before prompt/Enter for turn %s", async index => {
		const item = capture.cases[index]!;
		let read = 0, failure = 0;
		const pasted: string[] = [];
		const restoreEditor = vi.fn();
		await attachClassicImages(item.paths, {
			assertCurrent: () => {},
			readEditor: async () => { const result = item.editorReads[read++]; if (!result) throw new Error("Recorded editor responses exhausted"); return result; },
			restoreEditor,
			failureText: async () => { if (failure >= item.failures.length) throw new Error("Recorded status responses exhausted"); return item.failures[failure++]!; },
			paste: text => { pasted.push(text); },
			wait: async () => {},
		});
		expect(read).toBe(item.editorReads.length);
		expect(failure).toBe(item.failures.length);
		expect(pasted).toEqual(item.operations.filter(operation => operation.kind === "paste").map(operation => operation.text));
		expect(restoreEditor).not.toHaveBeenCalled();
		expect(item.helperAccepted).toBe(true);
		expect(item.operations.map(operation => operation.kind)).toEqual([...Array(index + 1).fill("paste"), "acknowledged", "prompt", "enter"]);
		expect(capture.theme).toMatchObject({ name: "titanium" });
		expect(item.editorReads.every(result => result.imageSymbol === "📷")).toBe(true);
		expect(item.acknowledged).toEqual({ text: index === 0 ? "📷 #1 " : "📷 #1 📷 #2 ", cleared: false, imageChips: index + 1, imageSymbol: "📷" });
		expect(item.submitted.text).toBe(item.acknowledged.text + item.prompt);
		expect(item.cleared).toEqual({ text: "", cleared: true, imageChips: 0, imageSymbol: "📷" });
	});
	it.each(["missing separator", "unrelated edit", "unavailable symbol"])("rejects a corrupted captured acknowledgement: %s", async corruption => {
		const item = capture.cases[0]!;
		const response = { ...item.editorReads.at(-1)! };
		if (corruption === "missing separator") response.text = response.text!.trimEnd();
		else if (corruption === "unrelated edit") response.text += "unrelated";
		else delete response.imageSymbol;
		let read = 0;
		await expect(attachClassicImages(item.paths, {
			assertCurrent: () => {},
			readEditor: async () => read++ === 0 ? item.editorReads[0]! : response,
			restoreEditor: vi.fn(),
			failureText: async () => null,
			paste: () => {},
			wait: async () => {},
		})).rejects.toThrow("Image submission needs recovery. omp's editor changed while attaching the image.");
	});
	it("keeps latest-user image payloads separate from previous conversation images", () => {
		expect(capture.requests).toHaveLength(2);
		const imagesByTurn = capture.requests.map((request, index) => {
			const users = request.messages.filter(message => message.role === "user");
			const images = users.map(message => Array.isArray(message.content) ? message.content.filter(part => part.type === "image_url").map(part => part.image_url!.url) : []);
			expect(images.at(-1)).toHaveLength(index + 1);
			expect(images.slice(0, -1).flat()).toHaveLength(index);
			const latest = users.at(-1)!.content;
			expect(Array.isArray(latest) && latest.some(part => part.type === "text" && part.text?.includes(capture.cases[index]!.prompt))).toBe(true);
			for (const url of images.flat()) {
				expect(url).toMatch(/^data:image\/webp;base64,/);
				expect(Buffer.from(url.split(",")[1]!, "base64").subarray(0, 4).toString()).toBe("RIFF");
			}
			return images.at(-1)!;
		});
		expect(imagesByTurn[1]![0]).toBe(imagesByTurn[0]![0]);
		expect(imagesByTurn[1]![1]).not.toBe(imagesByTurn[1]![0]);
	});
});
