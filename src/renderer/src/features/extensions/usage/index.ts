/** Usage & limits: its page (own chunk), its command and the status bar's plan usage. */
import { Gauge } from "@phosphor-icons/react";
import { registerCommand } from "@/registry/commands";
import { lazyPage } from "@/registry/lazy";
import { pages, statusItems } from "@/registry/slots";
import { openUsage } from "@/state/navigation";
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

statusItems.register({ id: "usage-limits", side: "right", order: 10, component: PlanUsageStatus });
