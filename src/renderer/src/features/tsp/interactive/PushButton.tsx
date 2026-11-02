import type { TspButtonProps, TspNode } from "@shared/tsp";
import { isKnownAction } from "@shared/tsp/roles";
import { ArrowClockwise, ArrowSquareOut, Check, Copy, Info, Play, Plus, Trash, Warning, X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { Button, IconButton, type ButtonVariant } from "../../../ui/Button";
import { Spinner } from "../../../ui/Spinner";
import { cn } from "../../../ui/cn";
import { KeyCombinations } from "../nodes/Table";
import type { NodeContext } from "../nodes/context";
import { shortcutKeyName } from "../shortcuts";

const variants: Record<NonNullable<TspButtonProps["variant"]>, ButtonVariant> = {
	default: "secondary", primary: "primary", quiet: "ghost", danger: "danger",
};
function buttonIcon(name: string) {
	const Icon = /close|cancel|^x$/.test(name) ? X : /refresh|reload/.test(name) ? ArrowClockwise : /copy/.test(name) ? Copy
		: /trash|delete/.test(name) ? Trash : /play|run/.test(name) ? Play : /check|done/.test(name) ? Check
		: /plus|add/.test(name) ? Plus : /open|external/.test(name) ? ArrowSquareOut : /warn|error/.test(name) ? Warning : Info;
	return <Icon aria-hidden className="size-4 shrink-0" />;
}
export function PushButton({ node, context }: { node: Extract<TspNode, { k: "button" }>; context: NodeContext }) {
	const { t } = useTranslation("palette");
	const p = node.p;
	const action = p?.actions?.click ?? "click";
	const unknown = !isKnownAction(action);
	const empty = !p?.text && !p?.icon && !p?.keys?.length;
	const disabled = context.readOnly || empty || p?.disabled === true || typeof p?.disabled === "string" || !!p?.busy || unknown;
	const label = p?.aria || p?.text || p?.title || p?.icon || p?.keys?.map(key => shortcutKeyName(key, window.vomp.platform)).join(" + ") || t("tsp.unavailableAction");
	const title = typeof p?.disabled === "string" ? p.disabled : unknown ? t("tsp.unsupportedAction", { action }) : p?.title;
	const icon = p?.busy ? <Spinner size={14} tone="current" /> : p?.icon ? buttonIcon(p.icon) : undefined;
	const onClick = () => { if (!disabled) context.send({ ev: "action", sf: context.sf, id: node.id, act: action }); };
	const className = cn("max-w-full", p?.on && "bg-selected text-fg");
	// Key-only close buttons retain their visible keycaps and accessible name.
	if (!p?.text && p?.icon && !p.keys?.length) return <IconButton label={label} tooltip={title} title={title} icon={icon} size={p.size ?? "md"}
		variant={p.variant === "quiet" ? "ghost" : p.variant === "danger" ? "danger-ghost" : "secondary"}
		className={cn(className, p.variant === "primary" && "border-transparent bg-accent text-accent-fg enabled:hover:bg-accent-hover", p.variant === "danger" && "bg-err text-fg-inverse enabled:hover:bg-err-hover")}
		pressed={p.on} disabled={disabled} aria-busy={p.busy || undefined} onClick={onClick} />;
	return <Button variant={variants[p?.variant ?? "default"]} size={p?.size ?? "md"} className={cn(className, "h-auto! whitespace-normal! py-1 [&>span]:min-w-0 [&>span]:max-w-full [&>span]:flex-wrap [&>span]:justify-center", p?.size === "sm" ? "min-h-7" : "min-h-8")} icon={icon}
		aria-label={p?.aria ?? (!p?.text ? label : undefined)} aria-pressed={p?.on} aria-busy={p?.busy || undefined} disabled={disabled} title={title} onClick={onClick}>
		<span className="min-w-0 [overflow-wrap:anywhere]">{p?.text || (empty ? label : null)}</span>{p?.keys?.length ? <span className="min-w-0 max-w-full [&_.tsp-key-chord]:max-w-full [&_.tsp-key-chord]:flex-wrap [&_kbd]:max-w-full [&_kbd]:whitespace-normal [&_kbd]:break-words"><KeyCombinations value={[{ t: p.keys.join("+"), s: "key" }]} /></span> : null}
	</Button>;
}
