import { ArrowUUpLeft, Bell, ChatsCircle, ChatText, CheckCircle, ClockCounterClockwise, CursorClick, FolderOpen, GitBranch, GitFork, Hand, type Icon, Lightning, Question, ShieldCheck, SidebarSimple } from "@phosphor-icons/react";

export interface Guide {
	id: "firstChat" | "autoMode" | "rewind" | "questions";
	icon: Icon;
	/** Icons for the four illustrated steps (texts are `help.guide.<id>.s1..s4`). */
	steps: readonly [Icon, Icon, Icon, Icon];
}

export const GUIDES: readonly Guide[] = [
	{ id: "firstChat", icon: ChatText, steps: [FolderOpen, ChatsCircle, SidebarSimple, Lightning] },
	{ id: "autoMode", icon: ShieldCheck, steps: [CursorClick, Lightning, Hand, ArrowUUpLeft] },
	{ id: "rewind", icon: ClockCounterClockwise, steps: [CursorClick, ArrowUUpLeft, GitFork, GitBranch] },
	{ id: "questions", icon: Question, steps: [Question, ChatText, CheckCircle, Bell] },
];

/** Glossary entries (`help.terms.<key>.term` / `.def`), in reading order. */
export const TERMS = [
	"context",
	"token",
	"compaction",
	"planMode",
	"worktree",
	"mcp",
	"agent",
	"skill",
	"hook",
	"subagent",
	"checkpoint",
	"tui",
	"modelRole",
] as const;

/** Case-insensitive match of every whitespace-separated word of `query` against `haystack`. */
export function matchesQuery(query: string, haystack: readonly string[]): boolean {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return true;
	const text = haystack.join(" ").toLowerCase();
	return words.every(word => text.includes(word));
}
