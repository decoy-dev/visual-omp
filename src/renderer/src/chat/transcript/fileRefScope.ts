import { createContext } from "react";

/** The chat a transcript shows and where its relative names are looked up after the folders a reply names. */
export interface FileRefScope {
	/** Identifies the chat (its tab), so replies in different chats never share results. */
	chat: string;
	/** The chat's folder. Other candidates come from this reply's directory spans and known turn files. */
	bases: readonly string[];
	canonicalProjectPath?: string | null;
}

export const FileRefContext = createContext<FileRefScope | null>(null);
