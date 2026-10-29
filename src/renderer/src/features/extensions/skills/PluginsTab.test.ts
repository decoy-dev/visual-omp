import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AvailablePlugin, MarketplacePlugin, NpmPlugin, PluginsListing } from "@shared/contracts/plugins";
import type { Operation } from "./operations";
import { PluginsTab } from "./PluginsTab";

const fake = vi.hoisted(() => ({
	listing: { npm: [], marketplace: [] } as PluginsListing,
	catalog: [] as AvailablePlugin[],
	catalogError: null as string | null,
	loads: 0,
	buttons: [] as { label: ReactNode; disabled?: boolean; click(): void }[],
	running: undefined as Operation | undefined,
	invoke: vi.fn(),
	reload: vi.fn(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/features/manage/listMotion", () => ({ listRowMotion: {} }));
vi.mock("motion/react", () => ({
	AnimatePresence: ({ children }: { children: ReactNode }) => children,
	motion: { li: ({ children, className }: { children: ReactNode; className?: string }) => createElement("li", { className }, children) },
}));
vi.mock("../shared", () => ({
	LetterTile: () => null,
	useIpcEvent: () => {},
	useLoad: () => fake.loads++ % 2 === 0
		? { data: fake.listing, error: null, loading: false, reload: fake.reload }
		: { data: fake.catalog, error: fake.catalogError, loading: false, reload: fake.reload },
}));
vi.mock("./operations", () => ({ useOperations: () => ({
	list: [], dismiss: vi.fn(), runningFor: () => fake.running,
	start: async (_subject: string, _verb: string, invoke: (opId: string) => Promise<unknown>) => invoke("update-op"),
}) }));
vi.mock("./OperationLog", () => ({ OperationLog: () => null, InlineProgress: () => null }));
vi.mock("@/ui", () => ({
	Button: ({ children, disabled, onClick }: { children: ReactNode; disabled?: boolean; onClick(): void }) => {
		fake.buttons.push({ label: children, disabled, click: onClick });
		return createElement("button", { disabled }, children);
	},
	Chip: ({ children }: { children: ReactNode }) => children,
	PresenceSwap: ({ children }: { children: ReactNode }) => children,
	Notice: ({ children }: { children: ReactNode }) => children,
	Switch: () => null, Skeleton: () => null, EmptyState: () => null,
	Input: () => null, Menu: () => null, MenuContent: () => null, MenuItem: () => null, MenuTrigger: () => null,
	toast: vi.fn(),
}));

const npm: NpmPlugin = {
	kind: "npm", name: "@example/omp-plugin", version: "1.0.0", path: "/fixture/node_modules/@example/omp-plugin",
	description: "An installed npm package", enabled: true, enabledFeatures: null, features: [], settings: [],
	entryPoints: { tools: null, hooks: null, extensions: [], commands: [] },
};
const marketplace: MarketplacePlugin = {
	kind: "marketplace", id: "review@catalog", name: "review", marketplace: "catalog", scope: "project",
	version: "1.0.0", enabled: true, shadowedByProject: false, installs: [],
};

beforeEach(() => {
	vi.clearAllMocks();
	fake.listing = { npm: [], marketplace: [] };
	fake.catalog = [];
	fake.catalogError = null;
	fake.loads = 0;
	fake.buttons = [];
	fake.running = undefined;
	fake.invoke.mockResolvedValue({ opId: "update-op", ok: true, error: null, log: [], upgrades: [] });
	vi.stubGlobal("window", { vomp: { invoke: fake.invoke } });
});
afterEach(() => { vi.unstubAllGlobals(); });

function render() {
	fake.loads = 0;
	return renderToStaticMarkup(createElement(PluginsTab, { cwd: "/fixture/project", projectPath: "/fixture/project", filter: "installed", query: "", onBrowse: () => {} }));
}

describe("installed plugin update actions", () => {
	it.each([
		["scoped npm package", "@example/omp-plugin"],
		["git-installed package", "ida-mcp"],
	])("offers Update for a %s and submits its installed package name", (_kind, name) => {
		fake.listing.npm = [{ ...npm, name }];
		fake.catalogError = "Marketplace is offline";
		expect(render()).toContain("plugins.update");
		const update = fake.buttons.find(button => button.label === "plugins.update")!;
		expect(update.disabled).toBe(false);
		update.click();
		expect(fake.invoke).toHaveBeenCalledWith("plugins:upgrade", { id: name, scope: undefined, cwd: "/fixture/project", opId: "update-op" });
		expect(fake.invoke).not.toHaveBeenCalledWith("plugins:install", expect.anything());
	});

	it("preserves the marketplace catalog update action and its qualified ID and scope", () => {
		fake.listing.marketplace = [marketplace];
		fake.catalog = [{ id: marketplace.id, name: marketplace.name, marketplace: "catalog", version: "2.0.0", description: null, installedScopes: ["project"] }];
		expect(render()).toContain("plugins.updateChip");
		fake.buttons.find(button => button.label === "plugins.update")!.click();
		expect(fake.invoke).toHaveBeenCalledWith("plugins:upgrade", { id: "review@catalog", scope: "project", cwd: "/fixture/project", opId: "update-op" });
	});

	it("keeps marketplace Update hidden without a newer catalog version", () => {
		fake.listing.marketplace = [marketplace];
		render();
		expect(fake.buttons.some(button => button.label === "plugins.update")).toBe(false);
	});

	it("disables the package Update action while its operation is running", () => {
		fake.listing.npm = [npm];
		fake.running = { opId: "running-op", subject: npm.name, verb: "updating", lines: [], running: true, error: null };
		render();
		expect(fake.buttons.find(button => button.label === "plugins.update")?.disabled).toBe(true);
	});
});
