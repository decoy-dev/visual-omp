import type { PreviewGrant } from "@shared/contracts/preview";
import { useEffect, useRef, useState } from "react";
import type { LiveFrameProps } from "../types";

interface GrantedFrame {
	grant: PreviewGrant;
	revision: number;
}

/** Own one token and publish a revision only after main can serve its complete current contents. */
export function usePreviewGrant({ subject, projectPath, related }: LiveFrameProps): { grant: PreviewGrant | null; frame: GrantedFrame | null; error: boolean } {
	const [grant, setGrant] = useState<PreviewGrant | null>(null);
	const [frame, setFrame] = useState<GrantedFrame | null>(null);
	const [error, setError] = useState(false);
	const sent = useRef({ token: "", at: -Infinity, saved: false });
	const relatedKey = JSON.stringify(related);
	const path = subject.path;
	useEffect(() => {
		let live = true;
		let token: string | null = null;
		setGrant(null);
		setFrame(null);
		setError(false);
		if (path) void window.vomp.invoke("preview:grant", { path, root: projectPath, related: JSON.parse(relatedKey) as string[] }).then(value => {
			token = value.token;
			if (live) {
				sent.current = { token, at: -Infinity, saved: false };
				setGrant(value);
			} else void window.vomp.invoke("preview:revoke", token).catch(() => {});
		}).catch(() => { if (live) setError(true); });
		return () => {
			live = false;
			if (token) void window.vomp.invoke("preview:revoke", token).catch(() => {});
		};
	}, [path, projectPath, relatedKey]);
	useEffect(() => {
		if (!grant || sent.current.token !== grant.token) return;
		let live = true;
		const saved = subject.kind === "file" || subject.state === "saved";
		const publish = async () => {
			try {
				if (saved && !sent.current.saved) {
					sent.current.saved = true;
					await window.vomp.invoke("preview:saved", grant.token);
				} else if (!saved && subject.text !== null && !subject.elided) {
					sent.current.at = Date.now();
					await window.vomp.invoke("preview:live", grant.token, subject.revision, subject.text);
				}
				if (subject.format === "html") {
					const result = await window.vomp.invoke("preview:prepare", grant.token, subject.revision);
					if (!result.ok) { if (live) setError(true); return; }
				}
				if (live) { setFrame({ grant, revision: subject.revision }); setError(false); }
			} catch { if (live) setError(true); }
		};
		const delay = saved || subject.text === null ? 0 : Math.max(0, 250 - (Date.now() - sent.current.at));
		const timer = setTimeout(() => { void publish(); }, delay);
		return () => { live = false; clearTimeout(timer); };
	}, [grant, subject.kind, subject.format, subject.state, subject.text, subject.elided, subject.revision]);
	return { grant, frame, error };
}
