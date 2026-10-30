import type { TspNode, TspProps } from "@shared/tsp";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Chart, type ChartSpec } from "../../../ui/Chart";
import { Spinner } from "../../../ui/Spinner";
import { Progress } from "../../../ui/Progress";
import { FadeIn } from "../../../ui/motion";
import { plain } from "../labels";

function Elapsed({ age, stopped }: { age: number; stopped?: number }) {
	const [now, setNow] = useState(0);
	useEffect(() => {
		setNow(0);
		if (stopped !== undefined) return;
		const start = Date.now();
		const timer = setInterval(() => setNow(Date.now() - start), 1000);
		return () => clearInterval(timer);
	}, [age, stopped]);
	return <span className="font-mono tabular-nums">{((stopped ?? age + now) / 1000).toFixed(0)}s</span>;
}
function ChartNode({ p }: { p?: TspProps<"chart"> }) {
	const { t } = useTranslation("palette");
	if (!p) return null;
	const points = p.series ?? [];
	const cells = p.cells ?? [];
	const columns = cells.reduce((width, row) => Math.max(width, row.length), 0);
	const spec: ChartSpec = p.kind === "heatmap" ? {
		kind: "heatmap", axis: "", caption: plain(p.summary),
		categories: cells.map((_, index) => p.rows?.[index] ?? String(index + 1)),
		series: Array.from({ length: columns }, (_, column) => ({
			name: p.cols?.find(label => label.at === column)?.label ?? String(column + 1), dim: "count", unit: "",
			points: cells.map(row => row[column] == null ? null : { value: row[column]!, text: String(row[column]), emphasis: false }),
			notes: cells.map((_, row) => p.tips?.[row]?.[column] ?? undefined),
		})),
	} : {
		kind: p.kind === "spark" ? "line" : "bar", axis: "", caption: plain(p.summary),
		categories: points.map((point, index) => point.label ?? String(index + 1)),
		series: [{ name: plain(p.summary), dim: "count", unit: "", points: points.map(point => ({ value: point.value, text: String(point.value), emphasis: false })), notes: points.map(point => point.title) }],
	};
	return <div className="space-y-2">
		<Chart label={p.aria ?? t("tsp.chart")} spec={spec} />
		<table className="sr-only" aria-label={p.aria ?? t("tsp.chart")}>
			<thead><tr><th>{p.aria ?? t("tsp.chart")}</th>{spec.series.map((series, index) => <th key={index}>{series.name}</th>)}</tr></thead>
			<tbody>{spec.categories.map((category, row) => <tr key={row}><th>{category}</th>{spec.series.map((series, column) => <td key={column}>{series.points[row]?.text ?? ""}</td>)}</tr>)}</tbody>
		</table>
	</div>;
}
export function Live({ node }: { node: TspNode }) {
	const { t } = useTranslation("palette");
	switch (node.k) {
		case "spinner": return <FadeIn className="flex items-center gap-2"><Spinner size={14} /><span>{plain(node.p?.label)}</span></FadeIn>;
		case "shimmer": return <FadeIn><p className="whitespace-pre-wrap break-words">{plain(node.p?.spans ?? node.p?.text)}</p></FadeIn>;
		case "elapsed": return <Elapsed age={node.p?.age ?? 0} stopped={node.p?.stopped} />;
		case "progress": case "meter": return <Progress aria-label={plain(node.p?.label) || node.p?.aria || t("tsp.progress")} value={node.p?.value == null ? undefined : node.p.value * 100} showValue />;
		case "rate": return <span className="font-mono tabular-nums">{node.p?.value} {node.p?.unit}</span>;
		case "chart": return <ChartNode p={node.p} />;
		default: return null;
	}
}
