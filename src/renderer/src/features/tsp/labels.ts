import type { TspText } from "@shared/tsp";
/** Keep omp's text verbatim except unsupported private-use icon glyphs. */
export function plain(value: TspText | undefined): string {
	return (typeof value === "string" ? value : value?.map(span => span.s?.split(" ").includes("hide") ? "" : span.t).join("") ?? "").replace(/[\uE000-\uF8FF]|[\u{F0000}-\u{FFFFD}]|[\u{100000}-\u{10FFFD}]/gu, "");
}
