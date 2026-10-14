/** "Discard changes?" for navigation away from a page with unsaved edits (`state/leaveGuard.ts`). */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { resolveLeave, useLeaveConfirm } from "../state/leaveGuard";
import { Button, Dialog, DialogContent } from "../ui";

export function LeaveConfirm(): ReactNode {
	const { t } = useTranslation("shell");
	const open = useLeaveConfirm(state => state.pending !== null);
	return (
		<Dialog open={open} onOpenChange={next => !next && resolveLeave(false)}>
			<DialogContent
				size="sm"
				destructive
				title={t("leave.title")}
				description={t("leave.body")}
				footer={
					<>
						<Button onClick={() => resolveLeave(false)}>{t("leave.keep")}</Button>
						<Button variant="danger" onClick={() => resolveLeave(true)}>
							{t("leave.discard")}
						</Button>
					</>
				}
			/>
		</Dialog>
	);
}
