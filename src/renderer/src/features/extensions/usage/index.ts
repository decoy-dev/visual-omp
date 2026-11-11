/** Usage & limits: its page (own chunk), its command, the status bar's plan usage and expired sign-in notices. */
import { Gauge } from "@phosphor-icons/react";
import { registerCommand } from "@/registry/commands";
import { lazyPage } from "@/registry/lazy";
import { globals, pages, statusItems } from "@/registry/slots";
import { openUsage } from "@/state/navigation";
import { ExpiredSignInWatcher } from "./expiredSignIns";
import { PlanUsageStatus } from "./PlanUsageStatus";

pages.register({
	id: "usage",
	component: lazyPage(() => import("./UsagePage").then(m => m.UsagePage), { title: "extensions:usage.title", width: "data" }),
});

registerCommand({
	id: "manage.usage",
	title: "extensions:commands.usage.title",
	hint: "extensions:commands.usage.hint",
	keywords: "extensions:commands.usage.keywords",
	slash: "/usage",
	group: "manage",
	icon: Gauge,
	run: ({ projectPath }) => openUsage({ projectPath }),
});

statusItems.register({ id: "usage-limits", title: "settings:status.items.usage", side: "right", order: 10, component: PlanUsageStatus });
globals.register({ id: "usage.expired-sign-ins", component: ExpiredSignInWatcher });
