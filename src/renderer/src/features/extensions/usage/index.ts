/** Usage & limits: its page, its command and the status bar's plan usage. */
import { Gauge } from "@phosphor-icons/react";
import { registerCommand } from "@/registry/commands";
import { pages, statusItems } from "@/registry/slots";
import { openUsage } from "@/state/navigation";
import { PlanUsageStatus } from "./PlanUsageStatus";
import { UsagePage } from "./UsagePage";

pages.register({ id: "usage", component: UsagePage });

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
