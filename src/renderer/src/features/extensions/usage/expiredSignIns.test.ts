// @vitest-environment happy-dom
import type { DisabledCredential, UsageLimitsSnapshot } from "@shared/contracts/usage";
import type { AppPreferences } from "@shared/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ toast: vi.fn(), openSettings: vi.fn() }));
vi.mock("@/ui", () => ({ toast: fake.toast }));
vi.mock("@/state/navigation", () => ({ openSettings: fake.openSettings }));

type SavePrefs = (patch: Partial<AppPreferences>) => Promise<void>;

let nextId = 1;
const credential = (patch: Partial<DisabledCredential> = {}): DisabledCredential => ({
	id: nextId++, provider: "anthropic", type: "oauth", email: "me@example.com", cause: "refresh failed: invalid_grant", disabledAtMs: Date.UTC(2026, 10, 10, 18), ...patch,
});
let generatedAt = 1;
const snapshot = (disabledCredentials: DisabledCredential[], at = generatedAt++): UsageLimitsSnapshot => ({ generatedAt: at, reports: [], accountsWithoutUsage: [], disabledCredentials, capacity: {} });
const messages = () => fake.toast.mock.calls.map(([options]) => options.message as string);

/** A fresh module graph is a fresh app launch: only the preferences passed in survive. */
async function launch(shown: string[] = [], save?: SavePrefs) {
	vi.resetModules();
	const [{ useApp }, notice, store, { i18n }, react, client] = await Promise.all([
		import("@/state/app"), import("./expiredSignIns"), import("./limitsStore"), import("@/i18n"), import("react"), import("react-dom/client"),
	]);
	const persist: SavePrefs = async patch => {
		useApp.setState(state => ({ prefs: state.prefs && { ...state.prefs, ...patch } }));
	};
	const setPrefs = vi.fn(save ?? persist);
	useApp.setState({ prefs: { setupCompleted: true, expiredSignInsShown: shown } as unknown as AppPreferences, setPrefs });
	return { useApp, setPrefs, ...notice, ...store, t: i18n.getFixedT("en", "extensions"), react, client };
}

beforeEach(() => {
	fake.toast.mockClear();
	fake.openSettings.mockClear();
});

describe("unannounced sign-ins", () => {
	it("skips omp's own sign-outs and keys already shown", async () => {
		const { unannouncedSignIns, expiredSignInKey } = await launch();
		const expired = credential();
		const shown = credential({ provider: "openai-codex" });
		const signedOut = credential({ cause: "logged out by user" });
		expect(unannouncedSignIns(snapshot([expired, shown, signedOut]), [expiredSignInKey(shown)])).toEqual([expired]);
	});

	it("treats a credential disabled again as a new sign-in to announce", async () => {
		const { unannouncedSignIns, expiredSignInKey } = await launch();
		const first = credential({ disabledAtMs: 100 });
		expect(unannouncedSignIns(snapshot([{ ...first, disabledAtMs: 200 }]), [expiredSignInKey(first)])).toHaveLength(1);
	});
});

describe("notice text", () => {
	it("names the provider, account and date for one sign-in", async () => {
		const { expiredSignInNotice, t } = await launch();
		expect(expiredSignInNotice([credential()], t, "en")).toEqual({
			message: "Claude needs you to sign in again",
			description: "omp stopped using me@example.com on Nov 10.",
		});
	});

	it("falls back when omp reports no account or time", async () => {
		const { expiredSignInNotice, t } = await launch();
		expect(expiredSignInNotice([credential({ email: undefined, disabledAtMs: undefined })], t, "en").description).toBe("omp stopped using a sign-in.");
		expect(expiredSignInNotice([credential({ email: undefined, accountId: "acct-7", disabledAtMs: undefined })], t, "en").description).toBe("omp stopped using acct-7.");
	});

	it("counts sign-ins for one provider and lists several providers", async () => {
		const { expiredSignInNotice, t } = await launch();
		expect(expiredSignInNotice([credential(), credential()], t, "en").description).toBe("omp stopped using 2 sign-ins for this provider.");
		expect(expiredSignInNotice([credential(), credential({ provider: "openai-codex" }), credential({ provider: "openai-codex" })], t, "en")).toEqual({
			message: "2 providers need you to sign in again",
			description: "omp stopped using sign-ins for Claude and Codex.",
		});
	});
});

describe("announcing", () => {
	it("announces each sign-in once, records it and opens Providers from the notice", async () => {
		const { announceExpiredSignIns, expiredSignInKey, useApp } = await launch();
		const expired = credential();
		announceExpiredSignIns(snapshot([expired]));
		announceExpiredSignIns(snapshot([expired]));

		expect(fake.toast).toHaveBeenCalledTimes(1);
		expect(fake.toast.mock.calls[0]?.[0]).toMatchObject({ tone: "warn", message: "Claude needs you to sign in again", action: { label: "Open Providers" } });
		expect(useApp.getState().prefs?.expiredSignInsShown).toEqual([expiredSignInKey(expired)]);
		fake.toast.mock.calls[0]?.[0].action.onClick();
		expect(fake.openSettings).toHaveBeenCalledWith("providers");
	});

	it("reports only sign-ins disabled since the previous launch", async () => {
		const expired = credential();
		const first = await launch();
		first.announceExpiredSignIns(snapshot([expired]));
		const stored = first.useApp.getState().prefs?.expiredSignInsShown ?? [];
		fake.toast.mockClear();

		const next = await launch(stored);
		const later = credential({ provider: "openai-codex", email: "work@example.com" });
		next.announceExpiredSignIns(snapshot([expired, later]));
		expect(messages()).toEqual(["Codex needs you to sign in again"]);
		expect(next.useApp.getState().prefs?.expiredSignInsShown).toEqual([...stored, next.expiredSignInKey(later)]);
	});

	it("does not repeat a notice when snapshots overlap before preferences save", async () => {
		const { announceExpiredSignIns, expiredSignInKey, setPrefs } = await launch([], () => Promise.withResolvers<void>().promise);
		const first = credential();
		const second = credential({ provider: "openai-codex" });
		announceExpiredSignIns(snapshot([first]));
		announceExpiredSignIns(snapshot([first, second]));
		expect(messages()).toEqual(["Claude needs you to sign in again", "Codex needs you to sign in again"]);
		expect(setPrefs).toHaveBeenLastCalledWith({ expiredSignInsShown: [expiredSignInKey(first), expiredSignInKey(second)] });
	});

	it("keeps a failed save from repeating the notice in the same run", async () => {
		const { announceExpiredSignIns, setPrefs } = await launch([], async () => {
			throw new Error("disk full");
		});
		const expired = credential();
		announceExpiredSignIns(snapshot([expired]));
		await expect(setPrefs.mock.results[0]?.value).rejects.toThrow("disk full");
		announceExpiredSignIns(snapshot([expired]));
		expect(fake.toast).toHaveBeenCalledTimes(1);
	});
});

describe("watcher", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("waits for a usable omp, reads limits once and checks only accepted later snapshots", async () => {
		const app = await launch();
		const expired = credential({ provider: "openai-codex" });
		const invoke = vi.fn(async () => snapshot([expired], 100));
		vi.stubGlobal("vomp", { invoke });
		app.useApp.setState({ omp: null });
		const element = document.createElement("div");
		const root = app.client.createRoot(element);
		await app.react.act(async () => root.render(app.react.createElement(app.ExpiredSignInWatcher)));
		expect(invoke).not.toHaveBeenCalled();

		await app.react.act(async () => app.useApp.setState({ omp: { found: true, supported: true, refused: false } as never }));
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(invoke).toHaveBeenCalledWith("usage:limits");
		expect(messages()).toEqual(["Codex needs you to sign in again"]);

		// The store drops a snapshot omp generated before the current one, so it cannot announce anything.
		const stale = credential({ email: "stale@example.com" });
		await app.react.act(async () => app.publishUsageLimits(snapshot([expired, stale], 50)));
		expect(fake.toast).toHaveBeenCalledTimes(1);

		// The status bar's polling publishes later snapshots; a sign-in disabled mid-session is announced too.
		await app.react.act(async () => app.publishUsageLimits(snapshot([expired, stale], 200)));
		expect(messages()).toEqual(["Codex needs you to sign in again", "Claude needs you to sign in again"]);
		expect(invoke).toHaveBeenCalledTimes(1);
		await app.react.act(async () => root.unmount());
	});
});
