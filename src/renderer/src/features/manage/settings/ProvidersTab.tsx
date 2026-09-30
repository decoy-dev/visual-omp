/**
 * Settings → Providers: what the installed omp reports about model providers (models, signed-in
 * accounts, credentials that need a new sign-in) and omp's own `omp login` for everything else.
 * Discovery and sign-in run in the selected project folder, where project extensions can add
 * providers.
 */
import { ArrowClockwise, DotsThree, SignIn, SignOut, UserPlus } from "@phosphor-icons/react";
import type { ConnectedProvider, LoginMethod } from "@shared/contracts/providers";
import type { TFunction } from "i18next";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { controllerFor, useApp } from "@/state/app";
import type { SessionController } from "@/state/session";
import {
	Button,
	Chip,
	type ChipTone,
	Dialog,
	DialogContent,
	IconButton,
	Menu,
	MenuContent,
	MenuItem,
	MenuSeparator,
	MenuTrigger,
	SearchInput,
	Spinner,
	toast,
} from "@/ui";
import { listRowMotion } from "../listMotion";
import { ipcErrorMessage, useResource } from "../shared";
import { type OmpLoginTarget, OmpLoginDialog } from "./OmpLoginDialog";
import { SettingsSection } from "./parts";

/**
 * Chats where `/restart` interrupts nothing: omp is running, not working, has no question waiting
 * and no queued messages, and the chat is not open read-only.
 */
function idleChats(): SessionController[] {
	return useApp.getState().tabs.flatMap(tab => {
		const controller = controllerFor(tab.id);
		const view = controller?.getSnapshot();
		const idle =
			view?.mode === "live" && !view.working && !view.readOnly && view.queue.length === 0 && !view.guest?.uiRequest;
		return controller && idle ? [controller] : [];
	});
}

export function ProvidersTab({ cwd }: { cwd: string | null }) {
	const { t } = useTranslation("manage");
	const arg = cwd ?? undefined;
	const state = useResource(() => window.vomp.invoke("providers:list", arg), [arg]);
	const [refreshing, setRefreshing] = useState(false);
	const [login, setLogin] = useState<OmpLoginTarget | null>(null);
	const [signOut, setSignOut] = useState<ConnectedProvider | null>(null);
	const [signingOut, setSigningOut] = useState(false);
	const [query, setQuery] = useState("");

	useEffect(() => window.vomp.on("providers:changed", () => void state.reload()), [state.reload]);

	const refresh = async () => {
		setRefreshing(true);
		try {
			state.setData(await window.vomp.invoke("providers:list", arg, true));
		} catch (error) {
			toast({ tone: "err", message: ipcErrorMessage(error) });
		} finally {
			setRefreshing(false);
		}
	};

	const restartIdle = useCallback(async () => {
		const chats = idleChats();
		const results = await Promise.allSettled(chats.map(controller => controller.restart()));
		const failed = results.filter(result => result.status === "rejected");
		const requested = results.length - failed.length;
		if (requested > 0) toast({ tone: "ok", message: t("providers.restart.requested", { count: requested }) });
		if (failed.length > 0) {
			const reason = failed[0]?.status === "rejected" ? ipcErrorMessage(failed[0].reason) : undefined;
			toast({ tone: "err", message: t("providers.restart.failed", { count: failed.length }), description: reason });
		}
	}, [t]);

	const loginFinished = useCallback(
		(code: number) => {
			if (code !== 0) return;
			const openChats = useApp.getState().tabs.some(tab => controllerFor(tab.id)?.getSnapshot().mode === "live");
			const idle = idleChats().length;
			toast({
				tone: "ok",
				message: t("providers.login.finished"),
				description: openChats ? t("providers.restart.note") : undefined,
				sticky: openChats,
				action: idle > 0 ? { label: t("providers.restart.action", { count: idle }), onClick: () => void restartIdle() } : undefined,
			});
		},
		[t, restartIdle],
	);

	const confirmSignOut = async () => {
		if (!signOut) return;
		setSigningOut(true);
		try {
			await window.vomp.invoke("providers:logout", signOut.id, arg);
			toast({ tone: "ok", message: t("providers.signOut.done", { name: signOut.name }) });
			setSignOut(null);
		} catch (error) {
			toast({ tone: "err", message: t("providers.signOut.failed", { name: signOut.name }), description: ipcErrorMessage(error) });
		} finally {
			setSigningOut(false);
		}
	};

	const data = state.data;
	const available = useMemo(() => {
		const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
		return (data?.available ?? []).filter(method => {
			const haystack = `${method.name} ${method.id}`.toLowerCase();
			return tokens.every(token => haystack.includes(token));
		});
	}, [data, query]);

	return (
		<>
			<div className="mb-6 flex flex-wrap items-start gap-3">
				<p className="min-w-60 flex-1 text-md text-fg-muted">{t("providers.intro")}</p>
				<div className="flex shrink-0 gap-2">
					<Button size="sm" icon={<ArrowClockwise />} loading={refreshing} disabled={!data} onClick={() => void refresh()}>
						{t("providers.refresh")}
					</Button>
					<Button size="sm" variant="primary" icon={<SignIn />} onClick={() => setLogin({ methodId: null, name: null })}>
						{t("providers.signInAny")}
					</Button>
				</div>
			</div>

			{state.error && (
				<p role="alert" className="mb-4 text-sm text-err">
					{state.error}
				</p>
			)}
			{!data && !state.error && (
				<p role="status" className="flex items-center gap-2 text-sm text-fg-muted">
					<Spinner size={12} />
					{t("providers.loading")}
				</p>
			)}

			{data && (
				<>
					<SettingsSection title={t("providers.connected.title")}>
						{data.connected.length === 0 ? (
							<p className="py-3 text-md text-fg-muted">{t("providers.connected.empty")}</p>
						) : (
							<AnimatePresence initial={false} mode="popLayout">
								{data.connected.map(provider => (
									<motion.div key={provider.id} {...listRowMotion}>
										<ConnectedRow
											provider={provider}
											onSignIn={() => provider.login && setLogin({ methodId: provider.login.id, name: provider.name })}
											onSignOut={() => setSignOut(provider)}
										/>
									</motion.div>
								))}
							</AnimatePresence>
						)}
					</SettingsSection>

					<section className="mb-6">
						<h3 className="text-sm font-semibold text-fg">{t("providers.add.title")}</h3>
						<p className="mt-0.5 text-sm text-fg-muted">{t("providers.add.description")}</p>
						<SearchInput
							className="mt-3"
							size="sm"
							value={query}
							onValueChange={setQuery}
							placeholder={t("providers.add.search")}
							aria-label={t("providers.add.search")}
						/>
						{available.length === 0 && <p className="py-3 text-md text-fg-muted">{t("providers.add.noMatch")}</p>}
						<LoginList methods={available} onSignIn={setLogin} />
						<p className="mt-4 text-sm text-fg-muted">{t("providers.add.envNote")}</p>
					</section>
				</>
			)}

			{login && <OmpLoginDialog target={login} cwd={cwd} onClose={() => setLogin(null)} onFinished={loginFinished} />}

			<Dialog open={signOut !== null} onOpenChange={open => !open && !signingOut && setSignOut(null)}>
				{signOut && (
					<DialogContent
						destructive
						size="sm"
						title={t("providers.signOut.title", { name: signOut.name })}
						description={t("providers.signOut.description")}
						footer={
							<>
								<Button onClick={() => setSignOut(null)} disabled={signingOut}>
									{t("common.cancel")}
								</Button>
								<Button variant="danger" loading={signingOut} onClick={() => void confirmSignOut()}>
									{t("providers.signOut.confirm")}
								</Button>
							</>
						}
					/>
				)}
			</Dialog>
		</>
	);
}

function statusChip(provider: ConnectedProvider, t: TFunction<"manage">): { tone: ChipTone; label: string } {
	if (provider.disabledAccounts.length > 0) {
		return provider.accounts.length === 0
			? { tone: "err", label: t("providers.status.needsSignIn") }
			: { tone: "warn", label: t("providers.status.someNeedSignIn", { count: provider.disabledAccounts.length }) };
	}
	if (provider.accounts.length > 0) return { tone: "ok", label: t("providers.status.accounts") };
	if (provider.authenticated) return { tone: "ok", label: t("providers.status.authenticated") };
	return { tone: "neutral", label: t("providers.status.models") };
}

function ConnectedRow({ provider, onSignIn, onSignOut }: { provider: ConnectedProvider; onSignIn(): void; onSignOut(): void }) {
	const { t } = useTranslation("manage");
	const chip = statusChip(provider, t);
	const needsSignIn = provider.disabledAccounts.length > 0 && provider.login !== null;
	const details = [
		provider.modelCount > 0 ? t("providers.models", { count: provider.modelCount }) : t("providers.noModels"),
		...provider.accounts.map(account => [account.email, account.orgName].filter(Boolean).join(" · ") || t("providers.account.unnamed")),
	];
	const hasMenu = provider.login !== null || provider.canSignOut;

	return (
		<div className="flex items-start justify-between gap-6 py-3">
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-2">
					<span className="min-w-0 break-words text-md font-medium text-fg">{provider.name}</span>
					<Chip tone={chip.tone} dot>
						{chip.label}
					</Chip>
				</div>
				<p className="mt-0.5 break-words text-sm text-fg-muted">{details.join(" · ")}</p>
				{provider.disabledAccounts.map((account, index) => {
					const name = account.email ?? account.accountId;
					return (
						<p key={`${account.accountId ?? account.email ?? ""}-${index}`} className="mt-1 break-words text-sm text-err">
							{name
								? t("providers.account.disabled", { account: name, cause: account.cause })
								: t("providers.account.disabledUnnamed", { cause: account.cause })}
						</p>
					);
				})}
			</div>
			<div className="flex shrink-0 items-center gap-2">
				{needsSignIn && (
					<Button size="sm" variant="primary" icon={<SignIn />} onClick={onSignIn}>
						{t("providers.actions.signInAgain")}
					</Button>
				)}
				{hasMenu && (
					<Menu>
						<MenuTrigger asChild>
							<IconButton size="md" label={t("providers.actions.more", { name: provider.name })} icon={<DotsThree weight="bold" />} />
						</MenuTrigger>
						<MenuContent align="end">
							{provider.login && (
								<MenuItem icon={<SignIn />} onSelect={onSignIn}>
									{t("providers.actions.signInAgain")}
								</MenuItem>
							)}
							{provider.login && provider.accounts.length > 0 && (
								<MenuItem icon={<UserPlus />} onSelect={onSignIn}>
									{t("providers.actions.addAccount")}
								</MenuItem>
							)}
							{provider.canSignOut && (
								<>
									{provider.login && <MenuSeparator />}
									<MenuItem danger icon={<SignOut />} onSelect={onSignOut}>
										{t("providers.actions.signOut", { name: provider.name })}
									</MenuItem>
								</>
							)}
						</MenuContent>
					</Menu>
				)}
			</div>
		</div>
	);
}

function LoginList({ methods, onSignIn }: { methods: LoginMethod[]; onSignIn(target: OmpLoginTarget): void }) {
	const { t } = useTranslation("manage");
	if (methods.length === 0) return null;
	return (
		<div className="relative mt-2 divide-y divide-border">
			<AnimatePresence initial={false} mode="popLayout">
				{methods.map(method => (
					<motion.div key={method.id} {...listRowMotion} className="flex items-center justify-between gap-4 py-2">
						<span className="min-w-0 flex-1 break-words text-md text-fg">{method.name}</span>
						<Button size="sm" icon={<SignIn />} onClick={() => onSignIn({ methodId: method.id, name: method.name })}>
							{t("providers.add.action")}
						</Button>
					</motion.div>
				))}
			</AnimatePresence>
		</div>
	);
}
