import type { ShellFailureReason, ShellFrame, ShellResult, ShellSnapshotSource } from "@shared/shell-visualization";
import { isShellAction, shellPresentation, shellProps } from "@shared/tsp/shell";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDeferredTranslation } from "../../i18n";
import { Button } from "../../ui/Button";
import type { SavedShellContentProps } from "./SavedShellCommand";
import { ShellView } from "./ShellView";
import { useObservedShell } from "./observed";

const settingKey = "display.shellVisualization";

interface ShellSettingSample { scope: object; enabled: boolean; confirmedChange: boolean }
/** Sample omp's capability and effective value; no config-file interpretation in the renderer. */
function useSavedShellSetting(active: boolean, cwd: string | undefined) {
	const [sample, setSample] = useState<ShellSettingSample>();
	const scope = useMemo(() => ({}), [active, cwd]);
	const refreshRef = useRef<((confirmedChange?: boolean) => void) | null>(null);
	const refreshSetting = useCallback((confirmedChange = false) => refreshRef.current?.(confirmedChange), []);
	useEffect(() => {
		if (!active) return;
		let alive = true;
		let sequence = 0;
		let watching = false;
		const refresh = (confirmedChange = false) => {
			const request = ++sequence;
			setSample(undefined);
			void window.vomp.invoke("config:get", settingKey, cwd).then(setting => {
				if (alive && sequence === request) setSample({ scope, enabled: setting.key === settingKey && setting.type === "boolean" && setting.value === true, confirmedChange });
			}, () => { if (alive && sequence === request) setSample({ scope, enabled: false, confirmedChange }); });
		};
		const off = window.vomp.on("config:changed", event => {
			if (event.scope === "global" || event.cwd === cwd) refresh(true);
		});
		void window.vomp.invoke("config:watch", cwd).then(() => {
			watching = true;
			if (!alive) void window.vomp.invoke("config:unwatch", cwd).catch(() => {});
		}, () => {});
		refreshRef.current = refresh;
		refresh();
		return () => {
			alive = false;
			off();
			if (refreshRef.current === refresh) refreshRef.current = null;
			if (watching) void window.vomp.invoke("config:unwatch", cwd).catch(() => {});
		};
	}, [active, cwd, scope]);
	return { sample: active && sample?.scope === scope ? sample : undefined, refreshSetting };
}

/** Local inspection has no session host or lease authority, including in read-only chats. */
export function SavedShellContent({ active, cwd, file, identity, toolCallId, command, fallback, envPrefix, context, onReady, observedCallId }: SavedShellContentProps) {
	const { t } = useDeferredTranslation("shellVisualization");
	const { sample: setting, refreshSetting } = useSavedShellSetting(active, cwd);
	const enabled = setting?.enabled;
	const currentSetting = useRef(setting);
	currentSetting.current = setting;
	const disabledSetting = useRef<ShellSettingSample | undefined>(undefined);
	const observed = useObservedShell(observedCallId);
	const sourceRevision = useRef(0);
	const priorSource = useRef<ShellSnapshotSource | undefined>(undefined);
	const observedSource = useMemo<ShellSnapshotSource | undefined>(() => {
		if (!active || enabled !== true || !observed) { priorSource.current = undefined; return undefined; }
		try {
			const json = JSON.stringify(observed.trace);
			const previous = priorSource.current;
			if (previous?.sourceId === observed.sourceId && previous.cwd === observed.cwd && previous.executionCwd === observed.executionCwd && previous.cdSeparator === observed.cdSeparator && previous.json === json) return previous;
			return priorSource.current = { sourceId: observed.sourceId, cwd: observed.cwd, executionCwd: observed.executionCwd, cdSeparator: observed.cdSeparator, json, sourceRevision: ++sourceRevision.current };
		} catch { priorSource.current = undefined; return undefined; }
	}, [active, enabled, observed]);
	const source = useRef(observedSource);
	source.current = observedSource;
	const [attempt, setAttempt] = useState(0);
	const [failure, setFailure] = useState<ShellFailureReason | null>(null);
	useEffect(() => {
		// The service reads the recorded folder, which may differ from this chat's folder.
		// A failure's own true refresh cannot confirm that the service was re-enabled.
		if (failure === "disabled" && setting && setting !== disabledSetting.current && (!setting.enabled || setting.confirmedChange)) setFailure(null);
	}, [setting, failure]);
	useEffect(() => {
		if (!active || failure !== "disabled") return;
		// Before a file-backed open succeeds, only main knows its recorded folder.
		// A real project change can permit one retry without a self-refresh loop.
		return window.vomp.on("config:changed", event => {
			if (event.scope !== "global" && event.cwd !== cwd) refreshSetting(true);
		});
	}, [active, cwd, failure, refreshSetting]);
	const [shown, setShown] = useState<{ scope: object; frame: ShellFrame }>();
	const scope = useMemo(() => ({}), [active, enabled, file, identity, toolCallId, observedCallId, attempt]);
	const lifetime = useRef<object | null>(null);
	const dispatch = useRef<((value: string) => void) | null>(null);
	const updateSource = useRef<(() => void) | null>(null);
	useLayoutEffect(() => {
		lifetime.current = scope;
		return () => { lifetime.current = null; dispatch.current = null; updateSource.current = null; };
	}, [scope]);
	useEffect(() => {
		if (!active || !enabled || failure || (!file && !source.current)) return;
		const requestId = crypto.randomUUID();
		let alive = true;
		let opening = true;
		let frame: ShellFrame | null = null;
		let actionSequence = 0;
		let updating = false;
		let requestedSourceRevision = source.current?.sourceRevision ?? -1;
		const earlyFrames = new Map<string, ShellFrame>();
		const invalidated = new Map<string, ShellFailureReason>();
		const current = () => alive && lifetime.current === scope;
		const release = (handle: string) => { void window.vomp.invoke("shell-viz:release", handle).catch(() => {}); };
		const fail = (reason: ShellFailureReason) => {
			if (!current()) return;
			if (reason === "disabled") { disabledSetting.current = currentSetting.current; refreshSetting(); }
			dispatch.current = null;
			if (frame) release(frame.handle);
			frame = null;
			setShown(undefined);
			setFailure(reason);
		};
		const apply = (next: ShellFrame) => {
			if (!current() || !frame || next.handle !== frame.handle || next.revision <= frame.revision
				|| source.current && next.sourceRevision !== source.current.sourceRevision) return;
			if (!shellProps(next.props)) { fail("unavailable"); return; }
			frame = next;
			setShown({ scope, frame: next });
		};
		const pumpSource = () => {
			const next = source.current;
			if (!current() || opening || !frame || updating || !next || next.sourceRevision <= requestedSourceRevision) return;
			updating = true;
			requestedSourceRevision = next.sourceRevision;
			const handle = frame.handle;
			void window.vomp.invoke("shell-viz:updateSnapshot", { handle, sourceId: next.sourceId, sourceRevision: next.sourceRevision, json: next.json, executionCwd: next.executionCwd, cdSeparator: next.cdSeparator }).then(result => {
				updating = false;
				if (!current() || frame?.handle !== handle) return;
				if (next.sourceRevision === source.current?.sourceRevision) {
					if (result.status === "ready") apply(result);
					else if (result.reason !== "cancelled") fail(result.reason);
				}
				pumpSource();
			}, () => {
				updating = false;
				if (!current() || frame?.handle !== handle) return;
				if (next.sourceRevision === source.current?.sourceRevision) fail("unavailable");
				else pumpSource();
			});
		};
		updateSource.current = pumpSource;
		// Subscribe before open: an invalidation or newer frame can precede its invoke reply.
		const offFrame = window.vomp.on("shell-viz:frame", next => {
			if (!current()) return;
			if (opening) {
				const old = earlyFrames.get(next.handle);
				if ((!old || next.revision > old.revision) && (old || earlyFrames.size < 4)) earlyFrames.set(next.handle, next);
			} else apply(next);
		});
		const offInvalidated = window.vomp.on("shell-viz:invalidated", event => {
			if (!current()) return;
			if (opening) {
				for (const handle of event.handles) if (invalidated.size < 4) invalidated.set(handle, event.reason);
			} else if (frame && event.handles.includes(frame.handle)) fail(event.reason);
		});
		dispatch.current = value => {
			if (!current() || !frame) return;
			const presentation = shellPresentation(frame.props.presentation);
			if (!presentation || !isShellAction(presentation, value)) return;
			const handle = frame.handle;
			const revision = frame.revision;
			const action = ++actionSequence;
			const finish = (result: ShellResult) => {
				if (!current() || frame?.handle !== handle || action !== actionSequence) return;
				if (result.status === "ready") apply(result);
				else if (frame.revision === revision && (!source.current || frame.sourceRevision === source.current.sourceRevision)) fail(result.reason);
			};
			void window.vomp.invoke("shell-viz:action", handle, value).then(finish, () => {
				if (current() && frame?.handle === handle && action === actionSequence && frame.revision === revision) fail("unavailable");
			});
		};
		const openingSource = source.current;
		const opened = openingSource
			? window.vomp.invoke("shell-viz:openSnapshot", { ...openingSource, requestId, toolCallId })
			: window.vomp.invoke("shell-viz:open", { requestId, file: file!, toolCallId });
		void opened.then(result => {
			opening = false;
			if (!current()) {
				if (result.status === "ready") release(result.handle);
				return;
			}
			if (result.status !== "ready") { fail(result.reason); return; }
			frame = result;
			const reason = invalidated.get(result.handle);
			if (reason || !shellProps(result.props)) { fail(reason ?? "unavailable"); return; }
			if (!source.current || result.sourceRevision === source.current.sourceRevision) setShown({ scope, frame: result });
			const early = earlyFrames.get(result.handle);
			if (early) apply(early);
			earlyFrames.clear(); invalidated.clear();
			pumpSource();
		}, () => { opening = false; fail("unavailable"); });
		return () => {
			alive = false;
			dispatch.current = null;
			updateSource.current = null;
			offFrame(); offInvalidated();
			if (opening) void window.vomp.invoke("shell-viz:cancel", requestId).catch(() => {});
			if (frame) release(frame.handle);
		};
	}, [active, enabled, file, toolCallId, scope, failure]);
	useEffect(() => { updateSource.current?.(); }, [observedSource]);
	const action = useCallback((value: string) => {
		if (lifetime.current === scope) dispatch.current?.(value);
	}, [scope]);
	const frame = active && enabled && shown?.scope === scope ? shown.frame : null;
	const ready = active && (enabled === false || !!frame || !!failure);
	useLayoutEffect(() => { onReady?.(ready); }, [onReady, ready]);
	if (frame) return <>{envPrefix && <pre className="mb-2 whitespace-pre-wrap break-words font-mono text-code text-fg-muted">{envPrefix}</pre>}<p className="mb-2 text-xs text-fg-muted">{t(observedCallId ? "observed" : "saved.recorded")}</p><ShellView props={frame.props} context={{ cwd: context?.cwd, cdSeparator: frame.cdSeparator ?? context?.cdSeparator, trace: observed?.trace ?? context?.trace }} command={command} onAction={action} showOutput={false} /></>;
	return <>{fallback}{active && enabled && failure && failure !== "disabled" && <div className="mt-2 text-xs text-fg-muted"><p role="status">{t(`saved.failure.${failure}`)}</p><Button size="sm" variant="ghost" onClick={() => { setFailure(null); setAttempt(value => value + 1); }}>{t("saved.retry")}</Button></div>}</>;
}
