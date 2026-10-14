/**
 * Table chrome shared by data screens: a 32px header that sticks within the page scroll, 40px rows with
 * hairlines, right-aligned numeric cells in mono. Sorting, paging and filtering stay with each screen.
 */
import { ArrowDown, ArrowUp } from "@phosphor-icons/react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "./cn";
import { focusRing } from "./styles";

export function Table({ className, ...rest }: ComponentPropsWithRef<"table">) {
	return <table className={cn("w-full table-fixed border-collapse text-md", className)} {...rest} />;
}

/** Sticks to the top of the page's scroll region. */
export function TableHead({ className, ...rest }: ComponentPropsWithRef<"thead">) {
	return <thead className={cn("sticky top-0 z-(--z-sticky) bg-bg", className)} {...rest} />;
}

export function TableRow({ className, ...rest }: ComponentPropsWithRef<"tr">) {
	return <tr className={cn("h-10 border-b border-border", className)} {...rest} />;
}

export type CellAlign = "left" | "right";

export interface HeaderCellProps extends ComponentPropsWithRef<"th"> {
	align?: CellAlign;
}

export function HeaderCell({ align = "left", className, ...rest }: HeaderCellProps) {
	return (
		<th
			scope="col"
			className={cn("h-8 border-b border-border px-3 text-xs font-medium text-fg-muted", align === "right" ? "text-right" : "text-left", className)}
			{...rest}
		/>
	);
}

export type SortDirection = "asc" | "desc";

export interface SortHeaderCellProps {
	label: ReactNode;
	/** This column is the current sort. */
	active: boolean;
	direction: SortDirection;
	onSort(): void;
	align?: CellAlign;
	className?: string;
}

/** Header cell whose label is a button; announces the sort with `aria-sort`. */
export function SortHeaderCell({ label, active, direction, onSort, align = "left", className }: SortHeaderCellProps) {
	const Arrow = direction === "asc" ? ArrowUp : ArrowDown;
	return (
		<HeaderCell align={align} aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"} className={className}>
			<button
				type="button"
				onClick={onSort}
				className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-sm hover:text-fg", active && "text-fg", focusRing)}
			>
				{label}
				{active && <Arrow aria-hidden className="size-3" />}
			</button>
		</HeaderCell>
	);
}

export interface CellProps extends ComponentPropsWithRef<"td"> {
	align?: CellAlign;
	/** Numbers: mono, tabular figures. */
	numeric?: boolean;
}

export function Cell({ align = "left", numeric, className, ...rest }: CellProps) {
	return (
		<td
			className={cn(
				"px-3 py-2",
				align === "right" ? "text-right" : "text-left",
				numeric && "font-mono text-sm tabular-nums",
				className,
			)}
			{...rest}
		/>
	);
}
