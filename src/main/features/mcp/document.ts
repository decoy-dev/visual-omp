/**
 * Pure read-modify-write operations on an omp-native `mcp.json` document, mirroring
 * packages/coding-agent/src/mcp/config-writer.ts: whole-document round-trip (unknown keys kept, key order kept),
 * `$schema` inserted first when missing, 2-space JSON without a trailing newline.
 */
import { z } from "zod";
import type { McpServerConfig } from "@shared/contracts/mcp";
import { JsonRecord, validateServerConfig, validateServerName } from "./config";

export const MCP_CONFIG_SCHEMA_URL =
	"https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";

/** A parsed `mcp.json` root object (everything preserved). */
export type McpDocument = Record<string, unknown>;

export type OverrideList = "disabledServers" | "enabledServers";

const DocumentShape = z.looseObject({
	$schema: z.string().optional(),
	mcpServers: z.record(z.string(), JsonRecord).optional(),
	disabledServers: z.array(z.string()).optional(),
	enabledServers: z.array(z.string()).optional(),
});

/** Parse file text into a document; throws a readable error for invalid JSON or a non-object root. */
export function parseDocument(text: string): McpDocument {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const root = JsonRecord.safeParse(json);
	if (!root.success || Array.isArray(json)) throw new Error("MCP config must be a JSON object");
	return root.data;
}

/** Strict shape check used before accepting raw editor text; returns an error message or null. */
export function shapeError(doc: McpDocument): string | null {
	const result = DocumentShape.safeParse(doc);
	if (result.success) return null;
	return result.error.issues
		.map(issue => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
		.join("; ");
}

/** omp's `writeMCPConfigFile` serialization. */
export function serializeDocument(doc: McpDocument): string {
	return JSON.stringify({ $schema: doc.$schema ?? MCP_CONFIG_SCHEMA_URL, ...doc }, null, 2);
}

/** The server map (entries that are not objects are kept as-is). */
export function serverMap(doc: McpDocument): Record<string, unknown> {
	const servers = JsonRecord.safeParse(doc.mcpServers);
	return servers.success ? servers.data : {};
}

/** A list override as omp reads it (`Array.isArray` guard; non-string members ignored). */
export function overrideList(doc: McpDocument, key: OverrideList): string[] {
	const list = z.array(z.unknown()).safeParse(doc[key]);
	return list.success ? list.data.filter(item => typeof item === "string") : [];
}

function assertValid(name: string, config: McpServerConfig): void {
	const nameError = validateServerName(name);
	if (nameError) throw new Error(nameError);
	const errors = validateServerConfig(name, config);
	if (errors.length > 0) throw new Error(`Invalid server config: ${errors.join("; ")}`);
}

/** `addMCPServer`: fails on a duplicate name. */
export function addServer(doc: McpDocument, name: string, config: McpServerConfig, filePath: string): McpDocument {
	assertValid(name, config);
	const servers = serverMap(doc);
	if (servers[name]) throw new Error(`Server "${name}" already exists in ${filePath}`);
	return { ...doc, mcpServers: { ...servers, [name]: config } };
}

/** `updateMCPServer` (adds when missing), plus an in-place rename that keeps the entry's position. */
export function updateServer(
	doc: McpDocument,
	name: string,
	config: McpServerConfig,
	filePath: string,
	newName?: string,
): McpDocument {
	const finalName = newName ?? name;
	assertValid(finalName, config);
	const servers = serverMap(doc);
	if (finalName === name) return { ...doc, mcpServers: { ...servers, [name]: config } };
	if (Object.hasOwn(servers, finalName)) throw new Error(`Server "${finalName}" already exists in ${filePath}`);
	if (!Object.hasOwn(servers, name)) return { ...doc, mcpServers: { ...servers, [finalName]: config } };
	const renamed: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(servers)) {
		if (key === name) renamed[finalName] = config;
		else renamed[key] = value;
	}
	return { ...doc, mcpServers: renamed };
}

/** `removeMCPServer`: fails when missing. */
export function removeServer(doc: McpDocument, name: string, filePath: string): McpDocument {
	const servers = serverMap(doc);
	if (!servers[name]) throw new Error(`Server "${name}" not found in ${filePath}`);
	const { [name]: _removed, ...remaining } = servers;
	return { ...doc, mcpServers: remaining };
}

/** `setServerDisabled` / `setServerForceEnabled`: sorted set semantics, key removed when the list empties. */
export function setListMember(doc: McpDocument, key: OverrideList, name: string, present: boolean): McpDocument {
	const members = new Set(overrideList(doc, key));
	if (present) members.add(name);
	else members.delete(name);
	const updated: McpDocument = { ...doc, [key]: [...members].sort() };
	if (members.size === 0) delete updated[key];
	return updated;
}
