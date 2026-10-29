import { escapeHtml } from "../../collab/lib/format";
import type { ChartSpec } from "./vendor/omp/chart-plan";
import { formatValue } from "./vendor/omp/chart-svg";

export interface ChartDomain { min: number; max: number }
const WIDTH = 720;
const COLORS = ["c1", "c2", "c3", "c4", "c5", "c6"];

/** Widget bounds and reference values must stay visible even before the observed data reaches them. */
export function chartDomain(spec: ChartSpec, domain?: ChartDomain): ChartDomain {
	const values = spec.series.flatMap(series => series.points.flatMap(point => point && Number.isFinite(point.value) ? [point.value] : []));
	for (const annotation of spec.annotations || []) if (annotation.kind === "reference" && Number.isFinite(annotation.value)) values.push(annotation.value);
	if (domain && Number.isFinite(domain.min)) values.push(domain.min);
	if (domain && Number.isFinite(domain.max)) values.push(domain.max);
	const min = domain && Number.isFinite(domain.min) ? Math.min(domain.min, ...values) : Math.min(0, ...values);
	const max = Math.max(min, ...values);
	return { min, max: max > min ? max : min + 1 };
}
const n = (value: number) => Number(value.toFixed(2));
const shorten = (label: string, length = 28) => label.length > length ? `${label.slice(0, length - 1)}…` : label;
const text = (x: number, y: number, label: string, anchor = "start", color = "muted", size = 12) => `<text x="${n(x)}" y="${n(y)}" text-anchor="${anchor}" fill="var(--${color})" font-size="${size}"><title>${escapeHtml(label)}</title>${escapeHtml(shorten(label))}</text>`;
const line = (x1: number, y1: number, x2: number, y2: number, color = "border", dashed = false) => `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="var(--${color})"${dashed ? ' stroke-dasharray="4 4"' : ""}/>`;

/** Local adaptation for widgets. omp's table renderer has no explicit axis-domain contract. */
export function renderDomainChart(spec: ChartSpec, domain?: ChartDomain): string {
	const bounds = chartDomain(spec, domain);
	const span = bounds.max - bounds.min;
	const parts: string[] = [];
	const names = spec.series.map(series => series.name).filter(Boolean).join(" · ");
	const title = spec.title || names;
	parts.push(text(12, 18, title, "start", "fg", 13));
	if (spec.series.length > 1) for (const [index, series] of spec.series.entries()) {
		const x = 16 + index * 116;
		parts.push(`<circle cx="${x}" cy="34" r="3" fill="var(--${COLORS[index % COLORS.length]})"/>`);
		parts.push(text(x + 8, 38, shorten(series.name, 14), "start", "muted", 11));
	}
	const first = spec.series[0];
	const format = (value: number) => formatValue(value, first?.dim || "count", first?.unit || "", Math.max(Math.abs(bounds.min), Math.abs(bounds.max)));
	let height: number;
	if (spec.kind === "bar") {
		const left = 180, right = WIDTH - 82, top = 44, rowHeight = 32;
		height = top + spec.categories.length * rowHeight + 34;
		const x = (value: number) => left + (value - bounds.min) / span * (right - left);
		for (let tick = 0; tick <= 4; tick++) {
			const value = bounds.min + span * tick / 4;
			parts.push(line(x(value), top - 8, x(value), height - 28));
			parts.push(text(x(value), height - 10, format(value), "middle", "muted", 11));
		}
		spec.categories.forEach((category, row) => {
			const y = top + row * rowHeight;
			parts.push(text(left - 12, y + 15, category, "end"));
			for (const [index, series] of spec.series.entries()) {
				const point = series.points[row];
				if (!point || !Number.isFinite(point.value)) continue;
				const barHeight = Math.max(3, 20 / spec.series.length);
				const zero = x(Math.max(bounds.min, Math.min(0, bounds.max)));
				parts.push(`<rect x="${n(Math.min(zero, x(point.value)))}" y="${n(y + index * barHeight)}" width="${n(Math.abs(x(point.value) - zero))}" height="${n(barHeight - 1)}" rx="3" fill="var(--${COLORS[index % COLORS.length]})"><title>${escapeHtml(`${category} · ${series.name}: ${point.text}`)}</title></rect>`);
				parts.push(text(right + 8, y + index * barHeight + barHeight - 3, point.text, "start", "fg", 11));
			}
		});
	} else {
		const left = 70, right = WIDTH - 20, top = 52, bottom = 226;
		height = 264;
		const y = (value: number) => bottom - (value - bounds.min) / span * (bottom - top);
		const xValues = spec.x?.values;
		const xMin = xValues?.length ? Math.min(...xValues) : 0;
		const xMax = xValues?.length ? Math.max(...xValues) : spec.categories.length - 1;
		const x = (index: number) => xMax === xMin ? (left + right) / 2 : left + ((xValues?.[index] ?? index) - xMin) / (xMax - xMin) * (right - left);
		for (let tick = 0; tick <= 4; tick++) {
			const value = bounds.min + span * tick / 4;
			parts.push(line(left, y(value), right, y(value)));
			parts.push(text(left - 10, y(value) + 4, format(value), "end", "muted", 11));
		}
		for (const annotation of spec.annotations || []) if (annotation.kind === "reference" && Number.isFinite(annotation.value)) {
			parts.push(line(left, y(annotation.value), right, y(annotation.value), "muted", true));
			parts.push(text(right, y(annotation.value) - 6, `${annotation.label} · ${format(annotation.value)}`, "end"));
		}
		for (const [index, series] of spec.series.entries()) {
			const color = COLORS[index % COLORS.length];
			let path = "", continuing = false;
			series.points.forEach((point, at) => {
				if (!point || !Number.isFinite(point.value)) { continuing = false; return; }
				path += `${continuing ? "L" : "M"}${n(x(at))} ${n(y(point.value))}`;
				continuing = true;
				parts.push(`<circle cx="${n(x(at))}" cy="${n(y(point.value))}" r="3" fill="var(--${color})"><title>${escapeHtml(`${spec.categories[at]} · ${series.name}: ${point.text}`)}</title></circle>`);
			});
			parts.push(`<path d="${path}" fill="none" stroke="var(--${color})" stroke-width="2" stroke-linejoin="round"/>`);
		}
		const step = Math.max(1, Math.ceil(spec.categories.length / 8));
		spec.categories.forEach((category, at) => {
			if (at % step === 0 || at === spec.categories.length - 1) parts.push(text(x(at), bottom + 20, category, "middle", "muted", 11));
		});
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${escapeHtml(`${title} · ${spec.axis}`)}" font-family="Geist, sans-serif">${parts.join("")}</svg>`;
}
