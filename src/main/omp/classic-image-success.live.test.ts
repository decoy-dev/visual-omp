import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

// No renderer or Electron process exists in this standalone production-path test.
vi.mock("../ipc", () => ({ broadcast: vi.fn() }));
import { captureClassicImageSuccess } from "./classic-image-success";

describe.skipIf(!process.env.VOMP_CLASSIC_IMAGE_SUCCESS_LIVE || !process.env.OMP_BIN || !process.env.OMP_SOURCE || process.platform === "win32")("standalone classic image production acknowledgement and sends", () => {
	it("acknowledges real single/multiple image chips before sending all payloads to loopback", async () => {
		const capture = await captureClassicImageSuccess(resolve(process.env.OMP_BIN!), process.env.VOMP_CLASSIC_FIXTURE_VERSION ?? "18.15.0", resolve(process.env.OMP_SOURCE!));
		expect(capture.requests).toHaveLength(2);
		for (const [index, item] of capture.cases.entries()) {
			expect(item.helperAccepted).toBe(true);
			expect(item.acknowledged.imageChips).toBe(index + 1);
			expect(item.acknowledged.imageSymbol).toBeTruthy();
			expect(item.acknowledged.text).toBe(Array.from({ length: index + 1 }, (_, number) => `${item.acknowledged.imageSymbol} #${number + 1} `).join(""));
			expect(item.operations.map(operation => operation.kind)).toEqual([...Array(index + 1).fill("paste"), "acknowledged", "prompt", "enter"]);
			const users = capture.requests[item.providerIndex]!.messages.filter(message => message.role === "user");
			const counts = users.map(message => Array.isArray(message.content) ? message.content.filter(part => part.type === "image_url").length : 0);
			expect(counts.at(-1)).toBe(index + 1);
			expect(counts.slice(0, -1).reduce((sum, count) => sum + count, 0)).toBe(index);
			expect(item.cleared).toMatchObject({ text: "", cleared: true, imageChips: 0 });
		}
	}, 90_000);
});
