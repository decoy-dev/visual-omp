import { resolveAgentDataDir, resolveHistoryDbPath } from "./history-path";
import { exactEditorDraft } from "./native-editor";
import { expandedPromptTextMatches } from "../../shared/prompt-input";
import { sessionAccountSnapshot } from "./native-accounts";
import { readComposerAssist } from "./native-composer";

/** Written into each app-hosted chat's private directory. omp resolves these public SDK and pi-tui exports from its compiled module map. */
export const NATIVE_EXTENSION_SOURCE = String.raw`
import { loadThemeJson } from "@oh-my-pi/pi-tui/theme/loader";
import { getCurrentThemeName } from "@oh-my-pi/pi-tui/theme";
import { ansi256ToHex, resolveVarRefs } from "@oh-my-pi/pi-tui/theme/color";
import { discoverSlashCommands } from "@oh-my-pi/pi-coding-agent";
import * as ompSdk from "@oh-my-pi/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const resolveAgentDataDir = ${resolveAgentDataDir.toString()};
const resolveHistoryDbPath = ${resolveHistoryDbPath.toString()};
const exactEditorDraft = ${exactEditorDraft.toString()};
const expandedPromptTextMatches = ${expandedPromptTextMatches.toString()};
const sessionAccountSnapshot = ${sessionAccountSnapshot.toString()};
const readComposerAssist = ${readComposerAssist.toString()};
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
	let jobsEpoch = null;
	let lifecycle = 0;
	let lastTheme;
	let themeRevision = 0;
	let themeIdentity = null;
	const promptWatches = new Map();
	let autocomplete;
	let keywordEngine;
	// Optional subpath exports are capability checks, not version checks. Missing helpers disable only decorations.
	const keywordModules = Promise.all([
		import("@oh-my-pi/pi-coding-agent/modes/magic-keywords"),
		import("@oh-my-pi/pi-coding-agent/modes/settings"),
		import("@oh-my-pi/pi-coding-agent"),
		import("@oh-my-pi/pi-tui/prompt/magic-keywords"),
	]).then(([words, handles, sdk, prose]) => {
		if (!Array.isArray(words.MAGIC_KEYWORDS) || typeof prose.magicKeywordRanges !== "function" || typeof handles.cfgMagicKeywordsEnabled?.get !== "function" || !handles.cfgMagicKeyword) return;
		keywordEngine = {
			keywords: words.MAGIC_KEYWORDS,
			ranges: prose.magicKeywordRanges,
			enabled: id => id === undefined ? handles.cfgMagicKeywordsEnabled.get(sdk.settings) : handles.cfgMagicKeyword[id]?.get(sdk.settings) === true,
		};
	}).catch(() => undefined);
	let promptSessionId;
	function forgetPrompt(id) {
		const watch = promptWatches.get(id);
		if (!watch) return;
		clearTimeout(watch.timer);
		delete watch.text;
		promptWatches.delete(id);
	}
	function clearPromptWatches() {
		for (const id of promptWatches.keys()) forgetPrompt(id);
	}
	function currentPromptSession() {
		const sessionId = context?.sessionManager.getSessionId();
		if (sessionId !== promptSessionId) { clearPromptWatches(); promptSessionId = sessionId; }
		return sessionId;
	}
	function promptState(id, watch, state, emptyResume, error) {
		return fetch(url + "/prompt/" + encodeURIComponent(id), { method: "POST", body: JSON.stringify({ state, epoch: watch.epoch, sessionId: watch.sessionId, emptyResume, error }), signal: AbortSignal.timeout(2000) });
	}
	function matchesPromptInput(event, watch) {
		if (typeof event.text !== "string") return false;
		const images = Array.isArray(event.images) ? event.images.length : 0;
		if (images !== (watch.images ?? 0)) return false;
		return expandedPromptTextMatches(event.text, watch.text, watch.images);
	}
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
	function runningJobs(ctx) {
		// The SDK returns summaries, without output. Never request captions or widgets here: omp owns their model calls.
		const jobs = ctx.getAsyncJobSnapshot?.()?.running ?? [];
		const summaries = [];
		let size = 1;
		for (const job of jobs) {
			if (summaries.length === 100) break;
			if (typeof job.id !== "string" || !job.id || job.id.length > 256) continue;
			const summary = {
				id: job.id,
				intent: typeof job.intent === "string" ? job.intent.slice(0, 2048).trim() || null : null,
				caption: typeof job.caption === "string" ? job.caption.slice(0, 1024).trim() || null : null,
			};
			size += JSON.stringify(summary).length + 1;
			if (size > 24000) break; // Leave room for modes, theme and location in the bridge's 64 KiB request.
			summaries.push(summary);
		}
		return summaries;
	}
	async function publish() {
		if (!context || stopped) return;
		const ctx = context;
		const current = lifecycle;
		let theme = themeIdentity;
		try { theme = await readTheme(ctx); }
		catch {
			lastTheme = ctx.ui.theme;
			// A terminal-only JSON error must not prevent mode or location publication.
			if (!theme) {
				try { theme = { name: null, background: ctx.ui.theme.getBgHex("statusLineBg"), foreground: ctx.ui.theme.getColorHex("text"), revision: ++themeRevision }; }
				catch { theme = null; }
			}
			themeIdentity = theme;
		}
		if (stopped || current !== lifecycle) return;
		const snapshot = { ompVersion: typeof ompSdk.VERSION === "string" ? ompSdk.VERSION : undefined, modes: ctx.sessionModes?.getState() ?? null, theme, historyDbPath, sessionAccounts: sessionAccountSnapshot(ctx), asyncJobs: runningJobs(ctx), asyncJobsEpoch: jobsEpoch, location: { cwd: ctx.sessionManager.getCwd(), sessionFile: ctx.sessionManager.getSessionFile() ?? null, sessionId: ctx.sessionManager.getSessionId() } };
		const encoded = JSON.stringify(snapshot);
		if (encoded === last) return;
		const response = await fetch(url + "/snapshot", { method: "POST", body: encoded, signal: AbortSignal.timeout(2000) });
		if (response.ok && !stopped && current === lifecycle) last = encoded;
	}
	async function tick() {
		if (stopped || !context) return;
		const current = lifecycle;
		try {
			await publish().catch(() => undefined);
			if (stopped || current !== lifecycle) return;
			const response = await fetch(url + "/requests", { signal: AbortSignal.timeout(2000) });
			if (stopped || current !== lifecycle) return;
			const epoch = response.headers?.get("X-Vomp-Jobs-Epoch") ?? jobsEpoch;
			if (epoch !== jobsEpoch) clearPromptWatches();
			jobsEpoch = epoch;
			currentPromptSession();
			if (response.ok) {
				const requests = await response.json();
				for (const item of requests) {
					if (stopped || current !== lifecycle) return;
					if (item.kind === "composerAssist") {
						if (item.composer.keywords !== false) await keywordModules;
						const result = await readComposerAssist(item.composer, {
							...keywordEngine,
							complete: autocomplete && ((...args) => autocomplete.getSuggestions(...args)),
						});
						if (stopped || current !== lifecycle) return;
						await fetch(url + "/composer/" + item.id, { method: "POST", body: JSON.stringify(result), signal: AbortSignal.timeout(2000) });
						continue;
					}
					if (item.kind === "sessionAccounts") {
						const storage = context.modelRegistry?.authStorage;
						let accounts = null;
						try {
							await storage?.credentials.reload();
							accounts = sessionAccountSnapshot(context);
						} catch {}
						if (stopped || current !== lifecycle) return;
						await fetch(url + "/accounts/" + item.id, { method: "POST", body: JSON.stringify(accounts), signal: AbortSignal.timeout(2000) });
						continue;
					}
					if (item.kind === "forgetPrompt") {
						if (item.epoch === jobsEpoch) forgetPrompt(item.id);
						continue;
					}
					if (item.kind === "watchPrompt") {
						const watch = item.prompt;
						if (item.epoch !== jobsEpoch || !watch || watch.id !== item.id || watch.sessionId !== currentPromptSession() || typeof watch.text !== "string") continue;
						if (watch.images !== undefined && (!Number.isSafeInteger(watch.images) || watch.images < 1)) continue;
						let size = watch.text.length;
						for (const pending of promptWatches.values()) size += pending.text.length;
						if (promptWatches.has(item.id) || promptWatches.size >= 64 || size > 1_048_576) {
							await promptState(item.id, { ...watch, epoch: item.epoch }, "error");
							continue;
						}
						const armed = { sessionId: watch.sessionId, text: watch.text, images: watch.images, epoch: item.epoch, timer: undefined };
						try {
							const checkEditor = () => {
								if (!watch.classicEditor) return;
								if (typeof watch.classicEditor.expected !== "string") throw new Error("omp could not check its editor before sending. Try again when omp is ready.");
								const read = exactEditorDraft(context.ui, { operation: "peek", sessionId: armed.sessionId }, context.sessionManager.getSessionId());
								if (read.error || read.text === null) throw new Error("omp could not check its editor before sending. Try again when omp is ready.");
								if (read.text !== "" && read.text !== watch.classicEditor.expected) throw new Error("omp has unsent text in its editor. Recover it or restart omp before sending another message.");
							};
							// Keep both editor reads and arming synchronous inside omp's input process.
							checkEditor();
							promptWatches.set(item.id, armed);
							armed.timer = setTimeout(() => { if (promptWatches.get(item.id) === armed) forgetPrompt(item.id); }, 30_000);
							checkEditor();
							if (promptWatches.get(item.id) !== armed) throw new Error("omp received another input before this message could be written. Send it again.");
							delete watch.text;
							const branch = !armed.images && (armed.text === "." || armed.text === "c") && context.isIdle() && !context.hasPendingMessages() ? context.sessionManager.getBranch?.() : undefined;
							const emptyResume = Array.isArray(branch) && !branch.some(entry => entry.type === "message" && entry.message?.role === "user");
							const confirmation = await promptState(item.id, armed, "armed", emptyResume);
							if (!confirmation.ok && promptWatches.get(item.id) === armed) forgetPrompt(item.id);
						} catch (error) {
							if (promptWatches.get(item.id) === armed) forgetPrompt(item.id);
							await promptState(item.id, armed, "error", undefined, error instanceof Error ? error.message : String(error));
						}
						continue;
					}
					if (item.kind === "shutdown") {
						// This enters InteractiveMode.requestShutdown(), not the editor submit path.
						// If the SDK is unavailable, the host retains its explicit native stop decision.
						if (typeof context.shutdown === "function") context.shutdown();
						continue;
					}
					if (item.kind === "asyncWork") {
						// A fresh owner-scoped sample includes delivery handoffs, not just running rows.
						// The sink stays in flight until its yield-queue entry injects or is discarded.
						const jobs = context.getAsyncJobSnapshot?.();
						const pending = jobs?.delivery && typeof jobs.delivery.queued === "number" && typeof jobs.delivery.delivering === "boolean"
							? jobs.running.length > 0 || jobs.delivery.queued > 0 || jobs.delivery.delivering || !context.isIdle() || context.hasPendingMessages()
							: null;
						await fetch(url + "/async-work/" + item.id, { method: "POST", body: JSON.stringify({ pending }), signal: AbortSignal.timeout(2000) });
						continue;
					}
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
		if (!stopped && current === lifecycle) timer = setTimeout(tick, 250);
	}
	pi.on("input", (event, ctx) => {
		if (stopped || !context || event.source !== "interactive" || ctx.agent.kind !== "main" || ctx.sessionManager.getSessionId() !== currentPromptSession()) return;
		for (const [id, watch] of promptWatches) {
			if (watch.sessionId !== ctx.sessionManager.getSessionId() || !matchesPromptInput(event, watch)) continue;
			forgetPrompt(id);
			void promptState(id, watch, "input").catch(() => undefined);
			break;
		}
		// Observation never transforms, handles, submits, or waits for this input.
	});
	const startSession = async (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		delete process.env.VOMP_NATIVE_BRIDGE;
		clearPromptWatches(); promptSessionId = ctx.sessionManager.getSessionId();
		ctx.ui.addAutocompleteProvider?.(current => { autocomplete = current; return current; });
		context = ctx; stopped = false; last = ""; jobsEpoch = null; lifecycle++; clearTimeout(timer); await tick();
	};
	pi.on("session_start", startSession);
	pi.on("session_switch", startSession);
	pi.on("mode_changed", async (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		context = ctx; await publish().catch(() => undefined);
	});
	pi.on("session_shutdown", async () => {
		// omp's spawn-based restart inherits the environment after teardown. Restore only at the main session's shutdown.
		const ctx = context;
		if (ctx) process.env.VOMP_NATIVE_BRIDGE = url;
		stopped = true; const current = ++lifecycle; clearTimeout(timer); clearPromptWatches(); promptSessionId = undefined;
		if (ctx) {
			try { await fetch(url + "/snapshot", { method: "POST", body: JSON.stringify({ modes: ctx.sessionModes?.getState() ?? null, theme: themeIdentity, historyDbPath, asyncJobsEpoch: jobsEpoch, shutdown: "teardown", location: { cwd: ctx.sessionManager.getCwd(), sessionFile: ctx.sessionManager.getSessionFile() ?? null, sessionId: ctx.sessionManager.getSessionId() } }), signal: AbortSignal.timeout(2000) }); }
			catch { /* The host may already have closed its private bridge. */ }
		}
		if (current === lifecycle) context = undefined;
	});
}
`;
