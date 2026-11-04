import { beforeEach, expect, it, vi } from "vitest";
import { register } from "./emoji-panel";
const fake = vi.hoisted(() => ({ supported: vi.fn(), show: vi.fn(), handlers: new Map<string, () => unknown>() }));
vi.mock("electron", () => ({ app: { isEmojiPanelSupported: fake.supported, showEmojiPanel: fake.show } }));
vi.mock("../ipc", () => ({ handle: (channel: string, handler: () => unknown) => fake.handlers.set(channel, handler) }));
beforeEach(() => { fake.handlers.clear(); fake.supported.mockReset(); fake.show.mockReset(); register(); });
it("reports native support and opens the operating system panel when supported", () => {
	fake.supported.mockReturnValue(true);
	expect(fake.handlers.get("app:emojiPanelSupported")!()).toBe(true);
	fake.handlers.get("app:showEmojiPanel")!();
	expect(fake.show).toHaveBeenCalledOnce();
});
it("does not invoke an unsupported native panel", () => {
	fake.supported.mockReturnValue(false);
	expect(fake.handlers.get("app:emojiPanelSupported")!()).toBe(false);
	fake.handlers.get("app:showEmojiPanel")!();
	expect(fake.show).not.toHaveBeenCalled();
});
