import { describe, expect, it } from "vitest";
import { classifyRemoteError, normalizeRemote } from "./parse";

describe("normalizeRemote", () => {
	it("expands GitHub shorthands and keeps real git URLs", () => {
		expect(normalizeRemote("can1357/oh-my-pi")).toBe("https://github.com/can1357/oh-my-pi.git");
		expect(normalizeRemote(" github.com/can1357/oh-my-pi/ ")).toBe("https://github.com/can1357/oh-my-pi");
		expect(normalizeRemote("https://gitlab.com/group/sub/project.git")).toBe("https://gitlab.com/group/sub/project.git");
		expect(normalizeRemote("git@github.com:can1357/oh-my-pi.git")).toBe("git@github.com:can1357/oh-my-pi.git");
	});

	it("rejects text that cannot be a repository", () => {
		for (const input of ["", "hello world", "just-a-word", "https://github.com", "file:///etc/passwd", "-uhelp/x y"]) {
			expect(normalizeRemote(input)).toBeNull();
		}
	});
});

describe("classifyRemoteError", () => {
	it("tells a missing repository from an unreachable server", () => {
		expect(classifyRemoteError("remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found")).toBe(
			"notFound",
		);
		expect(classifyRemoteError("fatal: unable to access 'https://x.invalid/a.git/': Could not resolve host: x.invalid")).toBe(
			"unreachable",
		);
		expect(classifyRemoteError("fatal: unable to access 'https://h/a.git/': The requested URL returned error: 404")).toBe("notFound");
	});
});
