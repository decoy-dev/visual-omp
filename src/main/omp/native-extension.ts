import { resolveHistoryDbPath } from "./history-path";
import { exactEditorDraft } from "./native-editor";

/** Written into each app-hosted chat's private directory. omp resolves these public SDK and pi-tui exports from its compiled module map. */
export const NATIVE_EXTENSION_SOURCE = String.raw`
import { loadThemeJson } from "@oh-my-pi/pi-tui/theme/loader";
import { getCurrentThemeName } from "@oh-my-pi/pi-tui/theme";
import { ansi256ToHex, resolveVarRefs } from "@oh-my-pi/pi-tui/theme/color";
import { discoverSlashCommands } from "@oh-my-pi/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const resolveHistoryDbPath = ${resolveHistoryDbPath.toString()};
const exactEditorDraft = ${exactEditorDraft.toString()};
const bridgeUrl = process.env.VOMP_NATIVE_BRIDGE;
delete process.env.VOMP_NATIVE_BRIDGE;

export default function visualOmpNative(pi) {
	const url = bridgeUrl;
	if (!url) return;
	const historyDbPath = resolveHistoryDbPath({
		agentDir: pi.pi.getAgentDir(), home: homedir(), platform: process.platform,
		configDir: process.env.PI_CONFIG_DIR, ompProfile: process.env.OMP_PROFILE,
		piProfile: process.env.PI_PROFILE, xdgDataHome: process.env.XDG_DATA_HOME,
		join, exists: existsSync,
	});
	let context;
	let stopped = false;
	let timer;
	let last = "";
	let lastTheme;
	let themeRevision = 0;
	let themeIdentity = null;
	const fingerprint = theme => JSON.stringify([theme.getAllThemeColorHexes(), theme.getBgHex("statusLineBg"), theme.getBgHex("selectedBg")]);
	async function readTheme(ctx) {
		const active = ctx.ui.theme;
		if (!active || active === lastTheme) return themeIdentity;
		const signature = fingerprint(active);
		const currentName = getCurrentThemeName();
		let name = null;
		const current = currentName ? await ctx.ui.getTheme(currentName) : undefined;
		if (current && fingerprint(current) === signature) name = currentName;
		else {
			// A selector preview may differ from the committed theme. Resolve only an unambiguous preview.
			const matches = [];
			for (const info of await ctx.ui.getAllThemes()) {
				const candidate = await ctx.ui.getTheme(info.name);
				if (candidate && fingerprint(candidate) === signature) matches.push(info.name);
			}
			if (matches.length === 1) name = matches[0];
		}
		let terminal;
		if (name) {
			const definition = await loadThemeJson(name);
			const resolve = value => {
				const resolved = resolveVarRefs(value, definition.vars ?? {});
				return typeof resolved === "number" ? ansi256ToHex(resolved) : resolved;
			};
			if (definition.terminal) terminal = {
				background: definition.terminal.background === undefined ? undefined : resolve(definition.terminal.background),
				foreground: definition.terminal.foreground === undefined ? undefined : resolve(definition.terminal.foreground),
				ansi: definition.terminal.ansi?.map(resolve),
			};
		}
		lastTheme = active;
		themeIdentity = { name, terminal, background: active.getBgHex("statusLineBg"), foreground: active.getColorHex("text"), revision: ++themeRevision };
		return themeIdentity;
	}
	async function publish() {
		if (!context || stopped) return;
		let theme = themeIdentity;
		try { theme = await readTheme(context); }
		catch {
			lastTheme = context.ui.theme;
			// A terminal-only JSON error must not prevent mode or location publication.
			if (!theme) {
				try { theme = { name: null, background: context.ui.theme.getBgHex("statusLineBg"), foreground: context.ui.theme.getColorHex("text"), revision: ++themeRevision }; }
				catch { theme = null; }
			}
			themeIdentity = theme;
		}
		const snapshot = { modes: context.sessionModes?.getState() ?? null, theme, historyDbPath, location: { cwd: context.sessionManager.getCwd(), sessionFile: context.sessionManager.getSessionFile() ?? null, sessionId: context.sessionManager.getSessionId() } };
		const encoded = JSON.stringify(snapshot);
		if (encoded === last) return;
		const response = await fetch(url + "/snapshot", { method: "POST", body: encoded, signal: AbortSignal.timeout(2000) });
		if (response.ok) last = encoded;
	}
	async function tick() {
		if (stopped || !context) return;
		try {
			await publish().catch(() => undefined);
			const response = await fetch(url + "/requests", { signal: AbortSignal.timeout(2000) });
			if (response.ok) {
				for (const item of await response.json()) {
					if (item.kind === "editorDraft") {
						const result = exactEditorDraft(context.ui, item.editor, context.sessionManager.getSessionId());
						await fetch(url + "/editor/" + item.id, { method: "POST", body: JSON.stringify(result), signal: AbortSignal.timeout(2000) });
						continue;
					}
					if (item.kind === "sideCommands") {
						try {
							const shadowed = new Set(pi.getCommands().map(command => command.name));
							const files = await discoverSlashCommands({ cwd: context.sessionManager.getCwd() });
							const commands = files.filter(command => command.side === true && !shadowed.has(command.name)).map(command => command.name);
							await fetch(url + "/commands/" + item.id, { method: "POST", body: JSON.stringify({ commands }), signal: AbortSignal.timeout(2000) });
						} catch (error) {
							await fetch(url + "/commands/" + item.id, { method: "POST", body: JSON.stringify({ error: String(error) }), signal: AbortSignal.timeout(2000) });
						}
						continue;
					}
					if (!context.sessionModes) continue;
					const result = await context.sessionModes.set(item.request);
					await fetch(url + "/result/" + item.id, { method: "POST", body: JSON.stringify(result), signal: AbortSignal.timeout(2000) });
				}
			}
		} catch { /* Closing a host closes its private bridge first. No transcript or model output is generated. */ }
		if (!stopped) timer = setTimeout(tick, 250);
	}
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		delete process.env.VOMP_NATIVE_BRIDGE;
		context = ctx; stopped = false; last = ""; clearTimeout(timer); await tick();
	});
	pi.on("mode_changed", async (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		context = ctx; await publish().catch(() => undefined);
	});
	pi.on("session_shutdown", async () => {
		// omp's spawn-based restart inherits the environment after teardown. Restore only at the main session's shutdown.
		if (context) process.env.VOMP_NATIVE_BRIDGE = url;
		if (context) {
			try { await fetch(url + "/snapshot", { method: "POST", body: JSON.stringify({ modes: context.sessionModes?.getState() ?? null, theme: themeIdentity, historyDbPath, shutdown: "teardown", location: { cwd: context.sessionManager.getCwd(), sessionFile: context.sessionManager.getSessionFile() ?? null, sessionId: context.sessionManager.getSessionId() } }), signal: AbortSignal.timeout(2000) }); }
			catch { /* The host may already have closed its private bridge. */ }
		}
		stopped = true; clearTimeout(timer); context = undefined;
	});
}
`;
