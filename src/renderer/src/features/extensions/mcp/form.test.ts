import { describe, expect, it } from "vitest";
import { configFromForm, emptyForm, formFromConfig, levelForScope, validateForm } from "./form";

describe("configFromForm", () => {
	it("splits a quoted command line into command + args and drops empty env rows", () => {
		const form = {
			...emptyForm("user"),
			name: "files",
			commandLine: 'npx -y @modelcontextprotocol/server-filesystem "/Users/me/My Docs"',
			env: [
				{ key: "TOKEN", value: "${GITHUB_TOKEN}" },
				{ key: " ", value: "ignored" },
			],
		};
		expect(configFromForm(form)).toEqual({
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/My Docs"],
			env: { TOKEN: "${GITHUB_TOKEN}" },
		});
	});

	it("keeps fields the form doesn't edit and drops the other transport's fields when switching to http", () => {
		const base = { command: "node", args: ["server.js"], env: { A: "1" }, cwd: "/srv", timeout: 5000, auth: { type: "oauth" as const } };
		const form = { ...formFromConfig("api", base, "project"), transport: "http" as const, url: " https://mcp.example.com/mcp " };
		expect(configFromForm(form, base)).toEqual({ type: "http", url: "https://mcp.example.com/mcp", timeout: 5000, auth: { type: "oauth" } });
	});

	it("round-trips a stored stdio entry unchanged", () => {
		const base = { type: "stdio" as const, command: "uvx", args: ["mcp-server-git", "--repository", "/a b"], cwd: "/repo", instructions: false };
		expect(configFromForm(formFromConfig("git", base, "user"), base)).toEqual(base);
	});
});

describe("validateForm", () => {
	it("applies omp's name rule and requires the endpoint for the chosen transport", () => {
		expect(validateForm({ ...emptyForm("user"), name: "my  server" })).toEqual({ name: "nameInvalid", command: "commandRequired" });
		expect(validateForm({ ...emptyForm("user"), name: "github", transport: "http", url: "mcp.example.com" }, ["github"])).toEqual({
			name: "nameTaken",
			url: "urlInvalid",
		});
		expect(validateForm({ ...emptyForm("user"), name: "linear.app:prod v2", transport: "sse", url: "https://x/sse" })).toEqual({});
	});
});

// The level the list shows is also where a new server is saved by default.
describe("levelForScope", () => {
	it("picks the project file only when the project scope is chosen, even with a project open", () => {
		expect(levelForScope("project", "/Users/me/shop")).toBe("project");
		// All projects with a project open: new servers go to the user file, not the project.
		expect(levelForScope("global", "/Users/me/shop")).toBe("user");
		// No project open: the project side doesn't exist.
		expect(levelForScope("project", null)).toBe("user");
	});
});
