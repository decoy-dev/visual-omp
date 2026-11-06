import { Plus, Trash } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useState } from "react";
import { useOmpSettings } from "@/features/manage/settings/useOmpSettings";
import { useDeferredTranslation } from "@/i18n";
import { Button, IconButton, Input, Notice, SectionHeader, Skeleton } from "@/ui";
import { useIpcEvent } from "../shared";

const KEY = "skills.manualSkills";

/** omp owns pattern matching and the resulting hide flag. This editor only stores its glob list. */
export function ManualSkills() {
	const { t } = useDeferredTranslation("context");
	const omp = useOmpSettings(null, "global");
	const [pattern, setPattern] = useState("");
	const [busy, setBusy] = useState(false);
	useIpcEvent("config:changed", event => {
		if (event.scope === "global") void omp.snapshot.reload();
	});
	useEffect(() => {
		void window.vomp.invoke("config:watch");
		return () => { void window.vomp.invoke("config:unwatch"); };
	}, []);
	const setting = omp.byKey.get(KEY);
	const own = setting?.globalValue ?? setting?.defaultValue;
	const patterns = Array.isArray(own) ? own.filter((value): value is string => typeof value === "string") : [];
	const nextPattern = pattern.trim();
	const save = async (next: string[]) => {
		setBusy(true);
		try { return await omp.write(KEY, next); }
		finally { setBusy(false); }
	};
	const add = async (event: FormEvent) => {
		event.preventDefault();
		if (!nextPattern || patterns.includes(nextPattern) || busy) return;
		if (await save([...patterns, nextPattern])) setPattern("");
	};
	return (
		<section className="mt-4" aria-labelledby="manual-skills-title">
			<SectionHeader id="manual-skills-title" title={t("skills.manual.title")} description={t("skills.manual.help")} />
			{omp.snapshot.error ? (
				<Notice tone="err" actions={<Button size="sm" onClick={() => void omp.snapshot.reload()}>{t("common.retry")}</Button>}>{omp.snapshot.error}</Notice>
			) : !omp.snapshot.data ? <Skeleton height={56} /> : !setting ? (
				<p className="text-sm text-fg-muted">{t("skills.manual.unavailable")}</p>
			) : <>
				{patterns.length > 0 ? (
					<ul className="divide-y divide-border border-y border-border" aria-label={t("skills.manual.title")}>
						{patterns.map(value => <li key={value} className="flex items-center gap-3 py-2">
							<code className="min-w-0 flex-1 break-all text-sm">{value}</code>
							<IconButton size="sm" icon={<Trash />} label={t("skills.manual.remove", { pattern: value })} disabled={busy} onClick={() => void save(patterns.filter(item => item !== value))} />
						</li>)}
					</ul>
				) : <p className="text-sm text-fg-muted">{t("skills.manual.empty")}</p>}
				<form onSubmit={event => void add(event)} className="mt-3 flex flex-wrap items-end gap-2">
					<Input label={t("skills.manual.pattern")} value={pattern} onChange={event => setPattern(event.target.value)} placeholder="docs-*" spellCheck={false} disabled={busy} className="min-w-40 flex-1" />
					<Button type="submit" icon={<Plus />} disabled={busy || !nextPattern || patterns.includes(nextPattern)} loading={busy}>{t("skills.manual.add")}</Button>
				</form>
				{JSON.stringify(setting.value) !== JSON.stringify(own) && <Notice tone="info" className="mt-3">{t("skills.manual.overridden")} <code className="break-all">{JSON.stringify(setting.value)}</code></Notice>}
				<p className="mt-2 text-sm text-fg-muted">{t("skills.manual.scope")}</p>
			</>}
		</section>
	);
}
