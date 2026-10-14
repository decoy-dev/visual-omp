/** Usage & limits: its command and the status bar's plan usage and "today" cost. */
import { Gauge } from "@phosphor-icons/react";
import { registerCommand } from "@/registry/commands";
import { sheets, statusItems } from "@/registry/slots";
import { useApp } from "@/state/app";
import { PlanUsageStatus } from "./PlanUsageStatus";
import { UsageSheet } from "./UsageSheet";
import { UsageStatus } from "./UsageStatus";

sheets.register({ id: "usage", component: UsageSheet });

registerCommand({
	id: "manage.usage",
	title: "extensions:commands.usage.title",
	hint: "extensions:commands.usage.hint",
	keywords: "extensions:commands.usage.keywords",
	slash: "/usage",
	group: "manage",
	icon: Gauge,
	run: ({ projectPath }) => useApp.getState().openSheet("usage", { projectPath }),
});

statusItems.register({ id: "usage-limits", side: "right", order: 10, component: PlanUsageStatus });
statusItems.register({ id: "usage-today", side: "right", order: 20, component: UsageStatus });
