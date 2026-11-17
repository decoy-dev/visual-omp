import { useState } from "react";
import { useDeferredTranslation } from "@/i18n";
import { Button, Input } from "@/ui";
import { parseTokenPoint } from "../manage/roles/compactionModel";

/** "400k" for whole thousands, else the plain count: the form the field accepts back. */
function inputText(tokens: number | null): string {
	if (tokens === null) return "";
	return tokens % 1_000 === 0 ? `${tokens / 1_000}k` : String(tokens);
}

/**
 * A token count for omp's fixed compaction point, with Save and, while a point is set, Use default. `onSave`
 * resolves false when the point was not saved; null restores the inherited point. `destination` names where the
 * point goes (a chat session, or a settings scope); a draft never carries over to another destination.
 */
export function CompactAtField({ label, destination, value, placeholder, description, disabled = false, size = "md", onSave }: {
	label: string;
	destination: string;
	value: number | null;
	placeholder: string;
	description?: string;
	disabled?: boolean;
	size?: "sm" | "md";
	onSave(tokens: number | null): Promise<boolean>;
}) {
	const { t } = useDeferredTranslation("settings");
	const stored = inputText(value);
	const [input, setInput] = useState(stored);
	const [saved, setSaved] = useState(stored);
	const [target, setTarget] = useState(destination);
	const [busy, setBusy] = useState<"save" | "reset" | null>(null);
	if (target !== destination) { setTarget(destination); setInput(stored); setSaved(stored); }
	// A new value from omp or the chat refreshes an untouched draft without overwriting edits.
	else if (saved !== stored && input === saved) { setInput(stored); setSaved(stored); }
	const parsed = parseTokenPoint(input);
	const dirty = input.trim() !== saved;
	const save = async (tokens: number | null, action: "save" | "reset") => {
		if (disabled || busy !== null) return;
		setBusy(action);
		try {
			if (await onSave(tokens)) {
				const text = inputText(tokens);
				setInput(text);
				setSaved(text);
			}
		} finally { setBusy(null); }
	};
	return (
		<form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); if (parsed.ok && dirty) void save(parsed.tokens, "save"); }}>
			<Input
				className="min-w-0 flex-1"
				size={size}
				label={label}
				description={description}
				placeholder={placeholder}
				spellCheck={false}
				inputMode="text"
				value={input}
				disabled={disabled || busy !== null}
				onChange={event => setInput(event.currentTarget.value)}
				error={parsed.ok ? undefined : t("compactAt.invalid")}
			/>
			<Button type="submit" size={size} disabled={disabled || !dirty || !parsed.ok} loading={busy === "save"}>{t("compactAt.save")}</Button>
			{value !== null && <Button size={size} variant="ghost" disabled={disabled || busy !== null} loading={busy === "reset"} onClick={() => void save(null, "reset")}>{t("compactAt.reset")}</Button>}
		</form>
	);
}
