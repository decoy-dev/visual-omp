/**
 * Onboarding & system surfaces: setup screen, first-run tour, help, update notices, background
 * notifications and the quit / close-tab warning.
 */
import { CircleHelp, Compass, Download } from "lucide-react";
import { registerCommand } from "../../registry/commands";
import { setTabCloseGuard } from "../../registry/guards";
import { globals, screens, sheets } from "../../registry/slots";
import { useApp } from "../../state/app";
import { HelpSheet } from "./HelpSheet";
import { installNotifications } from "./notifications";
import { confirmCloseTab, installQuitGuard, QuitDialog } from "./quit";
import { SetupScreen } from "./SetupScreen";
import { startTour, TourHost } from "./tour";
import { installUpdateWatchers, OMP_UPDATE_SHEET, OmpUpdateSheet } from "./updates";

screens.register({ id: "setup", component: SetupScreen });
sheets.register({ id: "help", component: HelpSheet });
sheets.register({ id: OMP_UPDATE_SHEET, component: OmpUpdateSheet });
globals.register({ id: "onboarding.tour", component: TourHost });
globals.register({ id: "onboarding.quit", component: QuitDialog });

registerCommand({
	id: "app.help",
	title: "onboarding:commands.help.title",
	hint: "onboarding:commands.help.hint",
	keywords: "onboarding:commands.help.keywords",
	group: "help",
	icon: CircleHelp,
	shortcut: "F1",
	run: () => useApp.getState().openSheet("help"),
});

registerCommand({
	id: "app.tour",
	title: "onboarding:commands.tour.title",
	hint: "onboarding:commands.tour.hint",
	keywords: "onboarding:commands.tour.keywords",
	group: "help",
	icon: Compass,
	run: () => {
		useApp.getState().closeSheet();
		startTour();
	},
});

registerCommand({
	id: "app.updateOmp",
	title: "onboarding:update.omp.title",
	hint: "onboarding:update.omp.hint",
	keywords: "onboarding:update.omp.keywords",
	group: "settings",
	icon: Download,
	run: () => useApp.getState().openSheet(OMP_UPDATE_SHEET),
});

setTabCloseGuard(confirmCloseTab);
installQuitGuard();
installNotifications();
installUpdateWatchers();
