import type { AgentDirs, AgentWritableScope } from "@shared/contracts/agents";
import { Sparkles } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dialog, DialogContent, Segmented, Textarea } from "@/ui";

export function CreateWithAiDialog({
	open,
	onOpenChange,
	cwd,
	dirs,
	onCreate,
}: {
	open: boolean;
	onOpenChange(open: boolean): void;
	cwd: string | null;
	dirs: AgentDirs | null;
	/** Starts the chat that writes the file. */
	onCreate(description: string, dir: string, scope: AgentWritableScope): Promise<void>;
}) {
	const { t } = useTranslation("manage");
	const [description, setDescription] = useState("");
	const [scope, setScope] = useState<AgentWritableScope>("user");
	const [busy, setBusy] = useState(false);
	const dir = scope === "user" ? dirs?.user : (dirs?.project ?? dirs?.projectDefault);
	const ready = description.trim().length >= 8 && Boolean(dir) && Boolean(cwd);

	const submit = async () => {
		if (!ready || !dir) return;
		setBusy(true);
		try {
			await onCreate(description, dir, scope);
			setDescription("");
			onOpenChange(false);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				size="lg"
				title={t("agents.ai.title")}
				description={t("agents.ai.body")}
				footer={
					<>
						<Button variant="ghost" onClick={() => onOpenChange(false)}>
							{t("common.cancel")}
						</Button>
						<Button variant="primary" icon={<Sparkles />} disabled={!ready} loading={busy} onClick={() => void submit()}>
							{t("agents.ai.create")}
						</Button>
					</>
				}
			>
				<div className="space-y-4">
					<Textarea
						autoFocus
						label={t("agents.ai.label")}
						placeholder={t("agents.ai.placeholder")}
						value={description}
						onChange={event => setDescription(event.currentTarget.value)}
						onKeyDown={event => {
							if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
								event.preventDefault();
								void submit();
							}
						}}
						minRows={4}
						maxRows={10}
					/>
					<div className="flex items-center justify-between gap-4">
						<span className="text-md text-fg">{t("agents.editor.scope")}</span>
						<Segmented
							aria-label={t("agents.editor.scope")}
							value={scope}
							onValueChange={setScope}
							options={[
								{ value: "user", label: t("agents.scope.user") },
								{ value: "project", label: t("agents.scope.project"), disabled: !cwd },
							]}
						/>
					</div>
					<p className="text-sm text-fg-muted">{cwd ? t("agents.ai.how") : t("agents.ai.needsProject")}</p>
				</div>
			</DialogContent>
		</Dialog>
	);
}
