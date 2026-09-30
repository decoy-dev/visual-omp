import { describe, expect, it } from "vitest";
import type { McpServerEntry, McpTestResult } from "@shared/contracts/mcp";
import { rowStatus } from "./status";

const entry = {
	id: "/mcp.json#github",
	name: "github",
	provider: "native",
	providerName: "OMP",
	path: "/mcp.json",
	level: "user",
	ompOwned: true,
	editable: true,
	transport: "stdio",
	config: { command: "npx" },
	raw: {},
	status: "active",
	statusDetail: null,
	enabled: true,
	shadowedBy: null,
	errors: [],
	unresolvedVars: [],
} satisfies McpServerEntry;

function result(patch: Partial<McpTestResult>): McpTestResult {
	return {
		ok: true,
		transport: "stdio",
		stage: "done",
		error: null,
		timedOut: false,
		authRequired: false,
		authChallenge: null,
		httpStatus: null,
		exitCode: null,
		exitSignal: null,
		durationMs: 300,
		command: ["npx"],
		url: null,
		unresolvedVars: [],
		serverInfo: null,
		protocolVersion: "2025-03-26",
		capabilities: {},
		instructions: null,
		tools: [{ name: "search", title: null, description: null, inputSchema: {} }],
		prompts: [],
		resources: [],
		listErrors: [],
		stderr: "",
		...patch,
	};
}

describe("rowStatus", () => {
	it("prioritizes omp disabled/invalid states over connection checks", () => {
		expect(rowStatus({ ...entry, enabled: false }, { state: "done", result: result({ ok: false }) }).kind).toBe("off");
		expect(rowStatus({ ...entry, status: "invalid", enabled: true }, undefined).kind).toBe("invalid");
		expect(rowStatus({ ...entry, status: "shadowed" }, undefined).kind).toBe("unused");
	});

	it("distinguishes unchecked, connected, slow, no-tools, sign-in and failed checks", () => {
		expect(rowStatus(entry, undefined).kind).toBe("unchecked");
		expect(rowStatus(entry, { state: "running" }).kind).toBe("checking");
		expect(rowStatus(entry, { state: "done", result: result({}) }).kind).toBe("connected");
		expect(rowStatus(entry, { state: "done", result: result({ durationMs: 5001 }) }).kind).toBe("slow");
		expect(rowStatus(entry, { state: "done", result: result({ tools: [] }) }).kind).toBe("noTools");
		expect(rowStatus(entry, { state: "done", result: result({ ok: false, authRequired: true }) }).kind).toBe("needsSignIn");
		expect(rowStatus(entry, { state: "done", result: result({ ok: false }) }).kind).toBe("failed");
	});
});
