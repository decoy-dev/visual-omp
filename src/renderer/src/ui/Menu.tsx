import * as CM from "@radix-ui/react-context-menu";
import * as DM from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "./cn";
import { floatingSurface, menuItem, menuItemDanger, menuLabel, menuSeparator, menuShortcut } from "./styles";

const contentClass = cn(floatingSurface, "min-w-[200px] p-1");

interface ItemExtras {
	/** Leading icon (lucide element, 16px). */
	icon?: ReactNode;
	/** Right-aligned shortcut in mono faint, e.g. "⌘⌫". */
	shortcut?: string;
	/** Destructive styling. */
	danger?: boolean;
}

function ItemBody({ icon, shortcut, children }: { icon?: ReactNode; shortcut?: string; children: ReactNode }) {
	return (
		<>
			{icon && <span className="inline-flex shrink-0 text-fg-muted [&>svg]:size-4 [[data-danger]_&]:text-err">{icon}</span>}
			<span className="min-w-0 flex-1 truncate">{children}</span>
			{shortcut && <kbd className={menuShortcut}>{shortcut}</kbd>}
		</>
	);
}

/** Left gutter holding the check / radio indicator so labels align with iconned items. */
const indicatorGutter = "inline-flex size-4 shrink-0 items-center justify-center text-accent";

// ---------------- Dropdown menu ----------------

export const Menu = DM.Root;
export const MenuTrigger = DM.Trigger;
export const MenuGroup = DM.Group;

export type MenuContentProps = ComponentPropsWithRef<typeof DM.Content>;

export function MenuContent({ className, sideOffset = 6, align = "start", collisionPadding = 8, ...rest }: MenuContentProps) {
	return (
		<DM.Portal>
			<DM.Content
				sideOffset={sideOffset}
				align={align}
				collisionPadding={collisionPadding}
				className={cn(contentClass, className)}
				{...rest}
			/>
		</DM.Portal>
	);
}

export interface MenuItemProps extends ComponentPropsWithRef<typeof DM.Item>, ItemExtras {}

export function MenuItem({ icon, shortcut, danger, className, children, ...rest }: MenuItemProps) {
	return (
		<DM.Item data-danger={danger ? "" : undefined} className={cn(menuItem, danger && menuItemDanger, className)} {...rest}>
			<ItemBody icon={icon} shortcut={shortcut}>
				{children}
			</ItemBody>
		</DM.Item>
	);
}

export interface MenuCheckboxItemProps extends ComponentPropsWithRef<typeof DM.CheckboxItem> {
	shortcut?: string;
}

export function MenuCheckboxItem({ shortcut, className, children, ...rest }: MenuCheckboxItemProps) {
	return (
		<DM.CheckboxItem className={cn(menuItem, className)} {...rest}>
			<span className={indicatorGutter}>
				<DM.ItemIndicator>
					<Check className="size-4" aria-hidden />
				</DM.ItemIndicator>
			</span>
			<ItemBody shortcut={shortcut}>{children}</ItemBody>
		</DM.CheckboxItem>
	);
}

export const MenuRadioGroup = DM.RadioGroup;

export interface MenuRadioItemProps extends ComponentPropsWithRef<typeof DM.RadioItem> {
	shortcut?: string;
}

export function MenuRadioItem({ shortcut, className, children, ...rest }: MenuRadioItemProps) {
	return (
		<DM.RadioItem className={cn(menuItem, className)} {...rest}>
			<span className={indicatorGutter}>
				<DM.ItemIndicator>
					<span className="block size-1.5 rounded-full bg-current" />
				</DM.ItemIndicator>
			</span>
			<ItemBody shortcut={shortcut}>{children}</ItemBody>
		</DM.RadioItem>
	);
}

export function MenuLabel({ className, ...rest }: ComponentPropsWithRef<typeof DM.Label>) {
	return <DM.Label className={cn(menuLabel, className)} {...rest} />;
}

export function MenuSeparator({ className, ...rest }: ComponentPropsWithRef<typeof DM.Separator>) {
	return <DM.Separator className={cn(menuSeparator, className)} {...rest} />;
}

export interface MenuSubProps {
	label: ReactNode;
	icon?: ReactNode;
	disabled?: boolean;
	children: ReactNode;
	contentClassName?: string;
}

/** Nested submenu: trigger row with chevron + portalled content. */
export function MenuSub({ label, icon, disabled, children, contentClassName }: MenuSubProps) {
	return (
		<DM.Sub>
			<DM.SubTrigger disabled={disabled} className={cn(menuItem, "data-[state=open]:bg-selected")}>
				<ItemBody icon={icon}>{label}</ItemBody>
				<ChevronRight className="ml-auto size-4 text-fg-faint" aria-hidden />
			</DM.SubTrigger>
			<DM.Portal>
				<DM.SubContent sideOffset={6} alignOffset={-5} collisionPadding={8} className={cn(contentClass, contentClassName)}>
					{children}
				</DM.SubContent>
			</DM.Portal>
		</DM.Sub>
	);
}

// ---------------- Context menu (same styles) ----------------

export const ContextMenu = CM.Root;
export const ContextMenuTrigger = CM.Trigger;
export const ContextMenuGroup = CM.Group;

export function ContextMenuContent({ className, collisionPadding = 8, ...rest }: ComponentPropsWithRef<typeof CM.Content>) {
	return (
		<CM.Portal>
			<CM.Content collisionPadding={collisionPadding} className={cn(contentClass, className)} {...rest} />
		</CM.Portal>
	);
}

export interface ContextMenuItemProps extends ComponentPropsWithRef<typeof CM.Item>, ItemExtras {}

export function ContextMenuItem({ icon, shortcut, danger, className, children, ...rest }: ContextMenuItemProps) {
	return (
		<CM.Item data-danger={danger ? "" : undefined} className={cn(menuItem, danger && menuItemDanger, className)} {...rest}>
			<ItemBody icon={icon} shortcut={shortcut}>
				{children}
			</ItemBody>
		</CM.Item>
	);
}

export interface ContextMenuCheckboxItemProps extends ComponentPropsWithRef<typeof CM.CheckboxItem> {
	shortcut?: string;
}

export function ContextMenuCheckboxItem({ shortcut, className, children, ...rest }: ContextMenuCheckboxItemProps) {
	return (
		<CM.CheckboxItem className={cn(menuItem, className)} {...rest}>
			<span className={indicatorGutter}>
				<CM.ItemIndicator>
					<Check className="size-4" aria-hidden />
				</CM.ItemIndicator>
			</span>
			<ItemBody shortcut={shortcut}>{children}</ItemBody>
		</CM.CheckboxItem>
	);
}

export const ContextMenuRadioGroup = CM.RadioGroup;

export interface ContextMenuRadioItemProps extends ComponentPropsWithRef<typeof CM.RadioItem> {
	shortcut?: string;
}

export function ContextMenuRadioItem({ shortcut, className, children, ...rest }: ContextMenuRadioItemProps) {
	return (
		<CM.RadioItem className={cn(menuItem, className)} {...rest}>
			<span className={indicatorGutter}>
				<CM.ItemIndicator>
					<span className="block size-1.5 rounded-full bg-current" />
				</CM.ItemIndicator>
			</span>
			<ItemBody shortcut={shortcut}>{children}</ItemBody>
		</CM.RadioItem>
	);
}

export function ContextMenuLabel({ className, ...rest }: ComponentPropsWithRef<typeof CM.Label>) {
	return <CM.Label className={cn(menuLabel, className)} {...rest} />;
}

export function ContextMenuSeparator({ className, ...rest }: ComponentPropsWithRef<typeof CM.Separator>) {
	return <CM.Separator className={cn(menuSeparator, className)} {...rest} />;
}

export function ContextMenuSub({ label, icon, disabled, children, contentClassName }: MenuSubProps) {
	return (
		<CM.Sub>
			<CM.SubTrigger disabled={disabled} className={cn(menuItem, "data-[state=open]:bg-selected")}>
				<ItemBody icon={icon}>{label}</ItemBody>
				<ChevronRight className="ml-auto size-4 text-fg-faint" aria-hidden />
			</CM.SubTrigger>
			<CM.Portal>
				<CM.SubContent sideOffset={6} alignOffset={-5} collisionPadding={8} className={cn(contentClass, contentClassName)}>
					{children}
				</CM.SubContent>
			</CM.Portal>
		</CM.Sub>
	);
}
