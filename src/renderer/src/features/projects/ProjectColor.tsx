/** Project folder color swatches (DESIGN §3.2): the dot menus show beside each color, and the picker in the new project wizard. */
import { type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";
import { PROJECT_COLORS, type ProjectColor, projectColorValue } from "@/state/projectColors";
import { cn } from "@/ui";

/** A round 12px swatch of `color` with a hairline edge, beside a color's name in menus; null draws the empty ring that stands for no color. */
export function ProjectColorDot({ color }: { color: ProjectColor | null }): ReactNode {
	return (
		<span
			aria-hidden
			className="inline-block size-3 shrink-0 rounded-full shadow-[inset_0_0_0_1px_var(--border-strong)]"
			style={color ? { background: projectColorValue(color) } : undefined}
		/>
	);
}

/** "None" and the seven colors, in menu order. */
export const PROJECT_COLOR_CHOICES: readonly (ProjectColor | null)[] = [null, ...PROJECT_COLORS];

/**
 * Native radio group of swatches, named for screen readers and in a tooltip, with the chosen name beside them. The
 * swatches are the visible controls, so they take the control border (3:1), which also outlines "None".
 */
export function ProjectColorPicker({ value, onChange }: { value: ProjectColor | null; onChange(color: ProjectColor | null): void }): ReactNode {
	const { t } = useTranslation("projects");
	const name = useId();
	const label = (color: ProjectColor | null) => t(color ? `color.${color}` : "color.none");
	return (
		<fieldset className="m-0 border-0 p-0">
			<legend className="mb-2 p-0 text-md font-medium text-fg">{t("color.label")}</legend>
			{/* `pb-1` keeps the 4px selection and focus outlines inside the dialog's scrolling body, which clips at its edge. */}
			<div className="flex flex-wrap items-center gap-3 pb-1">
				{PROJECT_COLOR_CHOICES.map(color => {
					const checked = value === color;
					return (
						<label
							key={color ?? "none"}
							title={label(color)}
							className={cn(
								"flex size-6 cursor-pointer rounded-full border border-control outline-offset-2",
								checked && "outline-2 outline-fg",
								"has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring",
							)}
						>
							<input type="radio" name={name} className="sr-only" checked={checked} onChange={() => onChange(color)} />
							<span className="sr-only">{label(color)}</span>
							<span aria-hidden className="flex-1 rounded-full" style={color ? { background: projectColorValue(color) } : undefined} />
						</label>
					);
				})}
				<span className="text-sm text-fg-muted" aria-hidden>
					{label(value)}
				</span>
			</div>
		</fieldset>
	);
}
