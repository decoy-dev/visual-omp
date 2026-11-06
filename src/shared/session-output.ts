/** Displayable saved tool content only. Tool details and traces never cross this boundary. */
export interface SavedOutputBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export type SavedToolOutput =
	| { status: "ready"; content: SavedOutputBlock[] }
	| { status: "unavailable" | "too-large" };
