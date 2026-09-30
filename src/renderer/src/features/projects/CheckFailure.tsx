import { WarningCircle } from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
import { Expand } from "@/ui";

/**
 * Message shown when a live check (name, link) could not run at all. Inserted with `role="alert"`,
 * which screen readers announce on insertion. It expands in and collapses away, keeping the last
 * message on screen while it closes.
 */
export function CheckFailure({ message }: { message: string | null }): ReactNode {
	const [shown, setShown] = useState(message);
	if (message && message !== shown) setShown(message);
	return (
		<Expand open={Boolean(message)}>
			<p role="alert" className="flex items-start gap-1.5 text-sm text-err">
				<WarningCircle className="mt-px size-4 shrink-0" aria-hidden />
				<span className="min-w-0 break-words">{shown}</span>
			</p>
		</Expand>
	);
}
