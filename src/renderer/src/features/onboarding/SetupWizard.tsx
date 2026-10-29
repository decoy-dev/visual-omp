import { ArrowLeft, ArrowRight, Check, CheckCircle, Monitor, Moon, SignIn, Sun } from "@phosphor-icons/react";
import type { ApprovalMode, ModelInfo, ModelRolesState } from "@shared/contracts/config";
import type { ProvidersState } from "@shared/contracts/providers";
import type { AppPreferences } from "@shared/ipc";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "../../state/app";
import { Button, cn, Mark, Notice, PresenceSwap, SearchInput, Spinner } from "../../ui";
import { focusRingInset } from "../../ui/styles";
import { findModel } from "../manage/roles/rolesModel";
import { OmpLoginDialog, type OmpLoginTarget } from "../manage/settings/OmpLoginDialog";
import { ipcErrorMessage } from "../manage/shared";
import { finishSetup, ompNeedsSetup, setupSteps, useSetup } from "./setup";
import { SetupScreen } from "./SetupScreen";

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
	const [providers, setProviders] = useState<ProvidersState | null>(null);
	const [models, setModels] = useState<ModelInfo[] | null>(null);
	const [roles, setRoles] = useState<ModelRolesState | null>(null);
	const [selection, setSelection] = useState<string | null>(null);
	const [savedModel, setSavedModel] = useState<string | null>(null);
	const [mode, setMode] = useState<ApprovalMode>("always-ask");
	const [query, setQuery] = useState("");
	const [login, setLogin] = useState<OmpLoginTarget | null>(null);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const heading = useRef<HTMLHeadingElement>(null);
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
			if (active.current && request === loadRequest.current) setProviders(result);
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

	useEffect(() => {
		// A request from a previous step cannot own the next step's loading or error state.
		++loadRequest.current;
		setError(null);
		setQuery("");
		if (step === "providers") void loadProviders();
		if (step === "model") void loadModels();
	}, [step, loadProviders, loadModels]);

	const advance = () => setIndex(value => {
		const next = Math.min(value + 1, steps.length - 1);
		return steps[next] === "install" && omp && !ompNeedsSetup(omp) ? Math.min(next + 1, steps.length - 1) : next;
	});
	const exit = async () => {
		setSaving(true);
		setError(null);
		try { await finishSetup(); }
		catch (reason) { if (active.current) { setError(ipcErrorMessage(reason)); setSaving(false); } }
	};
	const primaryBlocked = saving || loading || (step === "model" && Boolean(error));
	const primary = async () => {
		if (primaryBlocked) return;
		if (step === "done") { await exit(); return; }
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
			if (step === "permission") await window.vomp.invoke("config:approval:setMode", mode, "global");
			if (active.current) advance();
		} catch (reason) {
			if (active.current) setError(ipcErrorMessage(reason));
		} finally {
			if (active.current) setSaving(false);
		}
	};
	const chooseTheme = async (theme: AppPreferences["theme"]) => {
		setError(null);
		try { await useApp.getState().setPrefs({ theme }); }
		catch (reason) { if (active.current) setError(ipcErrorMessage(reason)); }
	};
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.defaultPrevented || login || event.nativeEvent.isComposing) return;
		if (event.key === "Escape") { event.preventDefault(); if (!saving) void exit(); }
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

	return (
		<main className="relative flex h-screen w-full flex-col overflow-y-auto bg-bg text-fg" onKeyDown={onKeyDown} aria-label={t("wizard.label")}>
			<div aria-hidden className="h-10 shrink-0 [-webkit-app-region:drag]" />
			<header className="mx-auto flex w-full max-w-200 items-center gap-3 px-page py-4">
				<Mark size={28} />
				<span className="text-md font-semibold">{t("wizard.label")}</span>
				<p className="ml-auto text-sm tabular-nums text-fg-muted" aria-live="polite">{t("wizard.progress", { current: index + 1, total: steps.length })}</p>
				<Button variant="ghost" size="sm" disabled={saving} onClick={() => void exit()}>{t("wizard.exit")}</Button>
			</header>
			<div className="mx-auto flex w-full max-w-160 flex-1 flex-col px-page pb-10 pt-8">
				<PresenceSwap swapKey={step} variant="rise" className="w-full">
					{step === "install" ? <SetupScreen onReady={installReady} /> : (
						<section aria-labelledby={`setup-${step}-title`}>
							{step === "welcome" && <Mark size={64} className="mb-8" />}
							{step === "done" && <CheckCircle size={48} className="mb-6 text-accent" aria-hidden />}
							<h1 id={`setup-${step}-title`} ref={focusHeading} tabIndex={-1} className="text-page font-semibold leading-tight tracking-[-0.02em] outline-none">{t(`wizard.${step}.title`)}</h1>
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
												<Choice key={theme} name="setup-theme" value={theme} selected={prefs?.theme === theme}
													onChange={() => void chooseTheme(theme)} title={t(`wizard.appearance.${theme}`)}
													icon={<Icon className="size-5 text-fg-muted" />} />
											);
										})}
									</div>
								)}
								{step === "done" && (
									<dl className="divide-y divide-border border-y border-border">
										{[
											["providers", connected.map(provider => provider.name).join(", ") || t("wizard.done.noProviders")],
											["model", findModel(savedModel, models ?? [])?.name ?? savedModel ?? t("wizard.done.noModel")],
											["permission", t(`wizard.permission.${mode}.title`)],
										].map(([key, value]) => (
											<div key={key} className="flex flex-wrap items-baseline justify-between gap-2 py-4">
												<dt className="text-md text-fg-muted">{t(`wizard.done.${key}`)}</dt>
												<dd className="max-w-full break-words text-md font-medium">{value}</dd>
											</div>
										))}
									</dl>
								)}
							</div>
						</section>
					)}
				</PresenceSwap>
				{error && <Notice tone="err" className="mt-5" actions={step === "providers" || step === "model" ? <Button size="sm" onClick={() => void (step === "providers" ? loadProviders() : loadModels())}>{t("wizard.retry")}</Button> : undefined}>{error}</Notice>}
				{step !== "install" && <footer className="mt-8 flex items-center justify-between gap-3 border-t border-border pt-5">
					{index > 0 && step !== "done" ? <Button variant="ghost" icon={<ArrowLeft />} disabled={saving || loading} onClick={() => setIndex(value => {
						const previous = Math.max(0, value - 1);
						return steps[previous] === "install" && omp && !ompNeedsSetup(omp) ? Math.max(0, previous - 1) : previous;
					})}>{t("wizard.back")}</Button> : <span />}
					<Button variant="primary" icon={<ArrowRight />} loading={saving} disabled={primaryBlocked} onClick={() => void primary()}>{t(`wizard.${primaryLabel}`)}</Button>
				</footer>}
			</div>
			{login && <OmpLoginDialog target={login} cwd={null} onFinished={() => void loadProviders()} onClose={() => { setLogin(null); void loadProviders(); requestAnimationFrame(() => heading.current?.focus()); }} />}
		</main>
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
