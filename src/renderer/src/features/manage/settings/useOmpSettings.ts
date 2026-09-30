import type { ConfigSnapshot, JsonValue, SettingInfo, SettingScope, SettingSource, SettingWriteResult } from "@shared/contracts/config";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "@/ui";
import { ipcErrorMessage, type Resource, useResource } from "../shared";

export interface OmpSettings {
	cwd: string | null;
	scope: SettingScope;
	snapshot: Resource<ConfigSnapshot>;
	byKey: ReadonlyMap<string, SettingInfo>;
	/** Writes into the selected scope; resolves false (after a toast) when omp refused it. */
	write(key: string, value: JsonValue): Promise<boolean>;
	/** Removes the key from the selected scope's file. */
	reset(key: string): Promise<boolean>;
	/** Toast for a write that a higher layer still overrides. */
	reportShadow(shadowedBy: SettingSource | "other" | null): void;
	/** Toast for a failed write, with omp's reason. */
	reportError(error: unknown): void;
}

export function useOmpSettings(cwd: string | null, scope: SettingScope): OmpSettings {
	const { t } = useTranslation("manage");
	const snapshot = useResource(() => window.vomp.invoke("config:list", cwd ?? undefined), [cwd]);
	const byKey = useMemo(() => new Map((snapshot.data?.settings ?? []).map(setting => [setting.key, setting])), [snapshot.data]);

	const reportShadow = useCallback(
		(shadowedBy: SettingSource | "other" | null) => {
			if (!shadowedBy) return;
			toast({ tone: "warn", message: t("settings.saved"), description: t(`settings.shadowed.${shadowedBy}`) });
		},
		[t],
	);
	const reportError = useCallback(
		(error: unknown) => toast({ tone: "err", message: t("settings.saveFailed", { reason: ipcErrorMessage(error) }) }),
		[t],
	);

	const { setData } = snapshot;
	const apply = useCallback(
		async (run: () => Promise<SettingWriteResult>) => {
			try {
				const result = await run();
				setData(prev =>
					prev && {
						...prev,
						settings: prev.settings.map(setting => (setting.key === result.setting.key ? result.setting : setting)),
					},
				);
				reportShadow(result.shadowedBy);
				return true;
			} catch (error) {
				reportError(error);
				return false;
			}
		},
		[setData, reportShadow, reportError],
	);
	const target = scope === "project" && cwd ? "project" : "global";
	const write = useCallback(
		(key: string, value: JsonValue) => apply(() => window.vomp.invoke("config:set", key, value, target, cwd ?? undefined)),
		[apply, target, cwd],
	);
	const reset = useCallback(
		(key: string) => apply(() => window.vomp.invoke("config:reset", key, target, cwd ?? undefined)),
		[apply, target, cwd],
	);

	return { cwd, scope: target, snapshot, byKey, write, reset, reportShadow, reportError };
}
