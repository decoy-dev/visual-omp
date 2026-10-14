import { Folder, Globe } from "@phosphor-icons/react";
import { Segmented } from "./Segmented";

export type Scope = "global" | "project";

export interface ScopeSwitchProps {
	/** The scope being edited. The owner normalizes it: "project" only while a project is open. */
	value: Scope;
	onValueChange(scope: Scope): void;
	/** "All projects". */
	allLabel: string;
	/** "Project: my-shop", or "This project" when none is open. Long names truncate; the full text is the tooltip. */
	projectLabel: string;
	/** No project is open, so the project side cannot be chosen. */
	projectDisabled?: boolean;
	/** Accessible name, such as "Where these settings apply". */
	label: string;
	className?: string;
}

/**
 * Which layer a page edits: all projects, or the open project. Settings pages put it in the page
 * header's meta line so the scope is read before any field.
 */
export function ScopeSwitch({ value, onValueChange, allLabel, projectLabel, projectDisabled, label, className }: ScopeSwitchProps) {
	return (
		<Segmented<Scope>
			size="sm"
			aria-label={label}
			value={value}
			onValueChange={onValueChange}
			className={className}
			options={[
				{ value: "global", label: allLabel, icon: <Globe aria-hidden /> },
				{
					value: "project",
					label: (
						<span className="block max-w-[28ch] truncate" title={projectLabel}>
							{projectLabel}
						</span>
					),
					ariaLabel: projectLabel,
					icon: <Folder aria-hidden />,
					disabled: projectDisabled,
				},
			]}
		/>
	);
}
