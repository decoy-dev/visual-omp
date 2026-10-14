/**
 * Category navigation for full pages (Settings): sentence-case groups of 32px items; the selected item is a raised
 * pill that slides between them. Two placements, set by `PageFrame`: inline on the page (a left column on the canvas,
 * or a select when the page is narrow), or docked in the ink sidebar (always the list). The tokens resolve per surface,
 * so the same classes read on the canvas and on the ink.
 */
import { motion } from "motion/react";
import { createContext, type ReactNode, useContext, useId } from "react";
import { cn } from "./cn";
import { spring } from "./motion";
import { Select, SelectGroup, SelectItem, SelectLabel } from "./Select";
import { SectionLabel } from "./Display";
import { focusRingInset } from "./styles";

export type NavRailPlacement = "inline" | "sidebar";

/** Where `PageFrame` put the rail. Provided by PageFrame; a rail outside one renders inline. */
export const NavRailPlacementContext = createContext<NavRailPlacement>("inline");

export interface NavRailItem {
	id: string;
	label: string;
	icon?: ReactNode;
	/** Trailing count or status, such as a warning glyph. */
	trailing?: ReactNode;
}

export interface NavRailGroup {
	id: string;
	/** Omit for an unlabeled group. */
	label?: string;
	items: readonly NavRailItem[];
}

export interface NavRailProps {
	groups: readonly NavRailGroup[];
	value: string;
	onValueChange(id: string): void;
	/** Accessible name, such as "Settings sections". */
	label: string;
}

export function NavRail({ groups, value, onValueChange, label }: NavRailProps) {
	const fillId = `vo-navrail-${useId()}`;
	const placement = useContext(NavRailPlacementContext);
	const docked = placement === "sidebar";
	return (
		<>
			{/* `data-nav-rail` and `data-nav-target` mark the rail and its selected section for focus that follows the rail between the sidebar and the page (⌘B). */}
			<nav aria-label={label} data-nav-rail className={cn("flex-col gap-4", docked ? "flex" : "hidden @2xl/page:flex")}>
				{groups.map(group => (
					<div key={group.id} className="flex flex-col gap-1">
						{group.label && <SectionLabel className="px-2 pb-1">{group.label}</SectionLabel>}
						{group.items.map(item => {
							const selected = item.id === value;
							return (
								<button
									key={item.id}
									type="button"
									aria-current={selected ? "page" : undefined}
									data-nav-target={selected ? "" : undefined}
									onClick={() => onValueChange(item.id)}
									className={cn(
										"relative isolate flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-md transition-colors duration-(--dur-fast)",
										selected ? "font-medium text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
										"[&_svg]:size-4 [&_svg]:shrink-0",
										focusRingInset,
									)}
								>
									{selected && (
										<motion.span aria-hidden layoutId={fillId} transition={spring.snappy} className="absolute inset-0 -z-10 rounded-md bg-pill shadow-(--shadow-pill)" />
									)}
									{item.icon}
									<span className="min-w-0 flex-1 truncate">{item.label}</span>
									{item.trailing}
								</button>
							);
						})}
					</div>
				))}
			</nav>
			{!docked && (
				<div data-nav-rail data-nav-target className="w-full @2xl/page:hidden">
					<Select aria-label={label} value={value} onValueChange={onValueChange} className="w-full">
						{groups.map(group => (
							<SelectGroup key={group.id}>
								{group.label && <SelectLabel>{group.label}</SelectLabel>}
								{group.items.map(item => (
									<SelectItem key={item.id} value={item.id} icon={item.icon}>
										{item.label}
									</SelectItem>
								))}
							</SelectGroup>
						))}
					</Select>
				</div>
			)}
		</>
	);
}
