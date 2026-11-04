import { Markdown } from "../../../transcript/Markdown";
import type { LiveAdapter, LiveFrameProps } from "../types";
import { SizeNote, useSourceText, WaitingForSave } from "./shared";

export function Frame({ subject }: LiveFrameProps) {
	const { text, error } = useSourceText(subject);
	return <div className="min-h-0 flex-1 overflow-auto p-4">{subject.elided ? <SizeNote /> : <><Markdown text={text ?? ""} />{error && <WaitingForSave />}</>}</div>;
}

export const adapter: LiveAdapter = { format: "markdown", maxFps: 4, Frame };
