import { Markdown } from "../../../transcript/Markdown";
import type { LiveAdapter, LiveFrameProps } from "../types";
import { SizeNote, useContentHeight, useSourceText, WaitingForSave } from "./shared";

export function Frame({ subject, onHeight }: LiveFrameProps) {
	const { text, error, tooLarge } = useSourceText(subject);
	const content = useContentHeight(onHeight);
	return <div className="min-h-0 flex-1 overflow-auto p-4"><div ref={content} className="flow-root">{subject.elided ? <SizeNote /> : <><Markdown text={text ?? ""} />{error && <WaitingForSave tooLarge={tooLarge} />}</>}</div></div>;
}

export const adapter: LiveAdapter = { format: "markdown", maxFps: 4, Frame };
