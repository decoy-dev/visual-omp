import { ArrowLeft, ArrowRight, Check, Monitor, Moon, SignIn, Sun } from "@phosphor-icons/react";
import type { ApprovalMode, ModelInfo, ModelRolesState } from "@shared/contracts/config";
import type { ProvidersState } from "@shared/contracts/providers";
import type { AppPreferences } from "@shared/ipc";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "../../state/app";
import { Button, cn, PeriscopeMark, Notice, PresenceSwap, SearchInput, Spinner, Stagger, StaggerItem, spring, useMotionReduced } from "../../ui";
import { focusRingInset } from "../../ui/styles";
import { findModel } from "../manage/roles/rolesModel";
import { OmpLoginDialog, type OmpLoginTarget } from "../manage/settings/OmpLoginDialog";
import { ipcErrorMessage } from "../manage/shared";
import { finishSetup, ompNeedsSetup, setupSteps, useSetup } from "./setup";
import { SetupScreen } from "./SetupScreen";
import { motion } from "motion/react";
import { MiniShell } from "./MiniShell";
import "./setup-wizard.css";

const MODES: readonly ApprovalMode[] = ["always-ask", "always-ask-cached", "write", "yolo"];
const THEMES: readonly AppPreferences["theme"][] = ["system", "light", "dark"];
const THEME_ICONS = { system: Monitor, light: Sun, dark: Moon };

/** Native equivalent of omp's provider and model setup, with app-specific first-run choices. */
export function SetupWizard() {
	const { t } = useTranslation("onboarding");
	const prefs = useApp(state => state.prefs);
	const omp = useApp(state => state.omp);
	const requested = useSetup(state => state.requested);
	// Keep the route stable while installation changes the detected omp status.
	const [steps] = useState(() => setupSteps(Boolean(omp && ompNeedsSetup(omp)), Boolean(prefs?.setupCompleted && !requested)));
	const [index, setIndex] = useState(0);
	const step = steps[index] ?? "done";
	const [miniStarted, setMiniStarted] = useState(step === "install");
	const [providers, setProviders] = useState<ProvidersState | null>(null);
	const [models, setModels] = useState<ModelInfo[] | null>(null);
	const [roles, setRoles] = useState<ModelRolesState | null>(null);
	const [selection, setSelection] = useState<string | null>(null);
	const [savedModel, setSavedModel] = useState<string | null>(null);
	const [mode, setMode] = useState<ApprovalMode>("always-ask");
	const [approvalKnown, setApprovalKnown] = useState(false);
	// The mode the user already chose; null while it is omp's untouched default or unknown.
	const [savedMode, setSavedMode] = useState<ApprovalMode | null>(null);
	const [query, setQuery] = useState("");
	const [login, setLogin] = useState<OmpLoginTarget | null>(null);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const reduced = useMotionReduced();
	const [markFlash, setMarkFlash] = useState(0);
	const [finale, setFinale] = useState(false);
	const [previewTheme, setPreviewTheme] = useState(prefs?.theme ?? "light");
	const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
	const [installLine, setInstallLine] = useState<{ tone: "busy" | "ok" | "err"; text: string } | null>(null);
	const finaleTimer = useRef<number | undefined>(undefined);
	const main = useRef<HTMLElement>(null);
	const skipFinale = useRef(false);
	const themeTimer = useRef<number | undefined>(undefined);
	const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
	const [controlsTheme, setControlsTheme] = useState(prefs?.theme ?? "light");
	useEffect(() => {
		const query = window.matchMedia("(prefers-color-scheme: dark)");
		const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
		window.addEventListener("resize", resize);
		const change = (event: MediaQueryListEvent) => setSystemDark(event.matches);
		query.addEventListener("change", change);
		return () => {
			query.removeEventListener("change", change);
			clearTimeout(finaleTimer.current);
			window.removeEventListener("resize", resize);
			clearTimeout(themeTimer.current);
		};
	}, []);
	const active = useRef(true);
	const loadRequest = useRef(0);
	useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
	const focusHeading = useCallback((element: HTMLHeadingElement | null) => {
		heading.current = element;
		element?.focus();
	}, []);

	const loadProviders = useCallback(async () => {
		const request = ++loadRequest.current;
		setLoading(true);
		setError(null);
		try {
			const result = await window.vomp.invoke("providers:list", true);
			if (active.current && request === loadRequest.current) {
				setProviders(result);
				setMarkFlash(value => value + 1);
			}
		} catch (reason) {
			if (active.current && request === loadRequest.current) setError(ipcErrorMessage(reason));
		} finally {
			if (active.current && request === loadRequest.current) setLoading(false);
		}
	}, []);

	const loadModels = useCallback(async () => {
		const request = ++loadRequest.current;
		setLoading(true);
		setError(null);
		try {
			const [catalog, current] = await Promise.all([
				window.vomp.invoke("config:models:refresh", undefined, true),
				window.vomp.invoke("config:roles"),
			]);
			if (!active.current || request !== loadRequest.current) return;
			const chat = catalog.filter(model => model.kind === "chat");
			const assigned = current.roles.find(role => role.id === "default")?.model ?? null;
			setModels(chat);
			setRoles(current);
			setSelection(findModel(assigned, chat)?.selector ?? null);
			setSavedModel(assigned);
		} catch (reason) {
			if (active.current && request === loadRequest.current) setError(ipcErrorMessage(reason));
		} finally {
			if (active.current && request === loadRequest.current) setLoading(false);
		}
	}, []);

	const loadApproval = useCallback(async () => {
		const request = ++loadRequest.current;
		setLoading(true);
		setError(null);
		setApprovalKnown(false);
		try {
			const current = await window.vomp.invoke("config:approval");
			if (!active.current || request !== loadRequest.current) return;
			// An explicit choice stays selected; only omp's untouched default gets the Ask me first suggestion.
			if (current.modeSource === "default") {
				setMode("always-ask");
				setSavedMode(null);
				setApprovalKnown(true);
			} else if (current.mode) {
				setMode(current.mode);
				setSavedMode(current.mode);
				setApprovalKnown(true);
			} else {
				// A mode this version cannot describe blocks Continue, so it is never overwritten.
				setError(t("wizard.permission.unknown"));
			}
		} catch (reason) {
			if (active.current && request === loadRequest.current) setError(ipcErrorMessage(reason));
		} finally {
			if (active.current && request === loadRequest.current) setLoading(false);
		}
	}, [t]);

	useEffect(() => {
		// A request from a previous step cannot own the next step's loading or error state.
		++loadRequest.current;
		setError(null);
		setQuery("");
		if (step === "providers") void loadProviders();
		if (step === "model") void loadModels();
		if (step === "permission") void loadApproval();
	}, [step, loadProviders, loadModels, loadApproval]);

	const advance = () => {
		setMarkFlash(value => value + 1);
		setMiniStarted(true);
		setIndex(value => {
			const next = Math.min(value + 1, steps.length - 1);
			return steps[next] === "install" && omp && !ompNeedsSetup(omp) ? Math.min(next + 1, steps.length - 1) : next;
		});
	};
	const exit = async (animate = false) => {
		setSaving(true);
		setError(null);
		if (animate) {
			skipFinale.current = false;
			useSetup.setState({ handoff: true });
		}
		try {
			await finishSetup();
			if (animate && active.current) {
				if (skipFinale.current) useSetup.setState({ handoff: false });
				else {
					setFinale(true);
					requestAnimationFrame(() => main.current?.focus());
					finaleTimer.current = window.setTimeout(() => useSetup.setState({ handoff: false }), reduced ? 140 : 700);
				}
			}
		} catch (reason) {
			if (active.current) {
				setFinale(false);
				useSetup.setState({ handoff: false });
				setError(ipcErrorMessage(reason));
				setSaving(false);
				requestAnimationFrame(() => heading.current?.focus());
			}
		}
	};
	// Without the current mode, saving could overwrite a choice the user already made.
	const primaryBlocked = saving || loading || ((step === "model" || step === "permission") && Boolean(error));
	const primary = async () => {
		if (primaryBlocked) return;
		if (step === "done") { await exit(true); return; }
		setSaving(true);
		setError(null);
		try {
			if (step === "model" && selection) {
				const current = roles?.roles.find(role => role.id === "default");
				await window.vomp.invoke("config:roles:set", "default", {
					model: selection,
					thinking: current && findModel(current.model, models ?? [])?.selector === selection ? current.thinking : null,
				}, { scope: "global" });
				setSavedModel(selection);
			}
			if (step === "permission" && mode !== savedMode) await window.vomp.invoke("config:approval:setMode", mode, "global");
			if (active.current) advance();
		} catch (reason) {
			if (active.current) setError(ipcErrorMessage(reason));
		} finally {
			if (active.current) setSaving(false);
		}
	};
	const chooseTheme = async (theme: AppPreferences["theme"]) => {
		setError(null);
		setPreviewTheme(theme);
		clearTimeout(themeTimer.current);
		try { await useApp.getState().setPrefs({ theme }); }
		catch (reason) {
			if (active.current) {
				setPreviewTheme(useApp.getState().prefs?.theme ?? "light");
				setError(ipcErrorMessage(reason));
			}
		}
	};
	useEffect(() => {
		themeTimer.current = window.setTimeout(() => setControlsTheme(previewTheme), reduced ? 0 : 240);
		return () => clearTimeout(themeTimer.current);
	}, [previewTheme, reduced]);
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.defaultPrevented || login || event.nativeEvent.isComposing) return;
		if (finale) {
			event.preventDefault();
			event.stopPropagation();
			if (event.key === "Escape") {
				window.clearTimeout(finaleTimer.current);
				useSetup.setState({ handoff: false });
			}
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			if (saving && step === "done") skipFinale.current = true;
			else if (!saving) void exit();
		}
		if (event.key === "Enter" && step !== "install" && !(event.target as HTMLElement).closest("button, a")) {
			event.preventDefault(); void primary();
		}
	};
	const installReady = () => { if (steps.length === 1) void exit(); else advance(); };
	const knownProviders = providers?.connected ?? [];
	const connected = knownProviders.filter(provider => provider.accounts.length > 0 || provider.authenticated || provider.modelCount > 0);
	const connectedIds = new Set(connected.map(provider => provider.id));
	const canSkip = (step === "providers" && connected.length === 0) || (step === "model" && !selection);
	const primaryLabel = step === "welcome" ? "start" : step === "done" ? "finish" : canSkip ? "skip" : "continue";
	const search = query.toLowerCase().trim();
	const filteredModels = (models ?? []).filter(model => `${model.name} ${model.selector}`.toLowerCase().includes(search));
	const providerRows = [
		...knownProviders.map(provider => ({
			id: provider.id, name: provider.name, target: provider.login,
			connected: connectedIds.has(provider.id),
			needsSignIn: !connectedIds.has(provider.id) && provider.disabledAccounts.length > 0,
		})),
		...(providers?.available ?? []).map(provider => ({ ...provider, target: provider, connected: false, needsSignIn: false })),
	].filter(provider => `${provider.name} ${provider.id}`.toLowerCase().includes(search));
	const cover = step === "welcome" || step === "done";
	const theme = previewTheme === "system" ? (systemDark ? "dark" : "light") : previewTheme;
	const progress = step === "install" ? 1 : step === "providers" ? 2 : step === "model" ? 3 : step === "permission" ? 4 : step === "appearance" ? 5 : step === "done" ? 6 : 0;
	const progressTicks = <div className="setup-ticks" aria-hidden>{Array.from({ length: 6 }, (_, tick) => <span key={tick} data-current={tick === progress - 1 || undefined}><motion.i initial={false} animate={{ scaleX: tick < progress ? 1 : 0 }} transition={reduced ? { duration: 0 } : spring.gentle} /></span>)}</div>;
	const ompLine = omp?.found && omp.supported && !omp.refused && omp.version
		? { tone: "ok" as const, text: `omp ${omp.version}` }
		: installLine;
	const miniScale = Math.min(0.55, Math.max(0.2, (viewport.width - 560) / viewport.width), (viewport.height - 180) / viewport.height);
	const permission = approvalKnown ? t(`wizard.permission.${mode}.title`) : null;

	return (
		<motion.main ref={main} tabIndex={-1} initial={false} animate={{ opacity: finale ? 0 : 1 }} transition={{ opacity: { duration: reduced ? 0.14 : 0.2, delay: finale && !reduced ? 0.5 : 0 } }} className={cn("setup-wizard relative flex h-screen w-full flex-col overflow-hidden bg-bg text-fg outline-none", cover && "setup-cover", finale && "setup-finishing")} data-theme={controlsTheme === "system" ? (systemDark ? "dark" : "light") : controlsTheme} data-region={cover ? "chrome" : undefined} data-reduced={reduced || undefined} onKeyDown={onKeyDown} aria-label={t("wizard.label")}>
			<div aria-hidden className="h-10 shrink-0 [-webkit-app-region:drag]" />
			<header inert={finale} className="setup-header flex w-full items-center gap-3 px-page py-4">
				{!cover && <PeriscopeMark size={24} flash={markFlash} className="setup-narrow-mark" />}
				<span className="text-md font-semibold">{t("wizard.label")}</span>
				<p className="ml-auto text-sm tabular-nums text-fg-muted" aria-live="polite">{t("wizard.progress", { current: cover ? (step === "done" ? 6 : 1) : progress, total: 6 })}</p>
				<Button variant="ghost" size="sm" disabled={saving} onClick={() => void exit()}>{t("wizard.exit")}</Button>
			</header>
			<p className="sr-only" role="status">{[ompLine?.text, permission].filter(Boolean).join(". ")}</p>
			<div className={cn("setup-layout", cover && "setup-layout-cover")}>
			<div className="setup-controls" inert={finale}>
				<PresenceSwap swapKey={step} variant="rise" className="w-full">
					{step === "install" ? <SetupScreen onReady={installReady} embedded progress={progressTicks} onStatus={setInstallLine} /> : (
						<section aria-labelledby={`setup-${step}-title`}>
							{cover && <PeriscopeMark size={176} mood={step === "welcome" ? "enter" : "celebrate"} inverse flash={markFlash} className="mb-8" />}
							<h1 id={`setup-${step}-title`} ref={focusHeading} tabIndex={-1} className={cn("font-semibold leading-tight tracking-[-0.02em] outline-none", cover ? "setup-display" : "text-3xl")}>{t(`wizard.${step}.title`)}</h1>
							{!cover && progressTicks}
							<p className="mt-3 text-base text-fg-muted">{t(`wizard.${step}.body`)}</p>
							<div className="mt-8">
								{loading && <p role="status" className="mb-4 flex items-center gap-2 text-sm text-fg-muted"><Spinner size={14} />{t(`wizard.${step}.loading`)}</p>}
								{step === "providers" && providers && <>
									<SearchInput value={query} onValueChange={setQuery} aria-label={t("wizard.providers.search")} placeholder={t("wizard.providers.search")} />
									<ul className="mt-3 max-h-72 overflow-y-auto divide-y divide-border border-y border-border">
										{providerRows.map(provider => (
											<li key={provider.id}>
												<button
													type="button"
													disabled={!provider.target}
													onClick={() => setLogin({ methodId: provider.target?.id ?? null, name: provider.name })}
													className={cn("flex w-full items-center gap-3 rounded-sm px-3 py-4 text-left hover:bg-hover disabled:cursor-default", focusRingInset)}
												>
													<span className="min-w-0 flex-1 text-md font-medium">{provider.name}</span>
													{provider.connected ? (
														<span className="flex items-center gap-1.5 text-sm text-accent">
															<Check aria-hidden />{t("wizard.providers.connected")}
														</span>
													) : provider.needsSignIn ? (
														<span className="flex items-center gap-1.5 text-sm text-warn">
															<SignIn aria-hidden />{t("wizard.providers.needsSignIn")}
														</span>
													) : <SignIn className="size-4 text-fg-muted" aria-label={t("wizard.providers.signIn")} />}
												</button>
											</li>
										))}
									</ul>
									{providerRows.length === 0 && <p className="py-4 text-md text-fg-muted">{t("wizard.providers.noMatches")}</p>}
									<p className="mt-4 text-sm text-fg-muted">{t("wizard.providers.note")}</p>
								</>}
								{step === "model" && models && !loading && <>
									{models.length === 0 ? (
										<div className="rounded-lg border border-border bg-panel p-5">
											<h2 className="text-md font-semibold">{t("wizard.model.emptyTitle")}</h2>
											<p className="mt-2 text-md text-fg-muted">{t("wizard.model.emptyBody")}</p>
											<Button className="mt-4" icon={<ArrowLeft />} onClick={() => setIndex(steps.indexOf("providers"))}>
												{t("wizard.model.signIn")}
											</Button>
										</div>
									) : <>
										<SearchInput value={query} onValueChange={setQuery} aria-label={t("wizard.model.search")} placeholder={t("wizard.model.search")} />
										<div role="radiogroup" aria-label={t("wizard.model.title")} className="mt-3 max-h-72 overflow-y-auto divide-y divide-border border-y border-border">
											{filteredModels.map(model => <Choice key={model.selector} value={model.selector} name="setup-model" selected={selection === model.selector} onChange={() => setSelection(model.selector)} title={model.name} body={model.selector} />)}
										</div>
										{filteredModels.length === 0 && <p className="py-4 text-md text-fg-muted">{t("wizard.model.noMatches")}</p>}
									</>}
								</>}
								{step === "permission" && (
									<div role="radiogroup" aria-label={t("wizard.permission.title")} className="divide-y divide-border border-y border-border">
										{MODES.map(value => (
											<Choice key={value} name="setup-permission" value={value} selected={mode === value} onChange={() => setMode(value)}
												title={t(`wizard.permission.${value}.title`)} body={t(`wizard.permission.${value}.body`)} />
										))}
									</div>
								)}
								{step === "appearance" && (
									<div role="radiogroup" aria-label={t("wizard.appearance.title")} className="divide-y divide-border border-y border-border">
										{THEMES.map(theme => {
											const Icon = THEME_ICONS[theme];
											return (
												<Choice key={theme} name="setup-theme" value={theme} selected={previewTheme === theme}
													onChange={() => void chooseTheme(theme)} title={t(`wizard.appearance.${theme}`)}
													icon={<Icon className="size-5 text-fg-muted" />} />
											);
										})}
									</div>
								)}
								{step === "done" && (
									<Stagger step={0.04}><dl className="divide-y divide-border border-y border-border">
										{[
											["providers", connected.map(provider => provider.name).join(", ") || t("wizard.done.noProviders")],
											["model", findModel(savedModel, models ?? [])?.name ?? savedModel ?? t("wizard.done.noModel")],
											["permission", t(`wizard.permission.${mode}.title`)],
										].map(([key, value]) => (
											<StaggerItem key={key} className="flex flex-wrap items-baseline justify-between gap-2 py-4">
												<dt className="flex items-center gap-2 text-md text-fg-muted"><Check className="text-accent" aria-hidden />{t(`wizard.done.${key}`)}</dt>
												<dd className="max-w-full break-words text-md font-medium">{value}</dd>
											</StaggerItem>
										))}
									</dl></Stagger>
								)}
							</div>
						</section>
					)}
				</PresenceSwap>
				{error && <Notice tone="err" className="mt-5" actions={step === "providers" || step === "model" || step === "permission" ? <Button size="sm" onClick={() => void (step === "providers" ? loadProviders() : step === "model" ? loadModels() : loadApproval())}>{t("wizard.retry")}</Button> : undefined}>{error}</Notice>}
				{step !== "install" && <footer className="mt-8 flex items-center justify-between gap-3 border-t border-border pt-5">
					{index > 0 && step !== "done" ? <Button variant="ghost" icon={<ArrowLeft />} disabled={saving || loading} onClick={() => setIndex(value => {
						const previous = Math.max(0, value - 1);
						return steps[previous] === "install" && omp && !ompNeedsSetup(omp) ? Math.max(0, previous - 1) : previous;
					})}>{t("wizard.back")}</Button> : <span />}
					<Button variant="primary" icon={<ArrowRight />} loading={saving} disabled={primaryBlocked} onClick={() => void primary()}>{t(`wizard.${primaryLabel}`)}</Button>
				</footer>}
			</div>
				<div className={cn("setup-miniature", cover && "setup-miniature-covered", finale && "setup-miniature-finale")} aria-hidden>
					<motion.div className="setup-miniature-frame" style={{ width: viewport.width, height: viewport.height }} initial={false} animate={finale ? { scale: 1, x: 0 } : { scale: miniScale, x: viewport.width <= 1100 ? 232 : 252 }} transition={reduced ? { duration: 0 } : finale ? { ...spring.gentle, visualDuration: 0.5 } : spring.gentle}>
						{miniStarted && <MiniShell theme={theme} ompLine={ompLine} providers={connected.map(({ id, name }) => ({ id, name }))} model={selection ?? savedModel} permission={permission} markFlash={markFlash} celebrate={step === "done"} />}
					</motion.div>
				</div>
			</div>
			{login && <OmpLoginDialog target={login} cwd={null} onFinished={() => void loadProviders()} onClose={() => { setLogin(null); void loadProviders(); requestAnimationFrame(() => heading.current?.focus()); }} />}
		</motion.main>
	);
}

function Choice({ name, value, selected, onChange, title, body, icon }: { name: string; value: string; selected: boolean; onChange(): void; title: string; body?: string; icon?: ReactNode }) {
	return (
		<label className={cn("flex cursor-pointer items-center gap-3 rounded-sm px-3 py-4 hover:bg-hover", selected && "bg-accent-muted")}>
			<input type="radio" name={name} value={value} checked={selected} onChange={onChange} className="size-4 shrink-0 accent-accent" />
			{icon}
			<span className="min-w-0 flex-1">
				<span className="block text-md font-medium">{title}</span>
				{body && <span className="mt-1 block break-words text-sm text-fg-muted">{body}</span>}
			</span>
		</label>
	);
}
