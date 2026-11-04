import { useEffect, useState } from "react";

let homeDir: Promise<string> | null = null;

/** The user's home folder (cached for the session). Null until main answers. */
export function useHomeDir(): string | null {
	const [home, setHome] = useState<string | null>(null);
	useEffect(() => {
		homeDir ??= window.vomp.invoke("app:info").then(info => info.homeDir);
		let live = true;
		void homeDir.then(value => live && setHome(value));
		return () => {
			live = false;
		};
	}, []);
	return home;
}
