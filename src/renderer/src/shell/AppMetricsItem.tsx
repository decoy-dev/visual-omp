import { Cpu, Memory } from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverContent, PopoverTrigger, Tooltip } from "../ui";
import { focusRing } from "../ui/styles";
import { type CpuSample, useAppMetrics } from "./useAppMetrics";

function CpuTrend({ samples }: { samples: CpuSample[] }) {
	const end = samples.at(-1)?.at ?? 0;
	let path = "";
	let connected = false;
	for (const sample of samples) {
		if (sample.percent === null) { connected = false; continue; }
		const x = 1 + 46 * (1 - (end - sample.at) / 60_000);
		const y = 15 - sample.percent * 0.14;
		path += `${connected ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
		connected = true;
	}
	return <svg aria-hidden="true" viewBox="0 0 48 16" className="hidden h-4 w-12 shrink-0 text-fg-muted @min-[52rem]/status:block">
		<path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
	</svg>;
}

/** App-only native resource use, with a keyboard-accessible explanation of the measurement. */
export function AppMetricsItem({ metric }: { metric: "cpu" | "memory" }) {
	const { t, i18n } = useTranslation("shell");
	const { cpuPercent, memoryBytes, history } = useAppMetrics();
	const [open, setOpen] = useState(false);
	const [tooltipOpen, setTooltipOpen] = useState(false);
	const unavailable = t("status.resources.unavailable");
	const cpu = cpuPercent === null ? unavailable : t("status.resources.percent", { value: new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(cpuPercent) });
	const memory = memoryBytes === null ? unavailable : t(memoryBytes < 1024 ** 3 ? "status.resources.mib" : "status.resources.gib", {
		value: new Intl.NumberFormat(i18n.language, { maximumFractionDigits: memoryBytes < 1024 ** 3 ? 0 : 1 }).format(memoryBytes / (memoryBytes < 1024 ** 3 ? 1024 ** 2 : 1024 ** 3)),
	});
	const summary = t("status.resources.summary", { cpu: cpuPercent === null ? t("status.resources.unknown") : cpu, memory: memoryBytes === null ? t("status.resources.unknown") : memory });
	const Icon = metric === "cpu" ? Cpu : Memory;
	const label = t(metric === "cpu" ? "status.resources.cpuLabel" : "status.resources.memoryLabel", { value: metric === "cpu" ? cpuPercent === null ? t("status.resources.unknown") : cpu : memoryBytes === null ? t("status.resources.unknown") : memory });
	return <Popover open={open} onOpenChange={setOpen}>
		<Tooltip content={t("status.resources.hint")} open={tooltipOpen && !open} onOpenChange={setTooltipOpen}>
			<PopoverTrigger asChild>
				<button type="button" aria-label={label} className={`flex h-6 shrink-0 items-center gap-toolbar rounded-sm px-1.5 tabular-nums hover:bg-hover hover:text-fg ${focusRing}`}>
					<Icon aria-hidden className="size-3.5 @min-[40rem]/status:hidden" />
					<span aria-hidden className="hidden items-center gap-toolbar @min-[40rem]/status:flex">
						{metric === "cpu" && <CpuTrend samples={history} />}
						<span className={`inline-block text-right ${metric === "cpu" ? "w-[9ch]" : "w-[13ch]"}`}>{t(metric === "cpu" ? "status.resources.cpu" : "status.resources.ram", { value: metric === "cpu" ? cpu : memory })}</span>
					</span>
				</button>
			</PopoverTrigger>
		</Tooltip>
		<PopoverContent side="top" align="end" width="min(24rem, calc(100vw - 2rem))" title={t("status.resources.title")}>
			<div className="flex flex-col gap-stack text-sm leading-normal text-fg-muted">
				<p className="font-mono text-fg">{summary}</p>
				<p>{t("status.resources.scope")}</p>
				<p>{t("status.resources.cpuScope")}</p>
				<p>{t("status.resources.memoryScope")}</p>
				<p>{t("status.resources.history")}</p>
			</div>
		</PopoverContent>
	</Popover>;
}
