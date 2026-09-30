import { CaretDown, FolderSimple } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ChatSlotProps } from "@/registry/slots";
import { useSessionView } from "@/shell/hooks";
import { canRetarget } from "@/state/app";
import { Tooltip } from "@/ui";
import { chooseFolder } from "../actions";
import { folderName } from "../format";

/**
 * Composer chip naming the folder a new chat runs in ("visual-omp ▾"). It opens the folder chooser,
 * which moves the chat; the chip goes away once the first message is sent and the folder is fixed.
 */
export function FolderChip({ session }: ChatSlotProps): ReactNode {
	const { t } = useTranslation("projects");
	// Subscribes to the session so the chip hides as soon as a message goes out.
	const view = useSessionView(session);
	if (!view || !canRetarget(session)) return null;
	const name = folderName(session.projectPath);
	return (
		<Tooltip content={t("chip.tip", { path: session.projectPath })}>
			<button
				type="button"
				aria-haspopup="dialog"
				aria-label={t("chip.label", { name })}
				onClick={() => chooseFolder({ tabId: session.tabId })}
				className="inline-flex h-7 max-w-52 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-fg-muted outline-none hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
			>
				<FolderSimple className="size-3.5 shrink-0" aria-hidden />
				<span className="truncate">{name}</span>
				<CaretDown className="size-3 shrink-0" aria-hidden />
			</button>
		</Tooltip>
	);
}
