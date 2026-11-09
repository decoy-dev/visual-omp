import type { PreviewGrant } from "@shared/contracts/preview";
import { useEffect, useState } from "react";

/** A view owns its grant, including a grant returned after that view has already closed. */
export interface FileSource { src: string; release(): void }

export function isSvgSource(src: string): boolean {
	if (src.startsWith("data:image/svg+xml")) return true;
	try { return new URL(src).pathname.toLowerCase().endsWith(".svg"); } catch { return false; }
}
export async function grantFileSource(path: string, revision = 0): Promise<FileSource> {
	const grant = await window.vomp.invoke("preview:grant", { path, root: null, related: [], fileOnly: true });
	const source = sourceForGrant(grant);
	if (/\.pdf$/i.test(path)) {
		try {
			const checked = await window.vomp.invoke("preview:prepare", grant.token, revision);
			if (!checked.ok) throw new Error("The PDF could not be read.");
			source.src += `?rev=${revision}`;
		} catch (error) { source.release(); throw error; }
	}
	return source;
}

export function sourceForGrant(grant: PreviewGrant): FileSource {
	let released = false;
	return { src: grant.url, release: () => {
		if (released) return;
		released = true;
		void window.vomp.invoke("preview:revoke", grant.token).catch(() => {});
	} };
}

export function useFileSource(path: string | null, revision = 0): { src: string | null; error: boolean } {
	const [state, setState] = useState<{ path: string; revision: number; src: string | null; error: boolean } | null>(null);
	useEffect(() => {
		if (!path) return;
		let live = true;
		let source: FileSource | null = null;
		void grantFileSource(path, revision).then(value => {
			source = value;
			if (live) setState({ path, revision, src: value.src, error: false });
			else value.release();
		}).catch(() => { if (live) setState({ path, revision, src: null, error: true }); });
		return () => { live = false; source?.release(); };
	}, [path, revision]);
	return state?.path === path && state.revision === revision ? state : { src: null, error: false };
}
