import type { TspText } from "@shared/tsp";
import { Fragment } from "react";
import { Kbd } from "./Display";
import { shortcutKeyLabel, shortcutKeyName, shortcutRuns } from "./shortcuts";
import "./KeyCombinations.css";

export function KeyCombinations({ value }: { value: TspText }) {
	const platform = window.vomp.platform;
	return <span className="tsp-key-combinations">{shortcutRuns(value).map((run, index) => {
		if (run.kind === "chord") return <span key={index} className="tsp-key-chord" title={run.source}>
			<span className="sr-only">{run.keys.map(key => shortcutKeyName(key, platform)).join(" + ")}</span>
			<span aria-hidden className="tsp-key-chord">{run.keys.map((key, part) => <Fragment key={part}>{part > 0 && <span className="tsp-key-join">+</span>}<Kbd>{shortcutKeyLabel(key, platform)}</Kbd></Fragment>)}</span>
		</span>;
		if (run.kind === "code") return <code key={index}>{run.text}</code>;
		if (run.kind === "separator") return <Fragment key={index}><span aria-hidden className="tsp-key-separator">{run.text}</span><span className="sr-only"> or </span></Fragment>;
		return <span key={index} className="tsp-key-note">{run.text}</span>;
	})}</span>;
}
