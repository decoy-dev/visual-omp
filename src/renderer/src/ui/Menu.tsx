import * as CM from "@radix-ui/react-context-menu";
import * as DM from "@radix-ui/react-dropdown-menu";
import { CaretRight, Check } from "@phosphor-icons/react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "./cn";
import { SwitchIndicator } from "./Switch";
import {
	menuCheckSlot,
	menuContent,
	menuDescription,
	menuIcon,
	menuItem,
	menuItemDanger,
	menuItemDescribed,
	menuLabel,
	menuSeparator,
	menuShortcut,
} from "./styles";

const contentClass = cn(menuContent, "min-w-50");

interface ItemExtras {
	/** Leading icon (Phosphor element, 16px). */
	icon?: ReactNode;
	/** Right-aligned shortcut in mono faint, e.g. "⌘⌫". */
	shortcut?: string;
	/** Destructive styling. */
	danger?: boolean;
}

function ItemBody({ icon, shortcut, children }: { icon?: ReactNode; shortcut?: string; children: ReactNode }) {
	return (
		<>
			{icon && <span className={cn(menuIcon, "[[data-danger]_&]:text-err")}>{icon}</span>}
			<span className="min-w-0 flex-1 truncate">{children}</span>
			{shortcut && <kbd className={menuShortcut}>{shortcut}</kbd>}
		</>
	);
}

/** Label with an optional muted second line. With a description the row grows to 44px and aligns to the top. */
function ChoiceBody({ shortcut, description, children }: { shortcut?: string; description?: ReactNode; children: ReactNode }) {
	if (!description) return <ItemBody shortcut={shortcut}>{children}</ItemBody>;
	return (
		<>
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate">{children}</span>
				<span className={menuDescription}>{description}</span>
			</span>
			{shortcut && <kbd className={menuShortcut}>{shortcut}</kbd>}
		</>
	);
}

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
	/** A trailing passive switch makes independent on/off settings distinct from radio choices. */
	indicator?: "check" | "switch";
}

export function MenuCheckboxItem({ shortcut, indicator = "check", checked, className, children, ...rest }: MenuCheckboxItemProps) {
	return (
		<DM.CheckboxItem checked={checked} className={cn(menuItem, className)} {...rest}>
			{indicator === "check" && (
				<span className={menuCheckSlot}>
					<DM.ItemIndicator>
						<Check className="size-4" aria-hidden />
					</DM.ItemIndicator>
				</span>
			)}
			<ItemBody shortcut={shortcut}>{children}</ItemBody>
			{indicator === "switch" && <SwitchIndicator checked={checked === true} />}
		</DM.CheckboxItem>
	);
}

export const MenuRadioGroup = DM.RadioGroup;

export interface MenuRadioItemProps extends ComponentPropsWithRef<typeof DM.RadioItem> {
	shortcut?: string;
	/** Second line under the label in muted 12px, such as what a permission level allows. */
	description?: ReactNode;
}

/** Single-choice row: the chosen one shows a leading check. */
export function MenuRadioItem({ shortcut, description, className, children, ...rest }: MenuRadioItemProps) {
	return (
		<DM.RadioItem className={cn(menuItem, description ? menuItemDescribed : undefined, className)} {...rest}>
			<span className={menuCheckSlot}>
				<DM.ItemIndicator>
					<Check className="size-4" aria-hidden />
				</DM.ItemIndicator>
			</span>
			<ChoiceBody shortcut={shortcut} description={description}>
				{children}
			</ChoiceBody>
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
				<CaretRight className="ml-auto size-3.5 text-fg-faint" aria-hidden />
			</DM.SubTrigger>
			<DM.Portal>
				<DM.SubContent sideOffset={6} alignOffset={-7} collisionPadding={8} className={cn(contentClass, contentClassName)}>
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
			<span className={menuCheckSlot}>
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
	description?: ReactNode;
}

export function ContextMenuRadioItem({ shortcut, description, className, children, ...rest }: ContextMenuRadioItemProps) {
	return (
		<CM.RadioItem className={cn(menuItem, description ? menuItemDescribed : undefined, className)} {...rest}>
			<span className={menuCheckSlot}>
				<CM.ItemIndicator>
					<Check className="size-4" aria-hidden />
				</CM.ItemIndicator>
			</span>
			<ChoiceBody shortcut={shortcut} description={description}>
				{children}
			</ChoiceBody>
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
				<CaretRight className="ml-auto size-3.5 text-fg-faint" aria-hidden />
			</CM.SubTrigger>
			<CM.Portal>
				<CM.SubContent sideOffset={6} alignOffset={-7} collisionPadding={8} className={cn(contentClass, contentClassName)}>
					{children}
				</CM.SubContent>
			</CM.Portal>
		</CM.Sub>
	);
}
