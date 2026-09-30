import {
	CircleCheck,
	CircleHelp,
	FolderOpen,
	GitBranch,
	GitFork,
	History,
	type LucideIcon,
	MessageSquareText,
	MessagesSquare,
	MousePointerClick,
	PanelRight,
	ShieldCheck,
	Bell,
	Undo2,
	Zap,
	Hand,
} from "lucide-react";

export interface Guide {
	id: "firstChat" | "autoMode" | "rewind" | "questions";
	icon: LucideIcon;
	/** Icons for the four illustrated steps (texts are `help.guide.<id>.s1..s4`). */
	steps: readonly [LucideIcon, LucideIcon, LucideIcon, LucideIcon];
}

export const GUIDES: readonly Guide[] = [
	{ id: "firstChat", icon: MessageSquareText, steps: [FolderOpen, MessagesSquare, PanelRight, Zap] },
	{ id: "autoMode", icon: ShieldCheck, steps: [MousePointerClick, Zap, Hand, Undo2] },
	{ id: "rewind", icon: History, steps: [MousePointerClick, Undo2, GitFork, GitBranch] },
	{ id: "questions", icon: CircleHelp, steps: [CircleHelp, MessageSquareText, CircleCheck, Bell] },
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
