/**
 * Onboarding & system surfaces: setup screen, first-run tour, the Help page, update notices,
 * background notifications and the quit / close-tab warning.
 */
import { Compass, DownloadSimple, GearSix, Question } from "@phosphor-icons/react";
import { createElement } from "react";
import { registerCommand } from "../../registry/commands";
import { setTabCloseGuard } from "../../registry/guards";
import { lazyPage, lazyView } from "../../registry/lazy";
import { globals, pages, screens, sheets } from "../../registry/slots";
import { useApp } from "../../state/app";
import { openHelp } from "../../state/navigation";
import { installNotifications } from "./notifications";
import { confirmCloseTab, installQuitGuard, QuitDialog } from "./quit";
import { startSetup } from "./setup";
import { startTourFromAnywhere, TourHost } from "./tour";
import { installUpdateWatchers, OMP_UPDATE_SHEET, OmpUpdateSheet } from "./updates";

/** Setup opens on its ink cover; the same color stands in while the wizard's chunk loads on first run. */
const setupLoading = () => createElement("main", { "aria-busy": true, className: "h-screen w-full bg-[var(--chrome-bg)]" });

screens.register({ id: "setup", component: lazyView(() => import("./SetupWizard").then(module => module.SetupWizard), setupLoading) });
pages.register({ id: "help", component: lazyPage(() => import("./HelpPage").then(module => module.HelpPage), { title: "onboarding:help.title", width: "form" }) });
sheets.register({ id: OMP_UPDATE_SHEET, component: OmpUpdateSheet });
globals.register({ id: "onboarding.tour", component: TourHost });
globals.register({ id: "onboarding.quit", component: QuitDialog });

registerCommand({
	id: "app.help",
	title: "onboarding:commands.help.title",
	hint: "onboarding:commands.help.hint",
	keywords: "onboarding:commands.help.keywords",
	group: "help",
	icon: Question,
	shortcut: "F1",
	run: openHelp,
});

registerCommand({
	id: "app.tour",
	title: "onboarding:commands.tour.title",
	hint: "onboarding:commands.tour.hint",
	keywords: "onboarding:commands.tour.keywords",
	group: "help",
	icon: Compass,
	run: startTourFromAnywhere,
});

registerCommand({
	id: "app.setup",
	title: "onboarding:commands.setup.title",
	hint: "onboarding:commands.setup.hint",
	keywords: "onboarding:commands.setup.keywords",
	group: "help",
	icon: GearSix,
	run: startSetup,
});

registerCommand({
	id: "app.updateOmp",
	title: "onboarding:update.omp.title",
	hint: "onboarding:update.omp.hint",
	keywords: "onboarding:update.omp.keywords",
	group: "settings",
	icon: DownloadSimple,
	run: () => useApp.getState().openSheet(OMP_UPDATE_SHEET),
});

setTabCloseGuard(confirmCloseTab);
installQuitGuard();
installNotifications();
installUpdateWatchers();
