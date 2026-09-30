import { IconContext, type IconProps } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useState } from "react";
import { globals, screens } from "./registry/slots";
import { Shell } from "./shell/Shell";
import { useApp } from "./state/app";
import { MotionProvider, Toaster, TooltipProvider } from "./ui";

/** Phosphor defaults: size follows the text (callers size with `size-*` classes), regular weight, inherited color. */
const iconDefaults: IconProps = { size: "1em", weight: "regular", color: "currentColor", mirrored: false };

/** Applies theme, text size and motion preferences to <html> so tokens and rem sizes follow them. */
function usePreferenceAttributes(): void {
	const prefs = useApp(state => state.prefs);
	const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
	useEffect(() => {
		const query = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, []);
	useEffect(() => {
		const html = document.documentElement;
		const theme = prefs?.theme ?? "light";
		html.dataset.theme = theme === "system" ? (systemDark ? "dark" : "light") : theme;
		html.style.fontSize = `${prefs?.textScale ?? 100}%`;
		const motion = prefs?.reducedMotion ?? "system";
		if (motion === "system") delete html.dataset.motion;
		else html.dataset.motion = motion === "on" ? "reduced" : "full";
	}, [prefs, systemDark]);
}

export function App(): ReactNode {
	const omp = useApp(state => state.omp);
	const activeProject = useApp(state => state.activeProject);
	const screenList = screens.use();
	const globalList = globals.use();
	usePreferenceAttributes();

	useEffect(() => {
		void useApp.getState().init();
	}, []);

	const setup = screenList.find(screen => screen.id === "setup");
	const needsSetup = omp !== null && (!omp.found || !omp.supported);

	return (
		<IconContext.Provider value={iconDefaults}>
			<MotionProvider>
				<TooltipProvider>
					{needsSetup && setup ? <setup.component projectPath={activeProject} /> : <Shell />}
					{globalList.map(global => (
						<global.component key={global.id} />
					))}
					<Toaster />
				</TooltipProvider>
			</MotionProvider>
		</IconContext.Provider>
	);
}
